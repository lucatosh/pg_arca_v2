"""Row recovery and the foreign keys of OTHER tables pointing at the rows (independent review, 16/10: an ON DELETE CASCADE silently removed the
order lines of the deleted orders, and no safety copy held them). What the keys would do is said before anything is applied; NO ACTION /
RESTRICT with rows still pointing refuses; CASCADE / SET NULL / ON UPDATE CASCADE are applied only when confirmed, after a safety copy of
every affected row (cascades of cascades and a table pointing at itself included).
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_rows_fk_pg'"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_object, apply_rows
from pg_arca.engine.util import EngineError

DB = "arca_rowsfk"
STAGE = "pgarca_stage_rowsfk"
S = {}


def now_txt():
    return q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]


def setUpModule():
    T.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, "CREATE TABLE orders(id int PRIMARY KEY, who text);"
          "CREATE TABLE items(id int PRIMARY KEY, order_id int REFERENCES orders ON DELETE CASCADE, sku text);"
          "CREATE TABLE item_notes(id int PRIMARY KEY, item_id int REFERENCES items ON DELETE CASCADE, note text);"
          "CREATE TABLE shipments(id int PRIMARY KEY, order_id int REFERENCES orders ON DELETE SET NULL);"
          "CREATE TABLE invoices(id int PRIMARY KEY, order_id int REFERENCES orders);"
          "CREATE TABLE cat(id int PRIMARY KEY, parent int REFERENCES cat ON DELETE CASCADE, label text);"
          "CREATE TABLE products(id int PRIMARY KEY, code text UNIQUE);"
          "CREATE TABLE lines(id int PRIMARY KEY, code text REFERENCES products(code) ON UPDATE CASCADE);"
          "INSERT INTO orders SELECT g, 'c' || g FROM generate_series(1, 10) g;"
          "INSERT INTO items SELECT g, g, 'sku' FROM generate_series(1, 10) g;"
          "INSERT INTO cat VALUES (1, NULL, 'root');"
          "INSERT INTO products VALUES (1, 'A'), (2, 'B'); INSERT INTO lines VALUES (1, 'A'), (2, 'A'), (3, 'B');"
          "CREATE TABLE docs(id int PRIMARY KEY, body json); INSERT INTO docs VALUES (1, '{\"z\": 1,  \"a\": [1, 2], \"a\": 3}')")
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["t0"] = now_txt()
    time.sleep(1.2)
    q(DB, "INSERT INTO orders VALUES (11, 'n'), (12, 'n'), (13, 'n');"
          "INSERT INTO items VALUES (11, 11, 'x'), (12, 11, 'y'), (13, 12, 'z');"
          "INSERT INTO item_notes VALUES (1, 11, 'fragile'), (2, 13, 'gift');"
          "INSERT INTO shipments VALUES (1, 11), (2, 1);"
          "INSERT INTO invoices VALUES (1, 13);"
          "INSERT INTO cat VALUES (100, 1, 'a'), (101, 100, 'b'), (102, 101, 'c');"
          "UPDATE products SET code = 'A2' WHERE id = 1; DELETE FROM docs")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)
    restore_object(F.ctx, DB, objects=["%s.public.%s" % (DB, t) for t in ("orders", "items", "item_notes", "shipments", "invoices", "cat", "products", "lines", "docs")],
                   target_time=S["t0"], stage_db=STAGE)


def tearDownModule():
    T.tearDownModule()


def fx(r):
    return sorted((e["table"], e["action"], e["rows"], e["level"]) for e in r.get("foreign_key_effects") or [])


class RowsFk(unittest.TestCase):
    def test_01_the_plan_says_what_other_tables_go_through(self):
        r = apply_rows(F.ctx, STAGE, "%s.public.orders" % DB, delete_all_added=True, dry_run=True)
        self.assertEqual(r["deleted"], 3)
        self.assertEqual(fx(r), [("public.invoices", "blocking", 1, 1), ("public.item_notes", "deleted with them", 2, 2),
                                 ("public.items", "deleted with them", 3, 1), ("public.shipments", "set to NULL", 1, 1)])

    def test_02_a_key_without_action_still_pointing_refuses_everything(self):
        with self.assertRaises(EngineError) as e:
            apply_rows(F.ctx, STAGE, "%s.public.orders" % DB, delete_all_added=True)
        self.assertEqual(e.exception.code, "PGA-GEN-094")
        self.assertIn("invoices", e.exception.message)
        self.assertEqual(q(DB, "SELECT count(*) FROM orders")[0][0], "13", "nothing applied")

    def test_03_cascades_only_when_confirmed_and_saved_first(self):
        spec = "%s.public.orders" % DB
        with self.assertRaises(EngineError) as e:
            apply_rows(F.ctx, STAGE, spec, delete_keys=["[11]", "[12]"])
        self.assertEqual(e.exception.code, "PGA-GEN-093")
        self.assertEqual(q(DB, "SELECT count(*) FROM items WHERE order_id IN (11, 12)")[0][0], "3", "nothing applied without the confirmation")
        r = apply_rows(F.ctx, STAGE, spec, delete_keys=["[11]", "[12]"], allow_cascade=True)
        self.assertEqual(r["deleted"], 2)
        self.assertEqual(q(DB, "SELECT count(*) FROM items WHERE order_id IN (11, 12)")[0][0], "0")
        self.assertEqual(q(DB, "SELECT order_id IS NULL FROM shipments WHERE id = 1")[0][0], "t")
        copies = r["cascade_safety_copies"]
        self.assertEqual(len(copies), 3, copies)
        got = {}
        for c in copies:
            got[c] = q(DB, "SELECT count(*) FROM %s" % c)[0][0]
        self.assertEqual(sorted(got.values()), ["1", "2", "3"], got)                 # 3 items, 2 notes, 1 shipment

    def test_04_a_tree_pointing_at_itself(self):
        spec = "%s.public.cat" % DB
        r = apply_rows(F.ctx, STAGE, spec, delete_all_added=True, dry_run=True)
        self.assertEqual(fx(r), [], "the whole new subtree is deleted on purpose: nothing else is touched")
        r = apply_rows(F.ctx, STAGE, spec, delete_keys=["[100]"], dry_run=True)
        self.assertEqual(fx(r), [("public.cat", "deleted with them", 1, 1), ("public.cat", "deleted with them", 1, 2)])
        r = apply_rows(F.ctx, STAGE, spec, delete_keys=["[100]"], allow_cascade=True)
        self.assertEqual(q(DB, "SELECT string_agg(id::text, ',' ORDER BY id) FROM cat")[0][0], "1")
        self.assertEqual(len(r["cascade_safety_copies"]), 2)

    def test_05_reverting_a_referenced_key_updates_the_referencing_rows_only_when_confirmed(self):
        spec = "%s.public.products" % DB
        r = apply_rows(F.ctx, STAGE, spec, restore_all=["changed"], dry_run=True)
        self.assertEqual(fx(r), [("public.lines", "updated with them", 2, 1)])
        with self.assertRaises(EngineError) as e:
            apply_rows(F.ctx, STAGE, spec, restore_all=["changed"])
        self.assertEqual(e.exception.code, "PGA-GEN-093")
        r = apply_rows(F.ctx, STAGE, spec, restore_all=["changed"], allow_cascade=True)
        self.assertEqual(q(DB, "SELECT string_agg(code, ',' ORDER BY id) FROM lines")[0][0], "A,A,B")
        self.assertEqual(q(DB, "SELECT string_agg(code, ',' ORDER BY id) FROM %s" % r["cascade_safety_copies"][0])[0][0], "A2,A2")

    def test_06_json_comes_back_byte_for_byte(self):
        # json (not jsonb) keeps its text: key order, duplicate keys, spaces - a signed payload must be the same bytes (independent review)
        apply_rows(F.ctx, STAGE, "%s.public.docs" % DB, restore_all=["missing"])
        self.assertEqual(q(DB, "SELECT body::text FROM docs WHERE id = 1")[0][0], '{"z": 1,  "a": [1, 2], "a": 3}')


if __name__ == "__main__":
    unittest.main()
