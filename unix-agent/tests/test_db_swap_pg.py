"""The end of a database restore is done by the tool: the recovered database takes the place of the original (kept as <db>_before_<ts>), sessions on it are
ended, a dropped database simply comes back with its name; refused for an incomplete copy, a quarantine database or a standby.
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_db_swap_pg -v'
"""
import os
import subprocess
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import RESTORING_MARK, restore_database, swap_database
from pg_arca.engine.util import EngineError

X = T.Fx()


def setUpModule():
    T.setUpModule()
    q("postgres", "CREATE DATABASE shop")
    q("shop", "CREATE TABLE orders (id int PRIMARY KEY, v text); INSERT INTO orders SELECT g, 'ok' FROM generate_series(1, 100) g")
    q("postgres", "CREATE DATABASE gone")
    q("gone", "CREATE TABLE t (id int); INSERT INTO t SELECT generate_series(1, 7)")
    # names that are not plain identifiers (independent review: accepted by the console, refused by the swap after hours of recovery)
    q("postgres", 'CREATE DATABASE "sales-eu"')
    q("sales-eu", "CREATE TABLE o (id int); INSERT INTO o SELECT generate_series(1, 5)")
    q("postgres", 'CREATE DATABASE "Vendite Q1"')
    q("Vendite Q1", "CREATE TABLE v (id int); INSERT INTO v SELECT generate_series(1, 3)")
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    X.t = q("postgres", "SELECT to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
    time.sleep(1.2)
    q("shop", "DELETE FROM orders WHERE id > 10; UPDATE orders SET v = 'bad'")
    q("postgres", "DROP DATABASE gone")
    q("sales-eu", "DELETE FROM o")
    q("postgres", 'DROP DATABASE "Vendite Q1"')
    q("postgres", "SELECT pg_switch_wal()")


def tearDownModule():
    T.tearDownModule()


def dbs():
    return [r[0] for r in q("postgres", "SELECT datname FROM pg_database ORDER BY 1")]


class Swap(unittest.TestCase):
    def test_01_restored_database_takes_the_place_of_the_original(self):
        restore_database(F.ctx, "shop", new_name="shop_restored", target_time=X.t)
        # an application holding a session on the damaged database
        app = subprocess.Popen([os.path.join(T.BIN, "psql"), "-h", F.sock, "-p", str(F.port), "-U", "postgres", "-d", "shop", "-c", "SELECT pg_sleep(60)"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(1)
        dry = swap_database(F.ctx, "shop_restored", "shop", dry_run=True)
        self.assertTrue(dry["original_existed"]); self.assertTrue(any(x["database"] == "shop" for x in dry["sessions"]), dry)
        self.assertIn("shop_restored", dbs(), "dry run changes nothing")
        r = swap_database(F.ctx, "shop_restored", "shop")
        app.wait(timeout=20)
        self.assertTrue(r["replaced"]); self.assertGreaterEqual(r["sessions_ended"], 1)
        self.assertEqual(q("shop", "SELECT count(*), count(*) FILTER (WHERE v = 'ok') FROM orders"), [["100", "100"]])
        old = r["old_kept_as"]
        self.assertTrue(old.startswith("shop_before_")); self.assertIn(old, dbs()); self.assertNotIn("shop_restored", dbs())
        self.assertEqual(q(old, "SELECT count(*) FROM orders")[0][0], "10", "the damaged one is kept: the way back")
        self.assertEqual(q("postgres", "SELECT datallowconn::text FROM pg_database WHERE datname = 'shop'")[0][0], "true")

    def test_02_dropped_database_comes_back_with_its_name(self):
        restore_database(F.ctx, "gone", new_name="gone_restored", target_time=X.t)
        r = swap_database(F.ctx, "gone_restored", "gone")
        self.assertFalse(r["original_existed"]); self.assertIsNone(r["old_kept_as"])
        self.assertEqual(q("gone", "SELECT count(*) FROM t")[0][0], "7")

    def test_02b_names_that_are_not_identifiers(self):
        from pg_arca.engine.granular import default_restore_name
        tmp = default_restore_name("sales-eu")
        restore_database(F.ctx, "sales-eu", new_name=tmp, target_time=X.t)
        r = swap_database(F.ctx, tmp, "sales-eu")
        self.assertTrue(r["replaced"]); self.assertTrue(r["old_kept_as"].startswith("sales-eu_before_"), r)
        self.assertEqual(q("sales-eu", "SELECT count(*) FROM o")[0][0], "5")
        self.assertIn(r["old_kept_as"], dbs())
        restore_database(F.ctx, "Vendite Q1", new_name="Vendite Q1", target_time=X.t)        # dropped: back under its own name
        self.assertEqual(q("Vendite Q1", "SELECT count(*) FROM v")[0][0], "3")
        with self.assertRaises(EngineError):
            swap_database(F.ctx, tmp, "a=b")

    def test_02c_long_name_keeps_the_time(self):
        from pg_arca.engine.granular import _check_db_name
        from pg_arca.engine import objects
        n = "è" * 30                                    # 60 bytes
        old = objects._short(n, "_before_20261016_120000")
        self.assertLessEqual(len(old.encode("utf-8")), 63); self.assertTrue(old.endswith("_before_20261016_120000"))
        _check_db_name(n, "x")

    def test_03_refusals(self):
        q("postgres", "CREATE DATABASE half")
        q("postgres", "COMMENT ON DATABASE half IS '%s since now'" % RESTORING_MARK)
        with self.assertRaises(EngineError):
            swap_database(F.ctx, "half", "shop")
        with self.assertRaises(EngineError):
            swap_database(F.ctx, "pgarca_stage_x", "shop")
        with self.assertRaises(EngineError):
            swap_database(F.ctx, "nope", "shop")
        self.assertIn("shop", dbs())


if __name__ == "__main__":
    unittest.main()
