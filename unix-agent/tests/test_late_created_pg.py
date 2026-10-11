"""Restore of things CREATED AFTER the last backup - the everyday case "the database / table was made this morning, the backup is from last night":
  - a whole database that is not in the base backup (rebuilt from the WAL alone: CREATE DATABASE + its data are replayed),
  - a table created after the backup in a database that is in it,
  - a target time BEFORE the database existed -> a clear refusal (PGA-PITR-016) instead of an internal error,
  - the plan (dry run) says so as a warning instead of failing with "not in backup".

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_late_created_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_database, restore_object
from pg_arca.engine.util import EngineError

S = {}


def now_txt():
    return q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE old_db")
    q("old_db", "CREATE TABLE t_old AS SELECT g AS id, md5(g::text) AS v FROM generate_series(1, 5000) g")
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["before_new"] = now_txt()                                      # after the backup, before the new database exists
    time.sleep(1.2)
    q("postgres", "CREATE DATABASE new_db ENCODING 'UTF8' TEMPLATE template0")
    q("new_db", "CREATE TABLE fresh (id int PRIMARY KEY, note text); INSERT INTO fresh SELECT g, 'n' || g FROM generate_series(1, 3000) g")
    q("old_db", "CREATE TABLE t_new (id int PRIMARY KEY, v text); INSERT INTO t_new SELECT g, 'x' || g FROM generate_series(1, 777) g")
    time.sleep(1.2)
    S["t_ok"] = now_txt()
    time.sleep(1.2)
    q("new_db", "DELETE FROM fresh WHERE id > 100")                  # the damage after the target
    q("old_db", "DROP TABLE t_new")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    base.tearDownModule()


class Late(unittest.TestCase):
    def test_01_plan_warns_instead_of_failing(self):
        p = restore_database(F.ctx, "new_db", target_time=S["t_ok"], dry_run=True, new_name="new_db_back")
        self.assertTrue(p.get("created_after_backup"), p)
        self.assertIn("late_db", [c["id"] for c in p["preflight"]["checks"]])
        self.assertTrue(p["preflight"]["ok"], p["preflight"])
        o = restore_object(F.ctx, "old_db.public.t_new", target_time=S["t_ok"], dry_run=True)
        self.assertIn("late_obj_unknown", [c["id"] for c in o["preflight"]["checks"]], o["preflight"])   # t_new was dropped after the target: unknown now too

    def test_02_database_created_after_the_backup(self):
        r = restore_database(F.ctx, "new_db", target_time=S["t_ok"], new_name="new_db_back")
        self.assertEqual(r["result_database"], "new_db_back")
        self.assertEqual(q("new_db_back", "SELECT count(*), sum(id) FROM fresh")[0], ["3000", str(sum(range(1, 3001)))])

    def test_03_before_it_existed_is_refused_clearly(self):
        with self.assertRaises(EngineError) as e:
            restore_database(F.ctx, "new_db", target_time=S["before_new"], new_name="new_db_never")
        self.assertEqual(e.exception.code, "PGA-PITR-016", e.exception)
        self.assertEqual(q("postgres", "SELECT count(*) FROM pg_database WHERE datname = 'new_db_never'")[0][0], "0")

    def test_04_table_created_after_the_backup(self):
        restore_object(F.ctx, "old_db.public.t_new", target_time=S["t_ok"], stage_db="pgarca_stage_late")
        promote_object(F.ctx, "pgarca_stage_late", "old_db", mode="replace", drop_stage=True)
        self.assertEqual(q("old_db", "SELECT count(*) FROM t_new")[0][0], "777")

    def test_05_object_in_a_database_created_after_the_backup(self):
        restore_object(F.ctx, "new_db.public.fresh", target_time=S["t_ok"], stage_db="pgarca_stage_late2")
        promote_object(F.ctx, "pgarca_stage_late2", "new_db", mode="replace", drop_stage=True)
        self.assertEqual(q("new_db", "SELECT count(*) FROM fresh")[0][0], "3000")


if __name__ == "__main__":
    unittest.main()
