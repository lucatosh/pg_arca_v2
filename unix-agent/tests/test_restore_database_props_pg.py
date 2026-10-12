"""restore_database must bring back the DATABASE itself, not only its contents: what pg_dump (without --create) leaves out lives in pg_database /
pg_db_role_setting / pg_shdescription - owner, privileges (CONNECT/CREATE/TEMP), connection limit, database-wide settings (ALTER DATABASE ... SET),
per-role settings in that database (ALTER ROLE ... IN DATABASE ... SET), comment, ICU locale provider and locale.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_restore_database_props_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_database

S = {}
PROPS = ("SELECT pg_get_userbyid(d.datdba), d.datconnlimit, coalesce(d.datacl::text, ''), pg_encoding_to_char(d.encoding), d.datcollate, d.datctype, "
         "coalesce(shobj_description(d.oid, 'pg_database'), '') FROM pg_database d WHERE d.datname = '%s'")
SETTINGS = ("SELECT coalesce(pg_get_userbyid(nullif(s.setrole, 0)), '*'), array_to_string(s.setconfig, ',') FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase "
            "WHERE d.datname = '%s' ORDER BY 1")


def icu(db):
    major = int(q("postgres", "SHOW server_version_num")[0][0]) // 10000
    if major < 15:
        return None
    col = "datlocale" if major >= 17 else "daticulocale"
    return q("postgres", "SELECT datlocprovider, %s FROM pg_database WHERE datname = '%s'" % (col, db))[0]


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE ROLE app_owner NOLOGIN; CREATE ROLE app_reader NOLOGIN")
    major = int(q("postgres", "SHOW server_version_num")[0][0]) // 10000
    has_icu = q("postgres", "SELECT count(*) FROM pg_collation WHERE collprovider = 'i'")[0][0] != "0"
    S["icu"] = major >= 15 and has_icu
    loc = " LOCALE_PROVIDER icu ICU_LOCALE 'it-IT'" if S["icu"] else ""
    q("postgres", "CREATE DATABASE props_db OWNER app_owner TEMPLATE template0 ENCODING 'UTF8'%s CONNECTION LIMIT 42" % loc)
    q("postgres", "COMMENT ON DATABASE props_db IS 'billing, keep forever'")
    q("postgres", "REVOKE CONNECT, TEMPORARY ON DATABASE props_db FROM PUBLIC; GRANT CONNECT ON DATABASE props_db TO app_reader")
    q("postgres", "ALTER DATABASE props_db SET search_path = app, public; ALTER DATABASE props_db SET statement_timeout = '30s'")
    q("postgres", "ALTER ROLE app_reader IN DATABASE props_db SET work_mem = '64MB'")
    q("props_db", "CREATE SCHEMA app AUTHORIZATION app_owner; CREATE TABLE app.t (id int PRIMARY KEY, name text); INSERT INTO app.t SELECT g, 'n' || g FROM generate_series(1, 100) g;"
                  "ALTER TABLE app.t OWNER TO app_owner; GRANT SELECT ON app.t TO app_reader; GRANT USAGE ON SCHEMA app TO app_reader;"
                  "ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app GRANT SELECT ON TABLES TO app_reader")
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(2)


def tearDownModule():
    base.tearDownModule()


class DbProps(unittest.TestCase):
    maxDiff = None

    def test_01_restored_database_keeps_its_properties(self):
        r = restore_database(F.ctx, "props_db", new_name="props_back")
        self.assertEqual(r["result_database"], "props_back")
        a, b = q("postgres", PROPS % "props_db")[0], q("postgres", PROPS % "props_back")[0]
        self.assertEqual(b[0], a[0], "owner")
        self.assertEqual(b[1], a[1], "connection limit")
        self.assertEqual(b[2].replace("props_back", "props_db"), a[2], "privileges")
        self.assertEqual(b[3:6], a[3:6], "encoding/collation")
        self.assertEqual(b[6], a[6], "comment")
        self.assertEqual(q("postgres", SETTINGS % "props_back"), q("postgres", SETTINGS % "props_db"), "ALTER DATABASE / ALTER ROLE IN DATABASE settings")
        if S["icu"]:
            self.assertEqual(icu("props_back"), icu("props_db"), "ICU locale provider")
        self.assertEqual(q("props_back", "SELECT count(*) FROM app.t")[0][0], "100")
        own = "SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner), coalesce(c.relacl::text, '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' ORDER BY 2"
        self.assertEqual(q("props_back", own), q("props_db", own), "object owners and privileges (pg_restore used to run with --no-owner --no-acl)")
        self.assertTrue(r.get("owners_and_privileges"), r)

    def test_02_missing_role_is_reported_not_fatal(self):
        q("props_db", "CREATE ROLE gone_role NOLOGIN; GRANT SELECT ON app.t TO gone_role")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        t = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
        time.sleep(1.2)
        q("props_db", "REVOKE ALL ON app.t FROM gone_role")
        q("postgres", "DROP ROLE gone_role")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        r = restore_database(F.ctx, "props_db", target_time=t, new_name="props_back2")
        self.assertFalse(r.get("owners_and_privileges"))
        self.assertTrue(any("gone_role" in w for w in r.get("warnings") or []), r.get("warnings"))
        self.assertEqual(q("props_back2", "SELECT count(*) FROM app.t")[0][0], "100")

    def test_03_database_living_in_a_tablespace(self):
        # a database whose DEFAULT tablespace is not pg_default, with one table in a third tablespace: both must stay where they were
        for n in ("ts_db", "ts_hot"):
            d = os.path.join(F.base, n)
            os.makedirs(d, exist_ok=True)
            q("postgres", "CREATE TABLESPACE %s LOCATION '%s'" % (n, d))
        q("postgres", "CREATE DATABASE ts_app TABLESPACE ts_db")
        q("ts_app", "CREATE TABLE cold AS SELECT g AS id FROM generate_series(1, 1000) g; CREATE TABLE hot (id int PRIMARY KEY) TABLESPACE ts_hot; INSERT INTO hot SELECT generate_series(1, 500)")
        run_backup(F.ctx, "full")                    # a FULL: tablespaces created after the full are refused on this host (see test_tablespace_later_pg)
        time.sleep(1.2)
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        r = restore_database(F.ctx, "ts_app", new_name="ts_app_back")
        self.assertEqual(q("postgres", "SELECT t.spcname FROM pg_database d JOIN pg_tablespace t ON t.oid = d.dattablespace WHERE d.datname = 'ts_app_back'")[0][0], "ts_db",
                         "the restored database keeps its default tablespace")
        self.assertEqual(q("ts_app_back", "SELECT coalesce(t.spcname, 'default') FROM pg_class c LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace WHERE c.relname = 'hot'")[0][0], "ts_hot")
        self.assertEqual(q("ts_app_back", "SELECT (SELECT count(*) FROM cold) + (SELECT count(*) FROM hot)")[0][0], "1500")
        self.assertTrue(r)

    def test_04_interrupted_restore_leaves_a_marked_database(self):
        # the agent dies while pg_restore fills the new database (simulated: pg_restore fails and the cleanup never runs): the copy must say it is INCOMPLETE
        from pg_arca.engine import granular
        from pg_arca.engine.util import EngineError
        orig_restore, orig_drop = granular._pg_restore, granular._drop_db

        def boom(*a, **k):
            raise EngineError("PGA-TEST-001", "agent killed")
        granular._pg_restore, granular._drop_db = boom, (lambda *a, **k: None)
        try:
            with self.assertRaises(EngineError):
                restore_database(F.ctx, "props_db", new_name="props_half")
        finally:
            granular._pg_restore, granular._drop_db = orig_restore, orig_drop
        c = q("postgres", "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'props_half'")[0][0]
        self.assertTrue(c.startswith("pg_arca: restore IN PROGRESS"), c)
        from pg_arca.db_client import PostgresClient
        snap = PostgresClient(user="postgres", port=F.port, socket_dir=F.sock).get_snapshot()
        self.assertTrue([d for d in snap["databases"] if d["name"] == "props_half"][0].get("restoring"), "telemetry flags it")
        self.assertFalse([d for d in snap["databases"] if d["name"] == "props_back"][0].get("restoring"), "a completed restore carries no marker")


if __name__ == "__main__":
    unittest.main()
