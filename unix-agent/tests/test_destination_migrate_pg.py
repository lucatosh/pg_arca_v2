"""Background migration of a previous backup location into the current one (after a destination change): plan with sizes and free space, verified copy,
resumable after an interruption, the previous location left untouched, and afterwards restores work WITHOUT the previous location.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_destination_migrate_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q
from tests.test_destination_switch_pg import now_utc, switch_archive

from pg_arca.engine import migrate
from pg_arca.engine.backup import run_backup
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.granular import restore_database
from pg_arca.engine.util import Cancelled

S = {}


def mk(previous=True):
    return Ctx(F.conn, F.src, S["new_repo"], "main", S["new_wal"], F.scratch, process_max=4, compression="zlib", level=3, start_fast=True, seg_size=F.seg,
               agent_path=F.ctx.agent_path, key_file=F.key or None, repo_previous=[F.repo] if previous else None, wal_previous=[F.wal] if previous else None)


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE mig")
    q("mig", "CREATE TABLE t AS SELECT g AS id, md5(g::text) AS v FROM generate_series(1, 20000) g")
    run_backup(F.ctx, "full")
    S["mig_oid"] = q("postgres", "SELECT oid FROM pg_database WHERE datname = 'mig'")[0][0]
    F.ctx.wal.note_databases([{"oid": S["mig_oid"], "name": "mig"}])        # what the agent's snapshot records next to the archive
    q("mig", "UPDATE t SET v = 'second' WHERE id <= 100")
    run_backup(F.ctx, "incr")
    time.sleep(1.2)
    S["t_old"] = now_utc()
    time.sleep(1.2)
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)
    S["new_repo"], S["new_wal"] = os.path.join(F.base, "repoM"), os.path.join(F.base, "walM")
    switch_archive(S["new_wal"])
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)
    S["old_listing"] = sorted(os.path.relpath(os.path.join(a, f), F.base) for d in (F.repo, F.wal) for a, _, fs in os.walk(d) for f in fs)


def tearDownModule():
    base.tearDownModule()


class Migrate(unittest.TestCase):
    def test_01_plan_says_what_moves_and_where(self):
        p = migrate.plan(mk())
        self.assertEqual(len(p["sets"]), 2)
        self.assertGreater(p["chunk_bytes"], 0); self.assertGreater(p["wal_files"], 0)
        self.assertTrue(p["ok"]); self.assertIn([c["level"] for c in p["checks"] if c["id"] == "space"], (["ok"], ["warn"]))   # warn: this host's disk is nearly full
        self.assertGreater(p["source_usage_bytes"], 0)
        self.assertIsNotNone(p["write_mb_s"]); self.assertIsNotNone(p["estimated_seconds"])

    def test_02_interrupted_then_resumed_then_complete(self):
        n = {"calls": 0}

        def cancel_soon():
            n["calls"] += 1
            return n["calls"] > 40
        with self.assertRaises(Cancelled):
            migrate.run(mk(), cancel=cancel_soon)
        self.assertEqual(mk(previous=False).repo.own_sets(), [], "no set appears before everything it needs is there")
        r = migrate.run(mk(), throttle_mb_s=500)
        self.assertTrue(r["complete"], r)
        self.assertEqual(len(mk(previous=False).repo.own_sets()), 2)
        self.assertEqual(sorted(os.path.relpath(os.path.join(a, f), F.base) for d in (F.repo, F.wal) for a, _, fs in os.walk(d) for f in fs), S["old_listing"],
                         "the previous location is untouched")
        self.assertTrue(migrate.plan(mk(), bench=False)["nothing_to_do"])

    def test_03_restores_work_without_the_previous_location(self):
        ctx = mk(previous=False)
        self.assertEqual(ctx.wal.database_names().get(S["mig_oid"]), "mig", "the oid->name registry moved with the archive")
        restore_database(ctx, "mig", target_time=S["t_old"], new_name="mig_old")
        self.assertEqual(q("mig_old", "SELECT count(*), count(*) FILTER (WHERE v = 'second') FROM t")[0], ["20000", "100"])

    def test_04_full_space_is_refused_before_copying(self):
        ctx = mk()
        real = migrate._space
        migrate._space = lambda path: dict(real(path), free_bytes=1024)
        try:
            os.rename(os.path.join(S["new_repo"], "stanza", "main", "backup"), os.path.join(S["new_repo"], "stanza", "main", "backup.moved"))
            p = migrate.plan(ctx, bench=False)
            self.assertFalse(p["ok"]); self.assertEqual([c["level"] for c in p["checks"] if c["id"] == "space"][0], "bad")
        finally:
            migrate._space = real
            os.rename(os.path.join(S["new_repo"], "stanza", "main", "backup.moved"), os.path.join(S["new_repo"], "stanza", "main", "backup"))

    def test_05_drop_previous_only_when_nothing_is_lost(self):
        ctx = mk()
        q("mig", "UPDATE t SET v = 'third' WHERE id = 1")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)
        # a new WAL file appears only in the OLD archive (written before the switch? no: simulate a late file) -> refused
        open(os.path.join(F.wal, "000000010000000000000FFF"), "wb").write(b"x" * 16)
        from pg_arca.engine.util import EngineError
        with self.assertRaises(EngineError) as cm:
            migrate.drop_previous(ctx, F.repo, F.wal)
        self.assertEqual(cm.exception.code, "PGA-MIG-020")
        r = migrate.drop_previous(ctx, F.repo, F.wal, abandon=True)
        self.assertEqual(r["abandoned"]["wal_files"], 1)
        self.assertGreater(r["sets_removed"], 0); self.assertGreater(r["wal_removed"], 0)
        self.assertFalse(os.path.isdir(os.path.join(F.repo, "stanza", "main")))
        restore_database(mk(previous=False), "mig", target_time=S["t_old"], new_name="mig_old2")      # the migrated copy is all that is needed
        self.assertEqual(q("mig_old2", "SELECT count(*) FROM t")[0][0], "20000")


if __name__ == "__main__":
    unittest.main()
