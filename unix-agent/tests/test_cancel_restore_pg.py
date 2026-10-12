"""Cancelling a restore at any phase leaves nothing behind: no quarantine / half-created database, no recovery instance still running, no scratch
directory. (An operator presses Annulla in the dock while the restore extracts, recovers or transfers.)

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_cancel_restore_pg -v'
"""
import os
import subprocess
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_database, restore_object
from pg_arca.engine.util import EngineError

DB = "arca_cancel"


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, "CREATE TABLE big AS SELECT g AS id, md5(g::text) AS v FROM generate_series(1, 200000) g; ALTER TABLE big ADD PRIMARY KEY (id)")
    run_backup(F.ctx, "full")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(2)


def tearDownModule():
    base.tearDownModule()


def leftovers():
    dbs = [r[0] for r in q("postgres", "SELECT datname FROM pg_database WHERE datname LIKE 'pgarca_stage_%' OR datname LIKE 'cancel_copy%'")]
    procs = subprocess.run(["ps", "-eo", "args"], stdout=subprocess.PIPE, universal_newlines=True).stdout
    eph = [l for l in procs.splitlines() if "postgres -D" in l and F.scratch in l]
    scratch = [x for x in os.listdir(F.scratch) if x.startswith(("eph", "pgarca"))] if os.path.isdir(F.scratch) else []
    return dbs, eph, scratch


class Cancel(unittest.TestCase):
    def run_cancel(self, fn, at):
        state = {"seen": []}

        def progress(p):
            state["seen"].append(p.get("phase"))
        cancel = lambda: at in state["seen"]
        try:
            fn(progress, cancel)
            self.fail("cancelled at %s but the restore completed (phases %s)" % (at, state["seen"]))
        except EngineError as ex:
            e = type("E", (), {"exception": ex})
        time.sleep(1)
        dbs, eph, scratch = leftovers()
        self.assertEqual((dbs, eph, scratch), ([], [], []), "cancelled at %s (%s): leftovers" % (at, e.exception))
        return state["seen"]

    def test_object_cancelled_in_each_phase(self):
        for at in ("extract", "recovery", "transfer"):
            seen = self.run_cancel(lambda progress, cancel: restore_object(F.ctx, "%s.public.big" % DB, stage_db="pgarca_stage_cx", progress=progress, cancel=cancel), at)
            self.assertIn(at, seen)

    def test_database_cancelled_in_each_phase(self):
        for at in ("extract", "recovery", "transfer"):
            self.run_cancel(lambda progress, cancel: restore_database(F.ctx, DB, new_name="cancel_copy", progress=progress, cancel=cancel), at)

    def test_interrupted_quarantine_is_never_promoted(self):
        # the agent dies while the quarantine database is being filled (simulated: build fails, the cleanup does not run)
        from pg_arca.engine import granular, objects
        from pg_arca.engine.granular import diff_object, promote_object
        orig_drop, orig_counts = granular._drop_db, objects.PgSession
        granular._drop_db = lambda *a, **k: None
        real_write = objects.write_meta
        calls = {"n": 0}

        def write_once(sess, meta):                            # the first (building) marker is written, the final one never
            calls["n"] += 1
            if calls["n"] > 1:
                raise EngineError("PGA-TEST-001", "agent killed")
            return real_write(sess, meta)
        objects.write_meta = write_once
        try:
            with self.assertRaises(EngineError):
                restore_object(F.ctx, "%s.public.big" % DB, stage_db="pgarca_stage_half")
        finally:
            granular._drop_db, objects.write_meta = orig_drop, real_write
        for fn in (lambda: promote_object(F.ctx, "pgarca_stage_half", "%s.public.big" % DB, mode="replace"),
                   lambda: promote_object(F.ctx, "pgarca_stage_half", "%s.public.big" % DB, mode="as_new"),
                   lambda: diff_object(F.ctx, "pgarca_stage_half", "%s.public.big" % DB)):
            with self.assertRaises(EngineError) as e:
                fn()
            self.assertEqual(e.exception.code, "PGA-GEN-094", e.exception)
        q("postgres", "DROP DATABASE pgarca_stage_half")

    def test_retention_floor_initialised_once(self):
        # an archive expired by an older agent (no floor marker): the floor is set from the oldest kept backup, never lowered afterwards
        from pg_arca.engine.maintenance import ensure_retention_floor
        from pg_arca.engine.util import lsn_to_int, wal_segno
        p = os.path.join(F.ctx.wal.wal_dir, F.ctx.wal.FLOOR_FILE)
        if os.path.exists(p):
            os.unlink(p)
        F.ctx.wal._cont_cache = (0, None, None)
        oldest = min(lsn_to_int(x["start_lsn"]) for x in F.ctx.repo.sets() if x.get("status") == "COMPLETE")
        self.assertEqual(ensure_retention_floor(F.ctx), wal_segno(oldest, F.ctx.seg_size))
        self.assertEqual(F.ctx.wal.retention_floor(), wal_segno(oldest, F.ctx.seg_size))
        F.ctx.wal.set_retention_floor(wal_segno(oldest, F.ctx.seg_size) + 5)
        self.assertIsNone(ensure_retention_floor(F.ctx), "an existing floor is never touched")


if __name__ == "__main__":
    unittest.main()
