"""A whole-instance restore is finished only when the copy RUNS: destination proposed by the agent, copy started on its own port, registry, stop / start /
resume / keep / delete, restart after the agent lost it, expiry, automatic fixes of settings that only worked on the original host.
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_restored_pg -v'
"""
import json
import os
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine import restored
from pg_arca.engine.backup import run_backup
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance
from pg_arca.engine.util import EngineError

X = T.Fx()


def setUpModule():
    T.setUpModule()
    q("postgres", "CREATE DATABASE shop")
    q("shop", "CREATE TABLE orders (id serial PRIMARY KEY, tag text); INSERT INTO orders (tag) SELECT 'A' FROM generate_series(1, 100)")
    run_backup(F.ctx, "full")
    q("shop", "INSERT INTO orders (tag) SELECT 'B' FROM generate_series(1, 40)")
    time.sleep(1.5)
    X.t = q("postgres", "SELECT to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
    time.sleep(1.5)
    q("shop", "INSERT INTO orders (tag) SELECT 'C' FROM generate_series(1, 7)")
    last = q("postgres", "SELECT pg_walfile_name(pg_switch_wal() - 1)")[0][0]
    for _ in range(90):
        if (q("postgres", "SELECT COALESCE(last_archived_wal, '') FROM pg_stat_archiver")[0][0] or "") >= last:
            break
        time.sleep(1)
    X.state = os.path.join(F.base, "state")
    F.ctx.conn.bindir = T.BIN


def tearDownModule():
    for it in restored.load(X.state):
        try:
            restored._stop(it, "immediate")
        except Exception:
            pass
    T.tearDownModule()


def rows(it, db="shop"):
    s = PgSession(PgConn(host=it["sockdir"], port=it["port"], user="postgres", bindir=T.BIN, dbname=db))
    try:
        return s.query("SELECT tag, count(*) FROM orders GROUP BY 1 ORDER BY 1")
    finally:
        s.close()


def entry(rid):
    return [x for x in restored.load(X.state) if x["id"] == rid][0]


def make(name, **kw):
    dest = os.path.join(F.base, name)
    plan = restore_instance(F.ctx, dest=dest, **kw)
    return dest, plan


class Restored(unittest.TestCase):
    def test_01_destination_is_proposed_with_filesystem_facts(self):
        w = restored.suggest(F.ctx, 50 << 20)
        self.assertTrue(w["candidates"], w)
        self.assertTrue(w["recommended"], w)
        c = w["candidates"][0]
        for k in ("path", "mountpoint", "fstype", "free", "total", "free_after", "level", "why", "shares"):
            self.assertIn(k, c)
        self.assertTrue(c["path"].endswith(w["name"]))
        self.assertFalse(c["path"].startswith(F.src.rstrip("/") + "/"), "never inside the live data directory")
        self.assertFalse([x for x in w["candidates"] if restored._system_path(x["root"])], "never in configuration, programs or logs (a container's /etc/postgresql volume)")
        self.assertTrue(restored._system_path("/etc/postgresql") and restored._system_path("/var/log/x") and not restored._system_path("/var/tmp") and not restored._system_path("/srv/restore"))
        huge = restored.suggest(F.ctx, 1 << 60)
        self.assertIsNone(huge["recommended"], "nothing has room for an exabyte")
        self.assertTrue(all(x["level"] == "bad" for x in huge["candidates"]))
        self.assertGreater(restored.instance_bytes(F.ctx, None, {}), 1 << 20)

    def test_02_restore_starts_the_copy_at_the_target(self):
        dest, plan = make("copy-a", target_time=X.t)
        it = restored.register_and_start(F.ctx, X.state, dest, plan, action="promote", ttl_hours=24)
        X.a = it["id"]
        self.assertEqual(it["state"], "running", it)
        self.assertTrue(it["running"])
        self.assertIn("shop", it["databases"] or [])
        self.assertNotEqual(it["port"], F.port)
        self.assertEqual(rows(entry(X.a)), [["A", "100"], ["B", "40"]])
        self.assertTrue(it["expires_at"])
        self.assertTrue(os.path.exists(os.path.join(dest, restored.MARK)))
        conf = open(os.path.join(dest, "postgresql.auto.conf")).read()
        self.assertIn("external_pid_file = ''", conf)
        self.assertEqual(q("shop", "SELECT count(*) FROM orders")[0][0], "147", "production untouched")

    def test_03_stop_and_start_again(self):
        it = restored.op_stop(X.state, X.a)
        self.assertEqual(it["state"], "stopped")
        self.assertFalse(it["running"])
        it = restored.op_start(X.state, X.a)
        self.assertEqual(it["state"], "running")
        self.assertEqual(rows(entry(X.a)), [["A", "100"], ["B", "40"]])

    def test_04_keep_and_expiry_change(self):
        it = restored.op_keep(X.state, X.a, None)
        self.assertIsNone(it["expires_at"])
        it = restored.op_keep(X.state, X.a, 2)
        self.assertTrue(it["expires_at"])

    def test_05_agent_restart_brings_it_back(self):
        it = entry(X.a)
        T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", it["dest"], "-m", "immediate", "stop")      # what systemd does to the agent's processes on restart
        self.assertFalse(restored._alive(it))
        restored._hk["at"] = 0
        restored._hk["restarted"].clear()
        lst = restored.housekeeping(X.state, F.ctx, every=0)
        self.assertEqual([x["state"] for x in lst if x["id"] == X.a], ["down"])
        for _ in range(60):
            if restored._alive(entry(X.a)):
                break
            time.sleep(1)
        self.assertTrue(restored._alive(entry(X.a)), "restarted by the housekeeping")

    def test_06_pause_at_target_then_resume(self):
        dest, plan = make("copy-p", target_time=X.t, action="pause")
        it = restored.register_and_start(F.ctx, X.state, dest, plan, action="pause", ttl_hours=1)
        X.p = it["id"]
        self.assertEqual(it["state"], "paused", it)
        self.assertEqual(rows(entry(X.p)), [["A", "100"], ["B", "40"]])
        it = restored.op_resume(X.state, X.p)
        self.assertEqual(it["state"], "running")

    def test_07_missing_library_is_dropped_and_said(self):
        dest, plan = make("copy-lib")
        with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
            f.write("\nshared_preload_libraries = 'pgarca_no_such_lib'\n")
        it = restored.register_and_start(F.ctx, X.state, dest, plan, ttl_hours=1)
        X.lib = it["id"]
        self.assertEqual(it["state"], "running", it)
        self.assertTrue(any("pgarca_no_such_lib" in n for n in it["notes"]), it["notes"])
        self.assertEqual(rows(entry(X.lib)), [["A", "100"], ["B", "40"], ["C", "7"]], "no target: end of the archive")

    def test_08_drop_needs_the_name(self):
        with self.assertRaises(EngineError):
            restored.op_drop(F.ctx, X.state, X.lib, confirm="wrong")
        it = entry(X.lib)
        out = restored.op_drop(F.ctx, X.state, X.lib, confirm=it["name"])
        self.assertEqual(out["deleted"], X.lib)
        self.assertFalse(os.path.exists(it["dest"]))
        self.assertNotIn(X.lib, [x["id"] for x in restored.load(X.state)])

    def test_09_expired_copies_are_deleted_by_the_agent(self):
        with restored._Locked(X.state) as L:
            restored._find(L.items, X.p)["expires_at"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
            L.save()
        dest = entry(X.p)["dest"]
        restored._hk["at"] = 0
        restored.housekeeping(X.state, lambda: F.ctx, every=0)
        for _ in range(60):
            if X.p not in [x["id"] for x in restored.load(X.state)]:
                break
            time.sleep(0.5)
        self.assertNotIn(X.p, [x["id"] for x in restored.load(X.state)])
        self.assertFalse(os.path.exists(dest))

    def test_10_never_deletes_a_directory_it_did_not_make(self):
        it = entry(X.a)
        with open(os.path.join(it["dest"], restored.MARK), "w") as f:
            json.dump({"id": "rst-00000000"}, f)
        with self.assertRaises(EngineError) as e:
            restored.op_drop(F.ctx, X.state, X.a, confirm=it["name"])
        self.assertEqual(e.exception.code, "PGA-RST-064")


if __name__ == "__main__":
    unittest.main()
