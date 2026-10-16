"""Replacing a table drops and recreates the live views on it: they must come back with everything DROP VIEW took with them (independent review,
16/10): INSTEAD OF triggers (writes through an updatable view), rules, column defaults, column comments and column grants.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_objects_views_pg'"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_object, promote_object

DB = "arca_views"
S = {}


def now_txt():
    return q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]


def setUpModule():
    T.setUpModule()
    q("postgres", "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clerk') THEN CREATE ROLE clerk; END IF; END $$")
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, """CREATE TABLE acct(id int PRIMARY KEY, owner text, balance numeric);
INSERT INTO acct SELECT g, 'o' || g, g * 10 FROM generate_series(1, 200) g;
CREATE TABLE audit(at timestamptz DEFAULT now(), what text);
CREATE VIEW acct_v AS SELECT id, owner, balance, 'web'::text AS channel FROM acct;
ALTER VIEW acct_v ALTER COLUMN channel SET DEFAULT 'api';
COMMENT ON COLUMN acct_v.balance IS 'in cents';
GRANT SELECT (id, owner) ON acct_v TO clerk;
CREATE FUNCTION acct_v_ins() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
  INSERT INTO acct VALUES (NEW.id, NEW.owner, NEW.balance); INSERT INTO audit(what) VALUES ('insert ' || NEW.id || ' via ' || NEW.channel); RETURN NEW; END $f$;
CREATE TRIGGER acct_v_ins INSTEAD OF INSERT ON acct_v FOR EACH ROW EXECUTE FUNCTION acct_v_ins();
CREATE VIEW rich AS SELECT id, owner FROM acct WHERE balance > 1000;
CREATE RULE rich_del AS ON DELETE TO rich DO INSTEAD INSERT INTO audit(what) VALUES ('refused delete ' || OLD.id);
CREATE MATERIALIZED VIEW acct_mv AS SELECT count(*) AS n FROM acct; CREATE UNIQUE INDEX ON acct_mv (n);
CREATE MATERIALIZED VIEW acct_cold AS SELECT id FROM acct WITH NO DATA;""")
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["t0"] = now_txt()
    time.sleep(1.2)
    q(DB, "DELETE FROM acct WHERE id > 100")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    T.tearDownModule()


class Views(unittest.TestCase):
    def test_01_replace_keeps_what_hangs_on_the_live_views(self):
        restore_object(F.ctx, DB, objects=["%s.public.acct" % DB], target_time=S["t0"], stage_db="pgarca_stage_views")
        r = promote_object(F.ctx, "pgarca_stage_views", "%s.public.acct" % DB, mode="replace", drop_stage=True)
        self.assertEqual(q(DB, "SELECT count(*) FROM acct")[0][0], "200", r)
        self.assertEqual(q(DB, "SELECT tgname FROM pg_trigger WHERE tgrelid = 'acct_v'::regclass AND NOT tgisinternal"), [["acct_v_ins"]])
        q(DB, "INSERT INTO acct_v (id, owner, balance) VALUES (500, 'new', 1)")
        self.assertEqual(q(DB, "SELECT what FROM audit ORDER BY at DESC LIMIT 1")[0][0], "insert 500 via api", "trigger and column default back")
        self.assertEqual(q(DB, "SELECT owner FROM acct WHERE id = 500")[0][0], "new")
        q(DB, "DELETE FROM rich WHERE id = 150")
        self.assertEqual(q(DB, "SELECT count(*) FROM acct WHERE id = 150")[0][0], "1", "the rule is back: the delete is refused")
        self.assertEqual(q(DB, "SELECT col_description('acct_v'::regclass, 3)")[0][0], "in cents")
        self.assertEqual(q(DB, "SELECT n FROM acct_mv")[0][0], "200", "materialized view created empty in the swap, filled after it")
        self.assertEqual(q(DB, "SELECT relispopulated::text FROM pg_class WHERE relname = 'acct_cold'")[0][0], "false", "an unfilled one stays unfilled")
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_indexes WHERE tablename = 'acct_mv'")[0][0], "1")
        self.assertEqual(q(DB, "SELECT has_column_privilege('clerk', 'acct_v', 'owner', 'SELECT')::text, has_column_privilege('clerk', 'acct_v', 'balance', 'SELECT')::text")[0], ["true", "false"])


if __name__ == "__main__":
    unittest.main()
