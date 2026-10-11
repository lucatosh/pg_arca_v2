"""Hunting limits of object restore (restore_object + promote_object) with the objects real applications have and the lab database does not:
quoted / mixed-case / unicode / 63-character names, row level security, unlogged tables, identity ALWAYS, exclusion constraints, deferrable foreign keys,
plain inheritance, multi-level partitioning, extended statistics, rules, triggers with WHEN, column privileges, NOT VALID checks, a table in another
tablespace. Each case: build -> backup -> damage -> restore (replace) -> the catalog definition and the rows must be IDENTICAL to before.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_objects_exotic_pg -v'
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

DB = "arca_exotic"
SCH = 'Ex Ötic'                      # a schema name that needs quoting everywhere (space, uppercase, non-ASCII)
QS = '"Ex Ötic"'
LONG = "t_" + "x" * 61               # 63 characters: the limit of an identifier (the work names derived from it must still fit)

DDL = """
CREATE SCHEMA %(s)s;
CREATE TYPE %(s)s."Mood" AS ENUM ('ok', 'meh');
CREATE TABLE %(s)s."Parent" (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "Name" text NOT NULL, mood %(s)s."Mood" DEFAULT 'ok', tags text[]);
CREATE TABLE %(s)s."Child" (extra int) INHERITS (%(s)s."Parent");
CREATE TABLE %(s)s.room_booking (id serial PRIMARY KEY, room int NOT NULL, during tsrange NOT NULL, EXCLUDE USING gist (during WITH &&) WHERE (room IS NOT NULL));
CREATE TABLE %(s)s.secret (id int PRIMARY KEY, owner_name text NOT NULL, payload text, CHECK (length(payload) < 1000) NOT VALID);
ALTER TABLE %(s)s.secret ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON %(s)s.secret USING (owner_name = current_user);
CREATE UNLOGGED TABLE %(s)s.cache (k text PRIMARY KEY, v jsonb);
CREATE TABLE %(s)s.orders (id int, made date NOT NULL, region text NOT NULL, amount numeric(12,2), PRIMARY KEY (id, made, region)) PARTITION BY RANGE (made);
CREATE TABLE %(s)s.orders_2025 PARTITION OF %(s)s.orders FOR VALUES FROM ('2025-01-01') TO ('2026-01-01') PARTITION BY LIST (region);
CREATE TABLE %(s)s.orders_2025_eu PARTITION OF %(s)s.orders_2025 FOR VALUES IN ('eu');
CREATE TABLE %(s)s.orders_2025_us PARTITION OF %(s)s.orders_2025 FOR VALUES IN ('us');
CREATE TABLE %(s)s.lines (id bigint PRIMARY KEY, parent_id int REFERENCES %(s)s."Parent"(id) DEFERRABLE INITIALLY DEFERRED, qty int, price numeric, total numeric GENERATED ALWAYS AS (qty * price) STORED);
CREATE STATISTICS %(s)s.lines_dep (dependencies) ON qty, price FROM %(s)s.lines;
CREATE TABLE %(s)s.audit (at timestamptz DEFAULT now(), what text);
CREATE RULE lines_audit AS ON DELETE TO %(s)s.lines DO ALSO INSERT INTO %(s)s.audit(what) VALUES ('deleted ' || OLD.id);
CREATE FUNCTION %(s)s.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.qty := coalesce(NEW.qty, 0); RETURN NEW; END $$;
CREATE TRIGGER lines_touch BEFORE INSERT OR UPDATE ON %(s)s.lines FOR EACH ROW WHEN (NEW.qty IS NULL) EXECUTE FUNCTION %(s)s.touch();
CREATE TABLE %(s)s.%(long)s (id int PRIMARY KEY, v text);
CREATE INDEX ON %(s)s.%(long)s (v);
CREATE ROLE exotic_reader NOLOGIN;
GRANT USAGE ON SCHEMA %(s)s TO exotic_reader;
GRANT SELECT (id, "Name") ON %(s)s."Parent" TO exotic_reader;
COMMENT ON COLUMN %(s)s.lines.total IS 'qty × price';
INSERT INTO %(s)s."Parent"("Name", tags) SELECT 'p' || g, ARRAY['a', 'b' || g] FROM generate_series(1, 300) g;
INSERT INTO %(s)s."Child"(id, "Name", extra) SELECT 1000 + g, 'c' || g, g FROM generate_series(1, 50) g;
INSERT INTO %(s)s.room_booking(room, during) SELECT g %% 10, tsrange(timestamp '2025-01-01' + (g || ' hours')::interval, timestamp '2025-01-01' + (g || ' hours')::interval + interval '30 minutes') FROM generate_series(1, 200) g;
INSERT INTO %(s)s.secret SELECT g, 'postgres', 'secret ' || g FROM generate_series(1, 100) g;
INSERT INTO %(s)s.orders SELECT g, date '2025-01-01' + (g %% 300), CASE WHEN g %% 2 = 0 THEN 'eu' ELSE 'us' END, g * 1.5 FROM generate_series(1, 1000) g;
INSERT INTO %(s)s.lines(id, parent_id, qty, price) SELECT g, 1 + g %% 300, g %% 7, 2.5 FROM generate_series(1, 2000) g;
INSERT INTO %(s)s.%(long)s SELECT g, 'v' || g FROM generate_series(1, 100) g;
""" % {"s": QS, "long": LONG}


def snap():
    """The definition of every relation of the schema as PostgreSQL itself prints it, plus the rows. Restored objects must match exactly."""
    lit = "'%s'" % SCH.replace("'", "''")
    out = {}
    out["relations"] = q(DB, "SELECT c.relname, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity, c.relispartition, "
                             "coalesce(pg_get_expr(c.relpartbound, c.oid), '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                             "WHERE n.nspname = %s AND c.relkind IN ('r','p','v','m','S','f') AND c.relname !~ '_(old|pitr)_[0-9]' ORDER BY 1" % lit)
    out["columns"] = q(DB, "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated, "
                           "coalesce(pg_get_expr(d.adbin, d.adrelid), ''), coalesce(col_description(c.oid, a.attnum), ''), coalesce(a.attacl::text, '') "
                           "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum "
                           "WHERE n.nspname = %s AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p') AND c.relname !~ '_(old|pitr)_[0-9]' ORDER BY 1, a.attnum" % lit)
    out["constraints"] = q(DB, "SELECT conrelid::regclass::text, conname, contype, pg_get_constraintdef(oid), condeferrable, condeferred, convalidated FROM pg_constraint "
                               "WHERE connamespace = (SELECT oid FROM pg_namespace WHERE nspname = %s) AND conrelid::regclass::text !~ '_(old|pitr)_[0-9]' ORDER BY 1, 2" % lit)
    out["indexes"] = q(DB, "SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = %s AND tablename !~ '_(old|pitr)_[0-9]' ORDER BY 1, 2" % lit)
    out["policies"] = q(DB, "SELECT tablename, policyname, permissive, roles::text, cmd, coalesce(qual, ''), coalesce(with_check, '') FROM pg_policies WHERE schemaname = %s AND tablename !~ '_(old|pitr)_[0-9]' ORDER BY 1, 2" % lit)
    out["triggers"] = q(DB, "SELECT tgrelid::regclass::text, pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN "
                            "(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = %s AND c.relname !~ '_(old|pitr)_[0-9]') ORDER BY 1, 2" % lit)
    out["rules"] = q(DB, "SELECT tablename, rulename, definition FROM pg_rules WHERE schemaname = %s AND tablename !~ '_(old|pitr)_[0-9]' ORDER BY 1, 2" % lit)
    out["statistics"] = q(DB, "SELECT stxname, pg_get_statisticsobjdef(oid) FROM pg_statistic_ext WHERE stxnamespace = (SELECT oid FROM pg_namespace WHERE nspname = %s) AND stxname !~ '_(old|pitr)_[0-9]' ORDER BY 1" % lit)
    out["inherits"] = q(DB, "SELECT inhrelid::regclass::text, inhparent::regclass::text FROM pg_inherits WHERE inhrelid IN "
                            "(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = %s AND c.relname !~ '_(old|pitr)_[0-9]') ORDER BY 1" % lit)
    out["rows"] = {}
    for (rel,) in q(DB, "SELECT format('%%I.%%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = %s "
                        "AND c.relkind IN ('r') AND c.relname !~ '_(old|pitr)_[0-9]' ORDER BY 1" % lit):
        out["rows"][rel] = q(DB, "SELECT count(*), md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM ONLY %s x" % rel)[0]
    return out


S = {}


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, DDL)
    run_backup(F.ctx, "incr")
    time.sleep(1.2)
    S["t_ok"] = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
    time.sleep(1.2)
    S["base"] = snap()


def tearDownModule():
    base.tearDownModule()


class Exotic(unittest.TestCase):
    maxDiff = None

    def back(self, label):
        now = snap()
        for k, v in S["base"].items():
            self.assertEqual(now[k], v, "%s: '%s' differs after the restore" % (label, k))

    def go(self, objects, stage="pgarca_stage_x", mode="replace"):
        restore_object(F.ctx, DB, objects=objects, target_time=S["t_ok"], stage_db=stage)
        return promote_object(F.ctx, stage, DB, mode=mode, drop_stage=True, confirm="SOSTITUISCI") if "confirm" in promote_object.__code__.co_varnames else promote_object(F.ctx, stage, DB, mode=mode, drop_stage=True)

    def switch(self):
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)

    def test_01_whole_schema_dropped(self):
        q(DB, "DROP SCHEMA %s CASCADE" % QS)
        self.switch()
        self.go(["%s.%s" % (DB, SCH)])
        self.back("schema dropped")

    def test_02_single_tables_with_odd_names(self):
        q(DB, 'DROP TABLE %s."Child"; DROP TABLE %s.%s' % (QS, QS, LONG))
        self.switch()
        self.go(["%s.%s.Child" % (DB, SCH), "%s.%s.%s" % (DB, SCH, LONG)])
        self.back("Child + 63-char table")

    def test_03_partition_tree_truncated(self):
        q(DB, "TRUNCATE %s.orders" % QS)
        self.switch()
        self.go(["%s.%s.orders" % (DB, SCH)])
        self.back("partitioned orders")

    def test_04_rls_and_exclusion_and_rules(self):
        q(DB, "DELETE FROM %s.secret WHERE id > 10; DELETE FROM %s.room_booking WHERE room = 3; DELETE FROM %s.lines WHERE id > 1500" % (QS, QS, QS))
        self.switch()
        self.go(["%s.%s.secret" % (DB, SCH), "%s.%s.room_booking" % (DB, SCH), "%s.%s.lines" % (DB, SCH), "%s.%s.audit" % (DB, SCH)])
        self.back("rls / exclusion / rule")
        q(DB, "DROP TABLE IF EXISTS %s" % ", ".join(r[0] for r in q(DB, "SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                                                                           "WHERE c.relname ~ '_old_[0-9]' AND c.relkind IN ('r','p') AND NOT c.relispartition")) or "pg_temp.none")

    def test_05_one_partition_of_a_multilevel_tree(self):
        # the most common real request: "give me back last month's partition" - the partition alone, attached again to the LIVE parent with its bound
        q(DB, "DELETE FROM %s.orders_2025_eu WHERE id %% 4 = 0" % QS)
        self.switch()
        r = self.go(["%s.%s.orders_2025_eu" % (DB, SCH)])
        self.assertIn('%s.orders_2025_eu -> %s.orders_2025' % (SCH, SCH), r.get("attached") or [], r)
        self.back("one partition")
        old = q(DB, "SELECT c.relname, c.relispartition FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '%s' AND c.relname ~ '^orders_2025_eu_old_'" % SCH)
        self.assertEqual(len(old), 1, old)                  # (test_04 removed the copies kept by the earlier tests)
        self.assertEqual(old[0][1], "f", "the replaced partition is kept, detached")

    def test_06_inheritance_child_with_rows_deleted(self):
        q(DB, 'DELETE FROM %s."Child" WHERE extra > 25' % QS)
        self.switch()
        self.go(["%s.%s.Child" % (DB, SCH)])
        self.back("inheritance child replaced")
        self.assertEqual(q(DB, 'SELECT count(*) FROM %s."Parent"' % QS)[0][0], "350", "the parent sees the recovered child rows exactly once")

    def test_07_dropped_partition_comes_back_attached(self):
        q(DB, "DROP TABLE %s.orders_2025_us" % QS)
        self.switch()
        r = self.go(["%s.%s.orders_2025_us" % (DB, SCH)], mode="missing_only")
        self.assertIn('%s.orders_2025_us -> %s.orders_2025' % (SCH, SCH), r.get("attached") or [], r)
        self.back("dropped partition")

    def test_08_partition_as_new_copy_stays_standalone(self):
        before = snap()
        r = self.go(["%s.%s.orders_2025_eu" % (DB, SCH)], mode="as_new")
        self.assertEqual(r.get("attached") or [], [])
        cp = q(DB, "SELECT c.relname, c.relispartition FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '%s' AND c.relname ~ '^orders_2025_eu_pitr_'" % SCH)
        self.assertEqual(len(cp), 1, cp)
        self.assertEqual(cp[0][1], "f", "a copy is never attached to the live tree")
        self.assertEqual(snap(), before, "as_new must not touch anything live")


if __name__ == "__main__":
    unittest.main()
