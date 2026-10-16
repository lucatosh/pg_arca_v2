"""A database dropped, then a backup taken, then a point in time AFTER both (independent review, 16/10): "nightly backup at 02:00, database
dropped on Monday at 23:00, restore to Tuesday 08:00" answered "did not exist yet, choose a later time" because the newest backup does not know
the database. The newest backup that has it is the base, and the recovery stops just before the DROP - as without the later backup.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_dropped_then_backup_pg'"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_database, restore_object

S = {}


def now_txt():
    return q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]


def setUpModule():
    T.setUpModule()
    q("postgres", "CREATE DATABASE gone_db")
    q("gone_db", "CREATE TABLE t AS SELECT g AS id FROM generate_series(1, 777) g")
    run_backup(F.ctx, "full")
    q("gone_db", "INSERT INTO t SELECT g FROM generate_series(778, 800) g")      # after the first backup, before the drop
    time.sleep(1.2)
    q("postgres", "DROP DATABASE gone_db")
    time.sleep(1.2)
    run_backup(F.ctx, "full")                                                    # the nightly backup after the drop
    time.sleep(1.2)
    S["t_after"] = now_txt()
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    T.tearDownModule()


class DroppedThenBackup(unittest.TestCase):
    def test_01_database(self):
        r = restore_database(F.ctx, "gone_db", target_time=S["t_after"], new_name="gone_back")
        self.assertEqual(q("gone_back", "SELECT count(*) FROM t")[0][0], "800", r)
        self.assertTrue(r.get("stopped_before_drop"), r)

    def test_02_table(self):
        r = restore_object(F.ctx, "gone_db", objects=["gone_db.public.t"], target_time=S["t_after"], stage_db="pgarca_stage_gone")
        self.assertEqual(q("pgarca_stage_gone", "SELECT count(*) FROM public.t")[0][0], "800", r)


if __name__ == "__main__":
    unittest.main()
