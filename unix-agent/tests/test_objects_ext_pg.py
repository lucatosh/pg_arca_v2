"""Object restore, more corner cases from real schemas:
  - columns typed by an EXTENSION (citext, hstore) installed in its own schema
  - a column with a CUSTOM collation (CREATE COLLATION)
  - a table whose whole SCHEMA was dropped after the backup
  - a table whose owner ROLE no longer exists
  - a column typed by ANOTHER table's row type
  - row recovery on a table with a GENERATED column and an identity ALWAYS key

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_objects_ext_pg -v'
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
from pg_arca.engine.granular import apply_rows, diff_object, promote_object, restore_object

DB = "arca_ext"
DDL = """
CREATE SCHEMA ext; CREATE SCHEMA app; CREATE SCHEMA gone;
CREATE EXTENSION citext SCHEMA ext; CREATE EXTENSION hstore SCHEMA ext;
CREATE COLLATION app.nocase (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
CREATE ROLE arca_owner_tmp;
CREATE TABLE app.users (id int PRIMARY KEY, email ext.citext UNIQUE, attrs ext.hstore, nick text COLLATE app.nocase);
INSERT INTO app.users SELECT g, 'User' || g || '@X.org', ('k=>' || g)::ext.hstore, 'Nick' || g FROM generate_series(1, 100) g;
CREATE TABLE gone.notes (id int PRIMARY KEY, body text);
INSERT INTO gone.notes SELECT g, 'note ' || g FROM generate_series(1, 30) g;
CREATE TABLE app.owned (id int PRIMARY KEY, v text);
INSERT INTO app.owned SELECT g, 'v' || g FROM generate_series(1, 40) g;
ALTER TABLE app.owned OWNER TO arca_owner_tmp;
CREATE TABLE app.addr (street text, zip text);
CREATE TABLE app.shipments (id int PRIMARY KEY, dest app.addr);
INSERT INTO app.shipments SELECT g, ROW('via ' || g, lpad(g::text, 5, '0'))::app.addr FROM generate_series(1, 25) g;
CREATE TABLE app.lines (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, qty int, price numeric, total numeric GENERATED ALWAYS AS (qty * price) STORED);
INSERT INTO app.lines(qty, price) SELECT g, g * 0.5 FROM generate_series(1, 60) g;
CREATE TABLE app.a_owner (id serial PRIMARY KEY, v text);
CREATE TABLE app.b_borrower (id int PRIMARY KEY DEFAULT nextval('app.a_owner_id_seq'), v text);
INSERT INTO app.a_owner(v) SELECT 'a' || g FROM generate_series(1, 20) g; INSERT INTO app.b_borrower(v) SELECT 'b' || g FROM generate_series(1, 20) g;
CREATE TABLE app.cust (id int PRIMARY KEY, name text);
INSERT INTO app.cust SELECT g, 'c' || g FROM generate_series(1, 30) g;
CREATE TABLE app.orders_p (id int, cust_id int REFERENCES app.cust(id), at date NOT NULL, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE app.orders_p2025 PARTITION OF app.orders_p FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE app.orders_p2026 PARTITION OF app.orders_p FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
INSERT INTO app.orders_p SELECT g, 1 + g % 30, date '2025-06-01' + g * 3 FROM generate_series(1, 120) g;
CREATE ROLE arca_view_owner NOLOGIN; CREATE ROLE arca_view_reader NOLOGIN;
GRANT USAGE ON SCHEMA app TO arca_view_owner; GRANT SELECT, UPDATE ON app.cust TO arca_view_owner;
CREATE VIEW app.cust_v WITH (security_barrier = true) AS SELECT id, name FROM app.cust WHERE id > 5 WITH LOCAL CHECK OPTION;
ALTER VIEW app.cust_v OWNER TO arca_view_owner; GRANT SELECT ON app.cust_v TO arca_view_reader;
COMMENT ON VIEW app.cust_v IS 'customers for reporting';
CREATE TABLE app.prod (id int PRIMARY KEY, name text, price numeric);
INSERT INTO app.prod SELECT g, 'p' || g, g FROM generate_series(1, 40) g;
CREATE FUNCTION app.cheap_prods(maxp numeric) RETURNS SETOF app.prod LANGUAGE sql STABLE AS $$ SELECT * FROM app.prod WHERE price <= maxp $$;
CREATE FUNCTION app.prod_label(p app.prod) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT p.name || ' @ ' || p.price $$;
CREATE TABLE app.prod_snap (at timestamptz DEFAULT now(), item app.prod);
CREATE TABLE app.stock (sku int PRIMARY KEY, qty int);
INSERT INTO app.stock SELECT g, g * 2 FROM generate_series(1, 25) g;
CREATE UNLOGGED TABLE app.sessions (id int PRIMARY KEY, token text);
CREATE TABLE app.warehouse (id int PRIMARY KEY, name text);
INSERT INTO app.warehouse SELECT g, 'w' || g FROM generate_series(1, 5) g;
CREATE TABLE app.moves (id serial PRIMARY KEY, wh int, qty int);
CREATE FUNCTION app.check_wh() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS (SELECT 1 FROM app.warehouse WHERE id = NEW.wh) THEN RAISE EXCEPTION 'no warehouse %', NEW.wh; END IF; RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER moves_wh AFTER INSERT OR UPDATE ON app.moves FROM app.warehouse DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_wh();
INSERT INTO app.sessions SELECT g, md5(g::text) FROM generate_series(1, 50) g;
"""
S = {}


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, DDL)
    if int(q("postgres", "SHOW server_version_num")[0][0]) >= 140000:            # SQL-standard function bodies: bound to the table by identity, like a view
        q(DB, "CREATE FUNCTION app.stock_total() RETURNS bigint LANGUAGE sql STABLE BEGIN ATOMIC SELECT sum(qty) FROM app.stock; END;"
              "CREATE PROCEDURE app.stock_bump(n int) LANGUAGE sql BEGIN ATOMIC UPDATE app.stock SET qty = qty + n; END;")
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["t_ok"] = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
    S["users"] = q(DB, "SELECT md5(string_agg(id || email::text || attrs::text || nick, ',' ORDER BY id)) FROM app.users")[0][0]
    S["lines"] = q(DB, "SELECT md5(string_agg(id || ':' || qty || ':' || price || ':' || total, ',' ORDER BY id)) FROM app.lines")[0][0]
    time.sleep(1.2)


def tearDownModule():
    base.tearDownModule()


class Ext(unittest.TestCase):
    def go(self, objects, mode="replace", stage="pgarca_stage_ext"):
        restore_object(F.ctx, DB, objects=objects, target_time=S["t_ok"], stage_db=stage)
        return promote_object(F.ctx, stage, DB, mode=mode, drop_stage=True)

    def switch(self):
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)

    def test_01_extension_types_and_custom_collation(self):
        q(DB, "DELETE FROM app.users WHERE id > 50; UPDATE app.users SET nick = 'x'")
        self.switch()
        self.go(["%s.app.users" % DB])
        self.assertEqual(q(DB, "SELECT md5(string_agg(id || email::text || attrs::text || nick, ',' ORDER BY id)) FROM app.users")[0][0], S["users"])
        self.assertEqual(q(DB, "SELECT count(*) FROM app.users WHERE email OPERATOR(ext.=) 'user7@x.ORG'::ext.citext")[0][0], "1")          # citext comparison still case-insensitive
        self.assertEqual(q(DB, "SELECT count(*) FROM app.users WHERE nick = 'NICK7'")[0][0], "1")                # nondeterministic collation kept
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_extension WHERE extname IN ('citext', 'hstore')")[0][0], "2")

    def test_02_table_whose_schema_was_dropped(self):
        q(DB, "DROP SCHEMA gone CASCADE")
        self.switch()
        self.go(["%s.gone.notes" % DB], mode="missing_only")
        self.assertEqual(q(DB, "SELECT count(*) FROM gone.notes")[0][0], "30")

    def test_03_owner_role_gone(self):
        q(DB, "DROP TABLE app.owned")
        q("postgres", "DROP ROLE arca_owner_tmp")
        self.switch()
        r = self.go(["%s.app.owned" % DB], mode="missing_only")
        self.assertEqual(q(DB, "SELECT count(*) FROM app.owned")[0][0], "40")
        self.assertTrue(json.dumps(r).find("arca_owner_tmp") >= 0, "the missing owner should be reported: %s" % json.dumps(r)[:600])

    def test_04_column_of_another_tables_row_type(self):
        q(DB, "DELETE FROM app.shipments WHERE id > 5")
        self.switch()
        self.go(["%s.app.shipments" % DB])
        self.assertEqual(q(DB, "SELECT count(*), max((dest).zip) FROM app.shipments")[0], ["25", "00025"])
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_class WHERE relname = 'addr' AND relnamespace = 'app'::regnamespace")[0][0], "1")

    def test_05_rows_with_generated_and_identity_always(self):
        q(DB, "DELETE FROM app.lines WHERE id <= 10; UPDATE app.lines SET qty = 0 WHERE id = 20")
        self.switch()
        restore_object(F.ctx, DB, objects=["%s.app.lines" % DB], target_time=S["t_ok"], stage_db="pgarca_stage_gen")
        d = diff_object(F.ctx, "pgarca_stage_gen", "%s.app.lines" % DB)
        self.assertEqual((d["counts"]["missing_now"], d["counts"]["changed"]), (10, 1))
        keys = [json.dumps(x["key"]) for x in d["missing_now"]] + [json.dumps(x["key"]) for x in d["changed"]]
        r = apply_rows(F.ctx, "pgarca_stage_gen", "%s.app.lines" % DB, restore_keys=keys)
        self.assertEqual((r["inserted"], r["updated"]), (10, 1))
        self.assertEqual(q(DB, "SELECT md5(string_agg(id || ':' || qty || ':' || price || ':' || total, ',' ORDER BY id)) FROM app.lines")[0][0], S["lines"])
        q(DB, "INSERT INTO app.lines(qty, price) VALUES (1, 1)")                       # identity still ahead of the restored ids
        q("postgres", "DROP DATABASE IF EXISTS pgarca_stage_gen")

    def test_06_row_type_table_gone_is_refused_then_both_come_back(self):
        from pg_arca.engine.util import EngineError
        q(DB, "DROP TABLE app.addr CASCADE")                                          # also drops the column shipments.dest
        self.switch()
        restore_object(F.ctx, DB, objects=["%s.app.shipments" % DB], target_time=S["t_ok"], stage_db="pgarca_stage_rt")
        with self.assertRaises(EngineError) as cm:
            promote_object(F.ctx, "pgarca_stage_rt", DB, mode="replace", drop_stage=False)
        self.assertIn("app.addr", cm.exception.message)
        q("postgres", "DROP DATABASE pgarca_stage_rt")
        self.go(["%s.app.addr" % DB, "%s.app.shipments" % DB])
        self.assertEqual(q(DB, "SELECT count(*), max((dest).zip) FROM app.shipments")[0], ["25", "00025"])

    def test_07_extensions_and_collation_dropped_with_the_table(self):
        q(DB, "DO $$DECLARE r record; BEGIN FOR r IN SELECT relname FROM pg_class WHERE relname LIKE 'users_old_%' AND relkind = 'r' LOOP EXECUTE format('DROP TABLE app.%I', r.relname); END LOOP; END$$")
        q(DB, "DROP TABLE app.users; DROP EXTENSION citext; DROP EXTENSION hstore; DROP COLLATION app.nocase")
        self.switch()
        self.go(["%s.app.users" % DB], mode="missing_only")
        self.assertEqual(q(DB, "SELECT md5(string_agg(id || email::text || attrs::text || nick, ',' ORDER BY id)) FROM app.users")[0][0], S["users"])
        self.assertEqual(q(DB, "SELECT string_agg(e.extname || '@' || n.nspname, ',' ORDER BY 1) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE extname IN ('citext','hstore')")[0][0],
                         "citext@ext,hstore@ext")
        self.assertEqual(q(DB, "SELECT count(*) FROM app.users WHERE nick = 'NICK7'")[0][0], "1")

    VIEWQ = ("SELECT pg_get_viewdef('app.cust_v'::regclass, true), pg_get_userbyid(c.relowner), c.relacl::text, array_to_string(c.reloptions, ','), "
             "obj_description(c.oid, 'pg_class') FROM pg_class c WHERE c.oid = 'app.cust_v'::regclass")

    def test_08_default_borrowing_another_tables_owned_sequence(self):
        q(DB, "DELETE FROM app.b_borrower WHERE id > 30")
        self.switch()
        before = int(q(DB, "SELECT last_value FROM app.a_owner_id_seq")[0][0])
        self.go(["%s.app.b_borrower" % DB])
        self.assertEqual(q(DB, "SELECT count(*) FROM app.b_borrower")[0][0], "20")
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_class WHERE relname LIKE 'a_owner_id_seq%' AND relkind = 'S'")[0][0], "1", "no second copy of A's sequence")
        self.assertGreaterEqual(int(q(DB, "SELECT last_value FROM app.a_owner_id_seq")[0][0]), before, "the shared sequence never goes back")
        self.assertEqual(q(DB, "SELECT d.refobjid::regclass::text FROM pg_depend d WHERE d.objid = 'app.a_owner_id_seq'::regclass AND d.deptype = 'a'")[0][0], "app.a_owner",
                         "A still owns its sequence")
        q(DB, "INSERT INTO app.b_borrower(v) VALUES ('new'); INSERT INTO app.a_owner(v) VALUES ('new')")

    def test_09_inbound_fk_from_a_partitioned_table(self):
        S["view"] = q(DB, self.VIEWQ)
        q(DB, "UPDATE app.cust SET name = 'x'")
        self.switch()
        self.go(["%s.app.cust" % DB])
        self.assertEqual(q(DB, "SELECT count(*) FROM app.cust WHERE name = 'x'")[0][0], "0")
        fk = q(DB, "SELECT conrelid::regclass::text, confrelid::regclass::text, convalidated FROM pg_constraint WHERE contype = 'f' AND conrelid = 'app.orders_p'::regclass")
        self.assertEqual(fk, [["app.orders_p", "app.cust", "t"]], "the FK of the partitioned table points at the restored table")
        n = q(DB, "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND confrelid = 'app.cust'::regclass AND conrelid IN ('app.orders_p2025'::regclass, 'app.orders_p2026'::regclass)")[0][0]
        self.assertEqual(n, "2", "and so do its partitions")
        from pg_arca.engine.util import EngineError
        with self.assertRaises(EngineError):
            q(DB, "INSERT INTO app.orders_p VALUES (999, 9999, '2025-07-01')")

    def test_10_dependent_view_keeps_owner_grants_options_comment(self):
        self.assertEqual(q(DB, self.VIEWQ), S["view"])

    def test_11_functions_and_columns_using_the_restored_tables_row_type(self):
        q(DB, "DELETE FROM app.prod WHERE id > 10")
        self.switch()
        r = self.go(["%s.app.prod" % DB])
        self.assertEqual(q(DB, "SELECT count(*) FROM app.cheap_prods(100)")[0][0], "40")
        self.assertEqual(q(DB, "SELECT app.prod_label(p) FROM app.prod p WHERE id = 33")[0][0], "p33 @ 33")
        self.assertEqual(sorted(r.get("functions_rebound") or []), ["app.cheap_prods(numeric)", "app.prod_label(app.prod)"], r)
        self.assertTrue(any("app.prod_snap.item" in w and "::text::app.prod" in w for w in r["plan"]["warnings"]), r["plan"]["warnings"])
        self.assertFalse([w for w in r["plan"]["warnings"] if "prerequisite not recreated" in w], "no noise from the quarantine's first pass")
        old = q(DB, "SELECT relname FROM pg_class WHERE relname LIKE 'prod_old_%' AND relkind = 'r'")[0][0]
        typ = q(DB, "SELECT prorettype::regtype::text FROM pg_proc WHERE proname = 'cheap_prods'")[0][0]
        self.assertEqual(typ, "app.prod", "the function returns the RESTORED table's type, not the old copy's")
        q(DB, "ALTER TABLE app.prod_snap ALTER COLUMN item TYPE app.prod USING item::text::app.prod")      # the command the warning gives
        q(DB, "DROP TABLE app.%s" % old)                                                # cleaning the old copy up must not need CASCADE
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_proc WHERE proname IN ('cheap_prods', 'prod_label')")[0][0], "2")

    def test_12_sql_standard_bodies_follow_the_restored_table(self):
        if int(q("postgres", "SHOW server_version_num")[0][0]) < 140000:
            self.skipTest("BEGIN ATOMIC needs PostgreSQL 14")
        q(DB, "DELETE FROM app.stock WHERE sku > 5")
        self.switch()
        r = self.go(["%s.app.stock" % DB])
        self.assertEqual(q(DB, "SELECT app.stock_total()")[0][0], str(sum(g * 2 for g in range(1, 26))), "the function reads the RESTORED table")
        q(DB, "CALL app.stock_bump(1)")
        self.assertEqual(q(DB, "SELECT sum(qty) FROM app.stock")[0][0], str(sum(g * 2 + 1 for g in range(1, 26))), "the procedure writes the RESTORED table")
        old = q(DB, "SELECT relname FROM pg_class WHERE relname LIKE 'stock_old_%' AND relkind = 'r'")[0][0]
        q(DB, "DROP TABLE app.%s" % old)
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_proc WHERE proname IN ('stock_total', 'stock_bump')")[0][0], "2")

    def test_13_unlogged_table_is_never_replaced_by_an_empty_copy(self):
        # UNLOGGED data is in no backup: the recovered copy is empty. Replacing the live table would only lose its rows.
        q(DB, "INSERT INTO app.sessions VALUES (999, 'live')")
        self.switch()
        restore_object(F.ctx, DB, objects=["%s.app.sessions" % DB], target_time=S["t_ok"], stage_db="pgarca_stage_unl")
        plan = promote_object(F.ctx, "pgarca_stage_unl", DB, mode="replace", dry_run=True)
        row = [t for t in plan["tables"] if t["name"] == "sessions"][0]
        self.assertEqual(row["action"], "skip", plan)
        self.assertTrue(any("sessions" in w and "UNLOGGED" in w for w in plan["warnings"]), plan["warnings"])
        from pg_arca.engine.util import EngineError
        with self.assertRaises(EngineError) as cm:                        # row recovery would call every live row "added since"
            diff_object(F.ctx, "pgarca_stage_unl", "%s.app.sessions" % DB)
        self.assertEqual(cm.exception.code, "PGA-GEN-095")
        promote_object(F.ctx, "pgarca_stage_unl", DB, mode="replace", drop_stage=True)
        self.assertEqual(q(DB, "SELECT count(*) FROM app.sessions")[0][0], "51", "the live rows are still there")
        q(DB, "DROP TABLE app.sessions")
        restore_object(F.ctx, DB, objects=["%s.app.sessions" % DB], target_time=S["t_ok"], stage_db="pgarca_stage_unl2")
        r = promote_object(F.ctx, "pgarca_stage_unl2", DB, mode="missing_only", drop_stage=True)
        self.assertEqual(q(DB, "SELECT relpersistence FROM pg_class WHERE oid = 'app.sessions'::regclass")[0][0], "u", "comes back as UNLOGGED (structure), empty")
        self.assertTrue(any("UNLOGGED" in w for w in (r.get("plan") or {}).get("warnings", [])), r)

    def test_14_constraint_trigger_of_another_table_follows_the_restored_table(self):
        q(DB, "DELETE FROM app.warehouse WHERE id > 3")
        self.switch()
        self.go(["%s.app.warehouse" % DB])
        self.assertEqual(q(DB, "SELECT tgconstrrelid::regclass::text FROM pg_trigger WHERE tgname = 'moves_wh'")[0][0], "app.warehouse", "FROM points at the restored table")
        old = q(DB, "SELECT relname FROM pg_class WHERE relname LIKE 'warehouse_old_%' AND relkind = 'r'")[0][0]
        q(DB, "DROP TABLE app.%s" % old)                                           # the old copy can be dropped without CASCADE
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_trigger WHERE tgname = 'moves_wh'")[0][0], "1")
        q(DB, "INSERT INTO app.moves (wh, qty) VALUES (5, 1)")


if __name__ == "__main__":
    unittest.main()
