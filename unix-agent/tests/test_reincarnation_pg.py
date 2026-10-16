"""A database NAME that belongs to two databases over time (dropped, then created again - e.g. by a restore under its own name).
Found on the lab: a restore of the database as it is now gave back the earlier one (the backup only knows that oid; the recovery stopped before
its DROP). The point decides: after the DROP of the backed-up one, the later database is meant and is rebuilt from the WAL.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_reincarnation_pg'"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_database


def setUpModule():
    T.setUpModule()


def tearDownModule():
    T.tearDownModule()


def now():
    return q("postgres", "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]


def archived():
    seg = q("postgres", "SELECT pg_walfile_name(pg_switch_wal())")[0][0]
    for _ in range(90):
        last = q("postgres", "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")[0][0] or ""
        if last[8:] >= seg[8:] and last[:8] >= seg[:8]:
            return
        time.sleep(1)
    raise AssertionError("not archived")


class Reincarnation(unittest.TestCase):
    def test_the_point_decides_which_database_of_that_name(self):
        q("postgres", "CREATE DATABASE inc")
        q("inc", "CREATE TABLE t(x int); INSERT INTO t SELECT generate_series(1, 100)")
        run_backup(F.ctx, "full")
        time.sleep(1.2); t_first = now(); time.sleep(1.2)
        q("postgres", "DROP DATABASE inc")
        archived()
        # restored under its own name: a NEW database (another oid) holding the state before the drop
        r = restore_database(F.ctx, "inc", new_name="inc")
        self.assertTrue(r.get("stopped_before_drop"), r)
        self.assertEqual(q("inc", "SELECT count(*) FROM t")[0][0], "100")
        q("inc", "INSERT INTO t SELECT generate_series(101, 150)")      # life goes on in the later database
        time.sleep(1.2); t_second = now(); time.sleep(1.2)
        archived()
        # as it is now: the later database, rebuilt from the WAL (the backup has only the earlier oid)
        r = restore_database(F.ctx, "inc", new_name="inc_now")
        self.assertEqual(q("inc_now", "SELECT count(*) FROM t")[0][0], "150", r)
        self.assertIn("created again", r.get("note") or "", r)
        # a time after the re-creation: the later one too
        restore_database(F.ctx, "inc", target_time=t_second, new_name="inc_t2")
        self.assertEqual(q("inc_t2", "SELECT count(*) FROM t")[0][0], "150")
        # a time before the drop: the earlier one
        restore_database(F.ctx, "inc", target_time=t_first, new_name="inc_t1")
        self.assertEqual(q("inc_t1", "SELECT count(*) FROM t")[0][0], "100")
        # a TABLE of the later database, as it is now (object restore resolves the database the same way)
        from pg_arca.engine.granular import restore_object
        r = restore_object(F.ctx, "inc.public.t", stage_db="pgarca_stage_inc")
        self.assertEqual(q("pgarca_stage_inc", "SELECT count(*) FROM public.t")[0][0], "150", r)


if __name__ == "__main__":
    unittest.main()
