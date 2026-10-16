"""Replacing a table must not leave rows pointing at nothing (found by the relational restore fuzz).
  inbound : customers restored to yesterday, today's orders (not restored) reference customers created today
  outbound: order_lines restored to yesterday reference orders deleted since
The promotion is refused BEFORE the swap with the counts and nothing changes; allow_orphans goes ahead (foreign key left NOT VALID, said);
restoring the related tables together at the same instant just works.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_orphans_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_object
from pg_arca.engine.util import EngineError

DB = "orph"
S = {}
FP = "SELECT (SELECT md5(string_agg(x::text, ',' ORDER BY id)) FROM customers x) || (SELECT md5(string_agg(y::text, ',' ORDER BY id)) FROM orders y) || (SELECT md5(coalesce(string_agg(z::text, ',' ORDER BY id), '')) FROM lines z)"


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, "CREATE TABLE customers (id int PRIMARY KEY, name text); CREATE TABLE orders (id int PRIMARY KEY, customer_id int REFERENCES customers(id), v text);"
          "CREATE TABLE lines (id int PRIMARY KEY, order_id int REFERENCES orders(id), qty int);"
          "INSERT INTO customers SELECT g, 'c' || g FROM generate_series(1, 10) g; INSERT INTO orders SELECT g, 1 + g % 10, 'o' FROM generate_series(1, 30) g;"
          "INSERT INTO lines SELECT g, 1 + g % 30, g FROM generate_series(1, 60) g")
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["t"] = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
    time.sleep(1.2)
    q(DB, "INSERT INTO customers VALUES (11, 'new customer'); INSERT INTO orders VALUES (31, 11, 'new order');"     # inbound: order of a customer created after t
          "DELETE FROM lines WHERE order_id = 5; DELETE FROM orders WHERE id = 5")                                       # outbound: lines at t reference order 5
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(2)


def tearDownModule():
    base.tearDownModule()


class Orphans(unittest.TestCase):
    def promote(self, objs, stage, **kw):
        restore_object(F.ctx, DB, objects=["%s.public.%s" % (DB, t) for t in objs], target_time=S["t"], stage_db=stage)
        return promote_object(F.ctx, stage, DB, mode="replace", drop_stage=False, **kw)

    def test_01_inbound_orphans_refused_nothing_changes(self):
        before = q(DB, FP)
        with self.assertRaises(EngineError) as cm:
            self.promote(["customers"], "pgarca_stage_o1")
        self.assertEqual(cm.exception.code, "PGA-GEN-096")
        self.assertIn("1 row of public.orders (customer_id) would reference public.customers rows that are not in the restored copy", cm.exception.message)
        self.assertEqual(q(DB, FP), before, "nothing changed")
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_class WHERE relname LIKE '%_pitr_%' OR relname LIKE '%_old_%'")[0][0], "0", "no temporary table left")
        q("postgres", "DROP DATABASE pgarca_stage_o1")

    def test_02_outbound_orphans_refused(self):
        with self.assertRaises(EngineError) as cm:
            self.promote(["lines"], "pgarca_stage_o2")
        self.assertIn("of public.lines (order_id) would reference public.orders rows that no longer exist", cm.exception.message)
        q("postgres", "DROP DATABASE pgarca_stage_o2")

    def test_03_related_tables_together_at_the_same_instant(self):
        r = self.promote(["customers", "orders", "lines"], "pgarca_stage_o3")
        self.assertFalse(r.get("orphans"))
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND convalidated AND conrelid IN ('orders'::regclass, 'lines'::regclass)")[0][0], "2")
        q("postgres", "DROP DATABASE pgarca_stage_o3")

    def test_04_allow_orphans_goes_ahead_and_says_so(self):
        q(DB, "INSERT INTO customers VALUES (12, 'another'); INSERT INTO orders VALUES (32, 12, 'x')")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        r = self.promote(["customers"], "pgarca_stage_o4", allow_orphans=True)
        self.assertTrue(r["orphans"])
        self.assertTrue(any("orphaned rows accepted" in w and "NOT VALID" in w for w in r["plan"]["warnings"]), r["plan"]["warnings"])
        q("postgres", "DROP DATABASE pgarca_stage_o4")


if __name__ == "__main__":
    unittest.main()
