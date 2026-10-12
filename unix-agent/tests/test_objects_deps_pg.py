"""Object restore, dependency corner cases real schemas have:
  - a sequence SHARED by two tables (not owned by either): restoring one table needs it
  - a column default calling a function of ANOTHER schema; a domain with a CHECK calling a function
  - a dropped VIEW alone (its table is fine), a dropped MATERIALIZED VIEW alone, a SEQUENCE alone
  - a table whose trigger function writes into a table that is not selected

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_objects_deps_pg -v'
"""
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_object

DB = "arca_deps"
DDL = """
CREATE SCHEMA util; CREATE SCHEMA app;
CREATE FUNCTION util.next_code() RETURNS text LANGUAGE sql AS $$ SELECT 'C' || lpad((floor(random() * 1e6))::int::text, 6, '0') $$;
CREATE FUNCTION util.is_positive(numeric) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT $1 > 0 $$;
CREATE DOMAIN app.money_pos AS numeric(12,2) CHECK (util.is_positive(VALUE));
CREATE SEQUENCE app.shared_ids;
CREATE TABLE app.customers (id bigint PRIMARY KEY DEFAULT nextval('app.shared_ids'), code text DEFAULT util.next_code(), name text);
CREATE TABLE app.suppliers (id bigint PRIMARY KEY DEFAULT nextval('app.shared_ids'), name text);
CREATE TABLE app.invoices (id serial PRIMARY KEY, customer_id bigint REFERENCES app.customers, amount app.money_pos);
CREATE TABLE app.audit_log (at timestamptz DEFAULT now(), what text);
CREATE FUNCTION app.log_invoice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO app.audit_log(what) VALUES ('invoice ' || NEW.id); RETURN NEW; END $$;
CREATE TRIGGER inv_log AFTER INSERT ON app.invoices FOR EACH ROW EXECUTE FUNCTION app.log_invoice();
INSERT INTO app.customers(name) SELECT 'c' || g FROM generate_series(1, 200) g;
INSERT INTO app.suppliers(name) SELECT 's' || g FROM generate_series(1, 50) g;
INSERT INTO app.invoices(customer_id, amount) SELECT 1 + g % 200, g * 1.25 FROM generate_series(1, 500) g;
CREATE VIEW app.big_customers AS SELECT c.id, c.name, sum(i.amount) AS total FROM app.customers c JOIN app.invoices i ON i.customer_id = c.id GROUP BY 1, 2 HAVING sum(i.amount) > 500;
CREATE TABLE app.no_pk (code text NOT NULL, region text NOT NULL, qty int, note text, UNIQUE (region, code));
INSERT INTO app.no_pk SELECT 'k' || g, CASE WHEN g % 2 = 0 THEN 'eu' ELSE 'us' END, g, 'n' || g FROM generate_series(1, 100) g;
CREATE MATERIALIZED VIEW app.mv_totals AS SELECT customer_id, count(*) AS n, sum(amount) AS total FROM app.invoices GROUP BY 1;
CREATE UNIQUE INDEX ON app.mv_totals(customer_id);
"""
S = {}


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, DDL)
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["t_ok"] = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
    S["seq"] = q(DB, "SELECT last_value FROM app.shared_ids")[0][0]
    S["view"] = q(DB, "SELECT pg_get_viewdef('app.big_customers'::regclass, true)")[0][0]
    S["mv"] = q(DB, "SELECT count(*), sum(total) FROM app.mv_totals")[0]
    time.sleep(1.2)


def tearDownModule():
    base.tearDownModule()


