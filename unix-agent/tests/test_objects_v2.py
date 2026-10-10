"""Restore of tables / schemas with everything around them (engine/objects.py), against a REAL PostgreSQL.

Loads the restore lab database (tools/lab/testdb.sql: 2 schemas, 10 tables x 100 rows, enum + domain, identity/serial sequences, FKs inside and ACROSS schemas,
views + materialized view, trigger + function, partial indexes, generated column, comments, grants, a partitioned table), takes a backup, damages the live
database in different ways and brings it back through restore_object + promote_object. The proof is a full snapshot (row fingerprints, foreign keys,
indexes, views, triggers, comments, privileges) that must be IDENTICAL to the one taken before the damage.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_objects_v2 -v'
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
from pg_arca.engine.granular import promote_object, restore_object
from pg_arca.engine.util import EngineError

DB = "arca_restore_lab"
LAB_SQL = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tools", "lab", "testdb.sql")
S = {}


def setUpModule():
    base.setUpModule()
    r = subprocess.run([os.path.join(base.BIN, "psql"), "-X", "-q", "-h", F.sock, "-p", str(F.port), "-U", "postgres", "-d", "postgres", "-f", LAB_SQL],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    assert r.returncode == 0, r.stderr
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["t_ok"] = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
    time.sleep(1.2)
    S["base"] = snap()


def tearDownModule():
    base.tearDownModule()


def snap():
    """Everything that must come back: rows, constraints, indexes, views, triggers, comments, privileges (names of recovery leftovers are ignored)."""
    skip = r"_(old|pitr)_[0-9]"
    out = {}
    rels = q(DB, "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('shop','hr') AND c.relkind IN ('r','p','m') "
                 "AND NOT c.relispartition AND c.relname !~ '%s' ORDER BY 1,2" % skip)
    out["rows"] = {}
    for s_, t in rels:
        n, h = q(DB, "SELECT count(*), md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM %s.%s x" % (s_, t))[0]
        out["rows"]["%s.%s" % (s_, t)] = (int(n), h)
    out["constraints"] = [tuple(r) for r in q(DB, "SELECT conrelid::regclass::text, conname, contype, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace IN "
                                                   "(SELECT oid FROM pg_namespace WHERE nspname IN ('shop','hr')) AND conname !~ '%s' AND conrelid::regclass::text !~ '%s' ORDER BY 1,2" % (skip, skip))]
    out["indexes"] = [tuple(r) for r in q(DB, "SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname IN ('shop','hr') AND tablename !~ '%s' ORDER BY 1,2,3" % skip)]
    out["views"] = [tuple(r) for r in q(DB, "SELECT schemaname, viewname, definition FROM pg_views WHERE schemaname IN ('shop','hr') ORDER BY 1,2")]
    out["matviews"] = [tuple(r) for r in q(DB, "SELECT schemaname, matviewname, definition FROM pg_matviews WHERE schemaname IN ('shop','hr') ORDER BY 1,2")]
    out["triggers"] = [tuple(r) for r in q(DB, "SELECT tgrelid::regclass::text, tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text !~ '%s' ORDER BY 1,2" % skip)]
    out["functions"] = [tuple(r) for r in q(DB, "SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('shop','hr') ORDER BY 1,2")]
    out["comments"] = [tuple(r) for r in q(DB, "SELECT objoid::regclass::text, objsubid, description FROM pg_description WHERE classoid='pg_class'::regclass AND objoid::regclass::text !~ '%s' "
                                               "AND objoid IN (SELECT oid FROM pg_class WHERE relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('shop','hr'))) ORDER BY 1,2" % skip)]
    out["acl"] = [tuple(r) for r in q(DB, "SELECT n.nspname||'.'||c.relname, c.relacl::text, pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                                          "WHERE n.nspname IN ('shop','hr') AND c.relkind IN ('r','p','m','v','S') AND c.relname !~ '%s' ORDER BY 1" % skip)]
    out["types"] = [tuple(r) for r in q(DB, "SELECT n.nspname, t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('shop','hr','public') "
                                            "AND t.typtype IN ('e','d') ORDER BY 1,2")]
    return out


def seq_values():
    return dict((r[0], int(r[1] or 0)) for r in q(DB, "SELECT schemaname||'.'||sequencename, last_value FROM pg_sequences WHERE schemaname IN ('shop','hr')"))


def leftovers():
    """Safety copies the promotion keeps (renamed, never dropped) and the work schemas it must have removed."""
    return [r[0] for r in q(DB, "SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname ~ '_(old|pitr)_[0-9]' AND c.relkind IN ('r','p','m','v') "
                                "AND n.nspname IN ('shop','hr') AND NOT c.relispartition")]


def drop_leftovers():
    for r in q(DB, "SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname ~ '_(old|pitr)_[0-9]' AND c.relkind IN ('r','p','m','v') "
                   "AND n.nspname IN ('shop','hr') AND NOT c.relispartition"):
        q(DB, "DROP %s IF EXISTS %s.%s CASCADE" % ({"v": "VIEW", "m": "MATERIALIZED VIEW"}.get(r[2], "TABLE"), r[0], r[1]))


class ObjectsV2(unittest.TestCase):
    maxDiff = None

    def assertBack(self, label):
        now = snap()
        for k in S["base"]:
            if now[k] != S["base"][k]:
                a, b = now[k], S["base"][k]
                if isinstance(a, dict):
                    miss, extra = sorted(set(b) - set(a)), sorted(set(a) - set(b))
                    chg = sorted(x for x in a if x in b and a[x] != b[x])
                    self.fail("%s: '%s' differs: missing=%s extra=%s changed=%s" % (label, k, miss, extra, [(x, a[x], b[x]) for x in chg]))
                self.fail("%s: '%s' differs: missing=%s extra=%s" % (label, k, [x for x in b if x not in a], [x for x in a if x not in b]))
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'pgarca_pr_%'")[0][0], "0", "work schemas removed")
        self.assertEqual(q("postgres", "SELECT count(*) FROM pg_database WHERE datname LIKE 'pgarca_stage_%'")[0][0], "0", "quarantine database dropped")

    def go(self, objects, mode="replace", stage="pgarca_stage_t", **kw):
        r = restore_object(F.ctx, DB, objects=objects, target_time=S["t_ok"], stage_db=stage, **kw)
        p = promote_object(F.ctx, stage, DB, mode=mode, drop_stage=True)
        return r, p

    def switch(self):
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)

    # ------------------------------------------------------------------ baseline sanity
    def test_00_lab_database_is_what_we_think_it_is(self):
        b = S["base"]["rows"]
        self.assertEqual(len(b), 11)                                         # 10 tables + the materialized view (partitions are not listed)
        for k, v in b.items():
            if k != "shop.mv_sales_by_country":
                self.assertEqual(v[0], 100, k)

    # ------------------------------------------------------------------ dry run touches nothing
    def test_01_dry_run_reports_the_plan_and_changes_nothing(self):
        plan = restore_object(F.ctx, DB, objects=["%s.shop.orders" % DB], target_time=S["t_ok"], dry_run=True)
        self.assertTrue(plan["dry_run"])
        self.assertLess(plan["extract_bytes"], plan["cluster_bytes"])
        self.assertEqual(q("postgres", "SELECT count(*) FROM pg_database WHERE datname LIKE 'pgarca_stage_%'")[0][0], "0")
        with self.assertRaises(EngineError):
            restore_object(F.ctx, DB, objects=["%s.shop.does_not_exist" % DB], target_time=S["t_ok"], dry_run=True)

    # ------------------------------------------------------------------ the hard one: DROP TABLE ... CASCADE takes FKs, views and the matview with it
    def test_02_dropped_table_comes_back_with_foreign_keys_views_triggers(self):
        q(DB, "DROP TABLE shop.orders CASCADE")
        self.assertNotEqual(snap()["constraints"], S["base"]["constraints"])
        self.switch()
        r, p = self.go(["%s.shop.orders" % DB])
        self.assertEqual(r["dependencies"]["tables"], 1)
        self.assertBack("drop table orders cascade")
        # the sequence never goes backwards: orders created after t_ok must not collide with recovered ids
        q(DB, "INSERT INTO shop.orders (customer_id) VALUES (1)")
        self.assertEqual(int(q(DB, "SELECT count(*) FROM shop.orders")[0][0]), 101)
        q(DB, "DELETE FROM shop.orders WHERE id > 100")

    # ------------------------------------------------------------------ TRUNCATE ... CASCADE: three tables, chosen together
    def test_03_truncate_cascade_restores_several_tables_at_once(self):
        q(DB, "TRUNCATE shop.orders CASCADE")
        self.switch()
        self.assertEqual(int(q(DB, "SELECT count(*) FROM shop.order_items")[0][0]), 0)
        r, p = self.go(["%s.shop.orders" % DB, "%s.shop.order_items" % DB, "%s.shop.payments" % DB])
        self.assertGreaterEqual(r["dependencies"]["tables"], 3)
        self.assertBack("truncate orders cascade")

    # ------------------------------------------------------------------ wrong data (not a drop): UPDATE/DELETE on a table referenced from other tables and from itself
    def test_04_bad_update_on_a_table_with_inbound_foreign_keys(self):
        q(DB, "DELETE FROM hr.timesheets; UPDATE hr.employees SET salary = 1 WHERE id <= 50; UPDATE hr.employees SET manager_id = NULL")
        self.switch()
        r, p = self.go(["%s.hr.employees" % DB, "%s.hr.timesheets" % DB])
        self.assertBack("bad update employees")

    # ------------------------------------------------------------------ the whole schema, dropped: it is recreated with its objects, cross-schema FKs included
    def test_05_dropped_schema_comes_back(self):
        q(DB, "DROP SCHEMA hr CASCADE")
        self.switch()
        r, p = self.go(["%s.hr" % DB])
        self.assertEqual(r["dependencies"]["tables"], 4)
        self.assertBack("drop schema hr cascade")
        # the cross-schema FK to shop.customers (hr.projects.customer_id) is back and enforced
        with self.assertRaises(EngineError):
            q(DB, "INSERT INTO hr.projects (name, customer_id) VALUES ('x', 99999)")

    # ------------------------------------------------------------------ schema with live changes: replace swaps, nothing is lost silently
    def test_06_schema_replace_keeps_the_previous_version(self):
        q(DB, "UPDATE shop.customers SET full_name = 'vandalised'; DELETE FROM shop.categories WHERE id > 95 AND id NOT IN (SELECT category_id FROM shop.products)")
        self.switch()
        r, p = self.go(["%s.shop" % DB])
        self.assertBack("schema shop replaced")
        kept = leftovers()
        self.assertTrue(kept, "the replaced tables are kept under a suffixed name, never dropped")
        drop_leftovers()

    # ------------------------------------------------------------------ as_new: the original is untouched, the copy sits next to it in the same schema
    def test_07_as_new_leaves_the_original_alone(self):
        q(DB, "UPDATE shop.customers SET full_name = 'live edit' WHERE id = 1")
        self.switch()
        r, p = self.go(["%s.shop.customers" % DB], mode="as_new")
        copies = [x for x in leftovers() if x.startswith("shop.customers_pitr_")]
        self.assertEqual(len(copies), 1, leftovers())
        self.assertEqual(q(DB, "SELECT full_name FROM shop.customers WHERE id = 1")[0][0], "live edit")
        self.assertEqual(q(DB, "SELECT full_name FROM %s WHERE id = 1" % copies[0])[0][0], "Customer 1")
        self.assertEqual(int(q(DB, "SELECT count(*) FROM %s" % copies[0])[0][0]), 100)
        drop_leftovers()
        q(DB, "UPDATE shop.customers SET full_name = 'Customer 1' WHERE id = 1")

    # ------------------------------------------------------------------ missing_only: only what is gone comes back, what exists keeps today's data
    def test_08_missing_only_brings_back_only_what_is_missing(self):
        q(DB, "DROP TABLE hr.timesheets; INSERT INTO hr.departments (name, budget) VALUES ('Added after the backup', 1)")
        self.switch()
        r, p = self.go(["%s.hr" % DB], mode="missing_only")
        self.assertEqual(int(q(DB, "SELECT count(*) FROM hr.timesheets")[0][0]), 100)
        self.assertEqual(int(q(DB, "SELECT count(*) FROM hr.departments WHERE name = 'Added after the backup'")[0][0]), 1, "existing tables are left as they are")
        q(DB, "DELETE FROM hr.departments WHERE name = 'Added after the backup'")
        self.assertBack("missing only")

    # ------------------------------------------------------------------ refusals are explicit
    def test_09_refusals(self):
        with self.assertRaises(EngineError):
            promote_object(F.ctx, "not_a_stage", DB, mode="replace")
        with self.assertRaises(EngineError):
            restore_object(F.ctx, DB, objects=["%s.shop.orders" % DB, "other.public.junk"], target_time=S["t_ok"], dry_run=True)       # one database per operation
        with self.assertRaises(EngineError):
            restore_object(F.ctx, DB, objects=["%s.pg_catalog.pg_class" % DB], target_time=S["t_ok"], dry_run=True)


if __name__ == "__main__":
    unittest.main()
