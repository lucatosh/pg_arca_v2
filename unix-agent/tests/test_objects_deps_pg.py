"""Object restore, dependency corner cases real schemas have:
  - a sequence SHARED by two tables (not owned by either): restoring one table needs it
  - a column default calling a function of ANOTHER schema; a domain with a CHECK calling a function
  - a dropped VIEW alone (its table is fine), a dropped MATERIALIZED VIEW alone, a SEQUENCE alone
  - a table whose trigger function writes into a table that is not selected

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_objects_deps_pg -v'
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


if __name__ == "__main__":
    unittest.main()