class Deps(unittest.TestCase):
    def go(self, objects, mode="replace", stage="pgarca_stage_deps"):
        restore_object(F.ctx, DB, objects=objects, target_time=S["t_ok"], stage_db=stage)
        return promote_object(F.ctx, stage, DB, mode=mode, drop_stage=True)

    def switch(self):
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)

    def test_01_table_using_a_shared_sequence_and_foreign_function(self):
        q(DB, "DELETE FROM app.invoices; DELETE FROM app.customers WHERE id > 100")
        self.switch()
        self.go(["%s.app.customers" % DB])
        self.assertEqual(q(DB, "SELECT count(*) FROM app.customers")[0][0], "200")
        self.assertIn("nextval('app.shared_ids'", q(DB, "SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = 'app.customers'::regclass AND adnum = 1")[0][0])
        q(DB, "INSERT INTO app.customers(name) VALUES ('new one')")           # the default still works: the shared sequence was not duplicated or reset
        self.assertGreater(int(q(DB, "SELECT max(id) FROM app.customers")[0][0]), int(S["seq"]))

    def test_02_table_with_domain_and_trigger(self):
        q(DB, "TRUNCATE app.invoices")
        self.switch()
        self.go(["%s.app.invoices" % DB])
        self.assertEqual(q(DB, "SELECT count(*) FROM app.invoices")[0][0], "500")
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'app.invoices'::regclass AND tgname = 'inv_log'")[0][0], "1")

    def test_03_view_alone(self):
        q(DB, "DROP VIEW app.big_customers")
        self.switch()
        self.go(["%s.app.big_customers" % DB], mode="missing_only")
        self.assertEqual(q(DB, "SELECT pg_get_viewdef('app.big_customers'::regclass, true)")[0][0], S["view"])

    def test_04_materialized_view_alone(self):
        q(DB, "DROP MATERIALIZED VIEW app.mv_totals")
        self.switch()
        self.go(["%s.app.mv_totals" % DB], mode="missing_only")
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_indexes WHERE tablename = 'mv_totals'")[0][0], "1")
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_matviews WHERE matviewname = 'mv_totals' AND ispopulated")[0][0], "1")

    def test_05_sequence_alone(self):
        q(DB, "DROP SEQUENCE app.shared_ids CASCADE")                      # also drops the two defaults that use it
        self.switch()
        self.go(["%s.app.shared_ids" % DB], mode="missing_only")
        self.assertGreaterEqual(int(q(DB, "SELECT last_value FROM app.shared_ids")[0][0]), int(S["seq"]))

    def test_06_rows_of_a_table_without_primary_key(self):
        # no primary key, but a UNIQUE (region, code) on NOT NULL columns: rows can be compared and recovered one by one
        from pg_arca.engine.granular import apply_rows, diff_object
        q(DB, "DELETE FROM app.no_pk WHERE qty <= 10; UPDATE app.no_pk SET note = 'changed' WHERE qty = 50")
        self.switch()
        restore_object(F.ctx, DB, objects=["%s.app.no_pk" % DB], target_time=S["t_ok"], stage_db="pgarca_stage_nopk")
        d = diff_object(F.ctx, "pgarca_stage_nopk", "%s.app.no_pk" % DB)
        self.assertEqual(d["primary_key"], ["region", "code"]); self.assertIn("unique index", d["key_from"])
        self.assertEqual((d["counts"]["missing_now"], d["counts"]["changed"]), (10, 1))
        keys = [json.dumps(x["key"]) for x in d["missing_now"]] + [json.dumps(x["key"]) for x in d["changed"]]
        r = apply_rows(F.ctx, "pgarca_stage_nopk", "%s.app.no_pk" % DB, restore_keys=keys)
        self.assertEqual((r["inserted"], r["updated"]), (10, 1))
        self.assertEqual(q(DB, "SELECT count(*), count(*) FILTER (WHERE note = 'changed') FROM app.no_pk")[0], ["100", "0"])

    def test_07_published_table_stays_published(self):
        # logical replication: after the swap the RECOVERED table must be the one in the publication (with its row filter), not the kept old copy
        major = int(q("postgres", "SHOW server_version_num")[0][0]) // 10000
        filt = " WHERE (id > 10)" if major >= 15 else ""
        q(DB, "CREATE PUBLICATION pub_sup FOR TABLE app.suppliers%s" % filt)
        q(DB, "DELETE FROM app.suppliers WHERE id > 40")
        self.switch()
        r = self.go(["%s.app.suppliers" % DB])
        self.assertIn("pub_sup: app.suppliers", r.get("publications_moved") or [], r)
        tabs = [x[0] for x in q(DB, "SELECT tablename FROM pg_publication_tables WHERE pubname = 'pub_sup'")]
        self.assertEqual(tabs, ["suppliers"])
        if major >= 15:
            self.assertIn("id > 10", q(DB, "SELECT rowfilter FROM pg_publication_tables WHERE pubname = 'pub_sup'")[0][0])

    def test_08_rules_and_policies_of_other_tables_follow(self):
        # a rule on audit_log writes into customers; a policy on invoices reads customers. Both are bound to the table by identity: after replacing
        # customers they must point at the RECOVERED table, not at the kept old copy
        q(DB, "CREATE RULE log_to_cust AS ON INSERT TO app.audit_log WHERE NEW.what LIKE 'cust:%' DO ALSO INSERT INTO app.customers(name) VALUES (substr(NEW.what, 6))")
        q(DB, "ALTER TABLE app.invoices ENABLE ROW LEVEL SECURITY; CREATE POLICY only_known ON app.invoices FOR SELECT TO PUBLIC USING (customer_id IN (SELECT id FROM app.customers))")
        q(DB, "UPDATE app.customers SET name = 'broken' WHERE id < 5")
        self.switch()
        r = self.go(["%s.app.customers" % DB])
        self.assertEqual(sorted(r.get("rules_and_policies_rebound") or []), ["app.audit_log.log_to_cust", "app.invoices.only_known"], r)
        dep = ("SELECT count(*) FROM pg_depend d JOIN %s x ON x.oid = d.objid WHERE d.refobjid = 'app.customers'::regclass AND %s")
        self.assertEqual(q(DB, dep % ("pg_rewrite", "x.rulename = 'log_to_cust'"))[0][0], "1", "the rule now depends on the recovered table")
        self.assertEqual(q(DB, dep % ("pg_policy", "x.polname = 'only_known'"))[0][0], "1", "the policy now depends on the recovered table")
        q(DB, "INSERT INTO app.audit_log(what) VALUES ('cust:via-rule')")
        self.assertEqual(q(DB, "SELECT count(*) FROM app.customers WHERE name = 'via-rule'")[0][0], "1")

    def test_09_other_table_sharing_the_replaced_tables_sequence(self):
        # invoices_archive draws its ids from invoices' OWN serial sequence: after replacing invoices both must still share ONE sequence
        q(DB, "CREATE TABLE app.invoices_archive (id int PRIMARY KEY DEFAULT nextval('app.invoices_id_seq'), note text)")
        q(DB, "DELETE FROM app.invoices WHERE id > 400")
        self.switch()
        r = self.go(["%s.app.invoices" % DB])
        self.assertIn("app.invoices_archive.id", r.get("defaults_rebound") or [], r)
        a = int(q(DB, "INSERT INTO app.invoices(customer_id, amount) VALUES (1, 10) RETURNING id")[0][0])
        b = int(q(DB, "INSERT INTO app.invoices_archive(note) VALUES ('x') RETURNING id")[0][0])
        self.assertEqual(b, a + 1, "one shared sequence, as before the restore")

    def test_10_replacing_a_table_that_changed_shape_is_said(self):
        # a migration added a column after the restore point: the plan must say that replacing brings back the old shape
        q(DB, "ALTER TABLE app.suppliers ADD COLUMN vat text")
        restore_object(F.ctx, DB, objects=["%s.app.suppliers" % DB], target_time=S["t_ok"], stage_db="pgarca_stage_shape")
        plan = promote_object(F.ctx, "pgarca_stage_shape", DB, mode="replace", dry_run=True)
        row = [r for r in plan["tables"] if r["name"] == "suppliers"][0]
        self.assertEqual(row.get("schema_drift", {}).get("columns_only_now"), ["vat"], row)
        self.assertTrue(any("changed shape" in w for w in plan["warnings"]), plan["warnings"])
        q("postgres", "DROP DATABASE pgarca_stage_shape")


if __name__ == "__main__":
    unittest.main()
