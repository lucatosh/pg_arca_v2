"""A whole-server restore that REPAIRS production: the server itself goes back to the chosen point (not a copy next to it). Rebuilt next to PGDATA,
stop -> swap -> start -> recovery -> primary, same port, previous data directory kept; production DOWN with WAL it never archived; failure -> rollback.
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_replace_pg -v'
"""
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from tests.test_engine_pg import F, q, sh
from pg_arca.engine import replace
from pg_arca.engine.backup import run_backup
from pg_arca.engine.util import EngineError
from pg_arca.executor import OperationExecutor

X = T.Fx()


class _NoPatroni(object):
    configured = False


class _Patroni(object):
    configured = True


def wait_archived():
    last = q("postgres", "SELECT pg_walfile_name(pg_switch_wal() - 1)")[0][0]
    for _ in range(90):
        if (q("postgres", "SELECT COALESCE(last_archived_wal, '') FROM pg_stat_archiver")[0][0] or "") >= last:
            return
        time.sleep(1)
    raise AssertionError("WAL not archived")


def now():
    return q("postgres", "SELECT to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]


def setUpModule():
    T.setUpModule()
    F.ctx.conn.bindir = T.BIN
    q("postgres", "CREATE DATABASE shop")
    q("shop", "CREATE TABLE orders (id serial PRIMARY KEY, tag text); INSERT INTO orders (tag) SELECT 'A' FROM generate_series(1, 100)")
    run_backup(F.ctx, "full")
    q("shop", "INSERT INTO orders (tag) SELECT 'B' FROM generate_series(1, 40)")
    time.sleep(1.5)
    X.t = now()
    time.sleep(1.5)
    q("shop", "DELETE FROM orders WHERE tag = 'A'")            # the mistake production must be repaired from
    wait_archived()
    X.state = os.path.join(F.base, "state")
    X.ex = OperationExecutor({"state_dir": X.state, "log_dir": F.base}, None, _NoPatroni())
    X.ex._ctx_ro = lambda: F.ctx


def tearDownModule():
    T.tearDownModule()


def tags():
    return dict((r[0], int(r[1])) for r in q("shop", "SELECT tag, count(*) FROM orders GROUP BY 1 ORDER BY 1"))


class Replace(unittest.TestCase):
    def test_01_plan_says_how_production_is_replaced(self):
        plan = X.ex.h_restore_plan({"scope": "instance", "replace_production": True, "target_time": X.t})
        r = plan["replace"]
        self.assertEqual(r["method"], "pg_ctl", r)
        self.assertTrue(r["was_running"])
        self.assertEqual(r["data_directory"], os.path.realpath(F.src))
        self.assertFalse(r["carry_unarchived_wal"], "a point in time: the archive is enough")
        self.assertTrue(plan["destination"].startswith(os.path.realpath(F.src) + ".pgarca-new-"), plan["destination"])
        self.assertFalse(os.path.exists(plan["destination"]), "a plan writes nothing")
        self.assertNotIn("start_hint", plan)

    def test_02_refusals(self):
        with self.assertRaises(EngineError) as c:
            X.ex.h_restore_instance({"replace_production": True, "target_time": X.t})
        self.assertEqual(c.exception.code, "PGA-RST-085")
        ex = OperationExecutor({"state_dir": X.state}, None, _Patroni())
        ex._ctx_ro = lambda: F.ctx
        with self.assertRaises(EngineError) as c:
            ex.h_restore_instance({"replace_production": True, "target_time": X.t, "confirm": "SOSTITUISCI"})
        self.assertEqual(c.exception.code, "PGA-RST-081")
        with self.assertRaises(EngineError):
            replace.drop_kept(F.src, "/tmp")
        with self.assertRaises(EngineError):
            replace.drop_kept(F.src, F.src)
        self.assertEqual(tags(), {"B": 40}, "nothing touched")

    def test_03_failure_puts_the_original_back_and_running(self):
        real = replace.wait_primary
        replace.wait_primary = lambda *a, **k: None               # the restored server "never comes up"
        try:
            with self.assertRaises(EngineError) as c:
                X.ex.h_restore_instance({"replace_production": True, "target_time": X.t, "confirm": "SOSTITUISCI"})
        finally:
            replace.wait_primary = real
        self.assertEqual(c.exception.code, "PGA-RST-076")
        self.assertIn("back in place and started", c.exception.hint or "")
        self.assertEqual(tags(), {"B": 40}, "the original data directory is back and answering")
        kinds = sorted(k["kind"] for k in replace.kept(F.src))
        self.assertEqual(kinds, ["failed"], replace.kept(F.src))
        for k in replace.kept(F.src):
            replace.drop_kept(F.src, k["path"])
        self.assertEqual(replace.kept(F.src), [])

    def test_04_point_in_time_replaces_production_in_place(self):
        port_before = q("postgres", "SHOW port")[0][0]
        res = X.ex.h_restore_instance({"replace_production": True, "target_time": X.t, "confirm": "SOSTITUISCI"})
        r = res["replace"]
        self.assertTrue(r["replaced"], r)
        self.assertEqual(tags(), {"A": 100, "B": 40}, "production is back at the chosen point: the deleted rows are there again")
        self.assertEqual(q("postgres", "SHOW port")[0][0], port_before)
        self.assertEqual(q("postgres", "SELECT pg_is_in_recovery()")[0][0], "f")
        q("shop", "INSERT INTO orders (tag) SELECT 'N' FROM generate_series(1, 3)")       # read-write again
        self.assertTrue(os.path.isdir(r["old_kept_as"]) and r["old_kept_as"].startswith(os.path.realpath(F.src) + ".pgarca-before-"))
        self.assertFalse(os.path.exists(os.path.join(F.src, "recovery.signal")))
        with open(os.path.join(F.src, "postgresql.auto.conf")) as f:
            auto = f.read()
        self.assertNotIn("\nrecovery_target_time", auto, "the restore's target does not follow the server into its next backups")
        self.assertNotIn("archive_mode = 'off'", auto, "production keeps archiving")
        tli = int(q("postgres", "SELECT timeline_id FROM pg_control_checkpoint()")[0][0])
        wait_archived()
        self.assertTrue(os.listdir(F.wal))
        X.kept1 = r["old_kept_as"]
        self.assertGreaterEqual(tli, 1)

    def test_05_latest_with_production_down_keeps_unarchived_wal(self):
        run_backup(F.ctx, "full")                                    # new timeline: a new chain
        q("postgres", "ALTER SYSTEM SET archive_command = 'false'")
        q("postgres", "SELECT pg_reload_conf()")
        time.sleep(1)
        q("shop", "INSERT INTO orders (tag) SELECT 'D' FROM generate_series(1, 11)")     # committed, never archived
        q("postgres", "CHECKPOINT")
        r = sh(os.path.join(T.BIN, "pg_ctl"), "-D", F.src, "-m", "immediate", "stop")    # production crashes
        self.assertEqual(r.returncode, 0, r.stderr)
        res = X.ex.h_restore_instance({"replace_production": True, "confirm": "SOSTITUISCI"})
        rp = res["replace"]
        self.assertFalse(rp["was_running"])
        self.assertTrue(rp["carry_unarchived_wal"])
        self.assertTrue(any("not archived" in s for s in rp["steps"]), rp["steps"])
        got = tags()
        self.assertEqual(got.get("D"), 11, "the committed rows production never archived are not lost: %s" % got)
        self.assertEqual(got.get("N"), 3)
        self.assertEqual(q("postgres", "SELECT pg_is_in_recovery()")[0][0], "f")
        self.assertEqual(q("postgres", "SHOW archive_command")[0][0].startswith("env "), True, "the backup's settings (archiving works again)")
        kinds = sorted(k["kind"] for k in replace.kept(F.src))
        self.assertEqual(kinds, ["before", "before"])

    def test_06_kept_directories_are_given_back(self):
        out = X.ex.h_restore_kept_list({})
        self.assertEqual(len(out["kept"]), 2)
        p = out["kept"][0]["path"]
        with self.assertRaises(EngineError):
            X.ex.h_restore_kept_drop({"path": p, "confirm": "no"})
        X.ex.h_restore_kept_drop({"path": p, "confirm": os.path.basename(p)})
        self.assertFalse(os.path.exists(p))
        self.assertEqual(len(X.ex.h_restore_kept_list({})["kept"]), 1)


if __name__ == "__main__":
    unittest.main()
