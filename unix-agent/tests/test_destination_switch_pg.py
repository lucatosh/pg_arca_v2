"""Changing the backup destination (repository + WAL archive) of a live cluster must not lose the PITR history: sets and WAL left in the previous
location stay restorable (read-only) until they are migrated; the new location starts its own chain (a full backup), never deduplicates against or
builds on the old one, and retention never touches the old one.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_destination_switch_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.granular import restore_database
from pg_arca.engine.maintenance import expire
from pg_arca.engine.util import EngineError

S = {}


def now_utc():
    return q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]


def switch_archive(wal_dir):
    walbin = os.path.join(base.HERE, "pg-arca-wal")
    q("postgres", "ALTER SYSTEM SET archive_command = 'env WAL_ARCHIVE_DIR=%s PG_ARCA_HOME=%s PG_ARCA_CONF=/nonexistent%s %s archive %%p %%f'"
      % (wal_dir, base.HERE, (" PG_ARCA_KEY_FILE=" + F.key) if F.key else "", walbin))
    q("postgres", "SELECT pg_reload_conf()")


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE moving")
    q("moving", "CREATE TABLE t (id int PRIMARY KEY, phase text)")
    q("moving", "INSERT INTO t SELECT g, 'old' FROM generate_series(1, 100) g")
    run_backup(F.ctx, "full")
    run_backup(F.ctx, "incr")
    time.sleep(1.2)
    S["t_old"] = now_utc()                                   # a point in time covered ONLY by the old location
    time.sleep(1.2)
    q("moving", "UPDATE t SET phase = 'between'")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)
    # ---- the destination changes (what apply does: new paths + the old ones as read-only previous locations)
    S["new_repo"], S["new_wal"] = os.path.join(F.base, "repo2"), os.path.join(F.base, "wal2")
    switch_archive(S["new_wal"])
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)
    q("moving", "UPDATE t SET phase = 'after_switch'")       # only in the NEW archive, before any backup in the new location
    time.sleep(1.2)
    S["t_cross"] = now_utc()
    time.sleep(1.2)
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)
    S["ctx"] = Ctx(F.conn, F.src, S["new_repo"], "main", S["new_wal"], F.scratch, process_max=4, compression="zlib", level=3, start_fast=True, seg_size=F.seg,
                   agent_path=F.ctx.agent_path, key_file=F.key or None, repo_previous=[F.repo], wal_previous=[F.wal])


def tearDownModule():
    base.tearDownModule()


class Switch(unittest.TestCase):
    def test_01_old_sets_listed_and_restorable_from_the_previous_location(self):
        ctx = S["ctx"]
        sets = ctx.repo.complete_sets()
        self.assertEqual(len(sets), 2)
        self.assertTrue(all(s.get("location") == os.path.realpath(F.repo) for s in sets), sets)
        self.assertEqual(ctx.repo.own_sets(), [], "nothing in the new location yet")
        restore_database(ctx, "moving", target_time=S["t_old"], new_name="moving_old")
        self.assertEqual(q("moving_old", "SELECT count(*), max(phase) FROM t")[0], ["100", "old"])

    def test_02_new_location_starts_its_own_chain(self):
        ctx = S["ctx"]
        first = run_backup(ctx, "incr")                   # no full HERE: never an incremental on top of a set left behind - it becomes a full
        self.assertEqual((first["type"], first.get("parent")), ("full", None))
        q("moving", "UPDATE t SET phase = 'new'")
        m = run_backup(ctx, "full")
        self.assertEqual(m["type"], "full")
        self.assertTrue(os.path.isdir(os.path.join(S["new_repo"], "stanza", "main", "backup", m["id"])))
        self.assertTrue(all(ctx.repo.find_chunk(h) and ctx.repo.find_chunk(h).startswith(os.path.realpath(S["new_repo"]))
                            for e in ctx.repo.load_manifest(m)["files"].values() for _, _, h in e["chunks"]), "every chunk of the new chain lives in the new location")
        self.assertEqual([s["id"] for s in ctx.repo.own_sets()], [first["id"], m["id"]])
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)
        restore_database(ctx, "moving", new_name="moving_new")
        self.assertEqual(q("moving_new", "SELECT max(phase) FROM t")[0][0], "new")

    def test_03_pitr_across_the_switch_uses_both_archives(self):
        # base = the OLD incremental (no new backup existed yet at t_cross), WAL before the switch in the old archive, after it in the new one
        ctx = S["ctx"]
        r = restore_database(ctx, "moving", target_time=S["t_cross"], new_name="moving_cross")
        self.assertIn(r["set"], [s["id"] for s in ctx.repo.sets() if s.get("location")], "restored from a set of the previous location")
        self.assertEqual(q("moving_cross", "SELECT max(phase) FROM t")[0][0], "after_switch")
        self.assertTrue(os.listdir(S["new_wal"]) and os.listdir(F.wal))

    def test_04_retention_never_touches_the_previous_location(self):
        ctx = S["ctx"]
        before = sorted(os.listdir(os.path.join(F.repo, "stanza", "main", "backup")))
        run_backup(ctx, "full")
        r = expire(ctx, retention_full=1)
        self.assertEqual(sorted(os.listdir(os.path.join(F.repo, "stanza", "main", "backup"))), before, "old location untouched")
        self.assertEqual(len(r["keep_sets"]), 1)
        restore_database(ctx, "moving", target_time=S["t_old"], new_name="moving_old2")      # still restorable from the old location
        self.assertEqual(q("moving_old2", "SELECT max(phase) FROM t")[0][0], "old")


if __name__ == "__main__":
    unittest.main()
