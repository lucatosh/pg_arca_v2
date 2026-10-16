"""A database RENAMED after the backup (independent review, 16/10): restored by its new name it was taken for a database created after the
backup (the sparse recovery left a stub directory: "could not open file base/<oid>/1259"); restored by its old name to a point after the
rename it answered "database does not exist". Now the backed-up files are used and the name at the point is followed, and said.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_renamed_db_pg'"""
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
    q("postgres", "CREATE DATABASE shop_v1")
    q("shop_v1", "CREATE TABLE t AS SELECT g AS id FROM generate_series(1, 500) g")
    run_backup(F.ctx, "full")
    q("postgres", "ALTER DATABASE shop_v1 RENAME TO shop")
    q("shop", "INSERT INTO t SELECT g FROM generate_series(501, 520) g")
    time.sleep(1.2)
    S["t1"] = now_txt()
    time.sleep(1.2)
    q("shop", "DELETE FROM t")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    T.tearDownModule()


class Renamed(unittest.TestCase):
    def test_01_by_its_new_name(self):
        r = restore_database(F.ctx, "shop", target_time=S["t1"], new_name="shop_back")
        self.assertEqual(q("shop_back", "SELECT count(*) FROM t")[0][0], "520", r)
        self.assertIn("renamed", r.get("note") or "", r)

    def test_02_by_its_old_name(self):
        r = restore_database(F.ctx, "shop_v1", target_time=S["t1"], new_name="shop_v1_back")
        self.assertEqual(q("shop_v1_back", "SELECT count(*) FROM t")[0][0], "520", r)
        self.assertIn("renamed to 'shop'", r.get("note") or "", r)

    def test_03_a_table_by_the_new_name(self):
        restore_object(F.ctx, "shop", objects=["shop.public.t"], target_time=S["t1"], stage_db="pgarca_stage_ren")
        self.assertEqual(q("pgarca_stage_ren", "SELECT count(*) FROM public.t")[0][0], "520")

    def test_04_renamed_then_dropped(self):
        # renamed after the backup, then dropped: recovered up to just before the DROP, under the name it had there (independent review)
        q("postgres", "DROP DATABASE shop")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)
        r = restore_database(F.ctx, "shop_v1", new_name="shop_last")
        self.assertTrue(r.get("stopped_before_drop"), r)
        self.assertEqual(q("shop_last", "SELECT count(*) FROM t")[0][0], "0", "as it was just before the drop (after the DELETE)")


if __name__ == "__main__":
    unittest.main()
