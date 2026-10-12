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
"""
S = {}


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, DDL)
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


if __name__ == "__main__":
    unittest.main()
