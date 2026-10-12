"""Opt-in (PG_ARCA_SCALE=N tables, e.g. 300): a dropped schema with N tables (serial key, index, foreign key to a parent, a view each 10)
comes back in one restore. Prints the time of each phase; asserts only correctness. Not part of the matrix (slow)."""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_object

N = int(os.environ.get("PG_ARCA_SCALE") or 0)
DB = "arca_scale"
S = {}


@unittest.skipUnless(N, "set PG_ARCA_SCALE=<tables> to run")
class Scale(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base.setUpModule()
        q("postgres", "CREATE DATABASE %s" % DB)
        ddl = ["CREATE SCHEMA big; CREATE TABLE big.parent (id int PRIMARY KEY); INSERT INTO big.parent SELECT generate_series(1, 100);"]
        for i in range(N):
            ddl.append("CREATE TABLE big.t%04d (id serial PRIMARY KEY, p int REFERENCES big.parent, v text); CREATE INDEX ON big.t%04d (v);"
                       "INSERT INTO big.t%04d (p, v) SELECT 1 + g %% 100, md5(g::text) FROM generate_series(1, 200) g;" % (i, i, i))
            if i % 10 == 0:
                ddl.append("CREATE VIEW big.v%04d AS SELECT * FROM big.t%04d WHERE p < 50;" % (i, i))
        t0 = time.time()
        q(DB, "\n".join(ddl))
        S["build"] = time.time() - t0
        run_backup(F.ctx, "full")
        time.sleep(1.2)
        S["t_ok"] = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
        time.sleep(1.2)

    @classmethod
    def tearDownClass(cls):
        base.tearDownModule()

    def test_schema_back(self):
        for i in range(0, N, 100):                               # the test server is small (30 connections): drop in pieces
            q(DB, "DROP TABLE IF EXISTS %s CASCADE" % ", ".join("big.t%04d" % j for j in range(i, min(N, i + 100))))
        q(DB, "DROP SCHEMA big CASCADE")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        t0 = time.time()
        r = restore_object(F.ctx, DB, objects=["%s.big" % DB], target_time=S["t_ok"], stage_db="pgarca_stage_big")
        t1 = time.time()
        cap = int(q(DB, "SELECT current_setting('max_locks_per_transaction')::int * (current_setting('max_connections')::int + current_setting('max_prepared_transactions')::int)")[0][0])
        plan = promote_object(F.ctx, "pgarca_stage_big", DB, mode="replace", dry_run=True)
        sys.stderr.write("\n[scale] promote needs about %s locks, server slots %d\n" % (plan.get("locks"), cap))
        if plan.get("blocking"):
            from pg_arca.engine.util import EngineError
            with self.assertRaises(EngineError) as e:                 # said BEFORE anything changes (no half-done swap)
                promote_object(F.ctx, "pgarca_stage_big", DB, mode="replace", drop_stage=False)
            self.assertEqual(e.exception.code, "PGA-GEN-093")
            self.assertEqual(q(DB, "SELECT count(*) FROM pg_namespace WHERE nspname = 'big'")[0][0], "0", "nothing was changed")
            return
        p = promote_object(F.ctx, "pgarca_stage_big", DB, mode="replace", drop_stage=True)
        t2 = time.time()
        sys.stderr.write("\n[scale %d tables] build %.1fs, restore_object %.1fs (recovery %.1fs), promote %.1fs\n" % (N, S["build"], t1 - t0, r.get("total_seconds") or -1, t2 - t1))
        self.assertEqual(int(q(DB, "SELECT count(*) FROM pg_tables WHERE schemaname = 'big'")[0][0]), N + 1)
        self.assertEqual(int(q(DB, "SELECT count(*) FROM pg_views WHERE schemaname = 'big'")[0][0]), (N + 9) // 10)
        self.assertEqual(int(q(DB, "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND connamespace = 'big'::regnamespace")[0][0]), N)
        self.assertTrue(p)


if __name__ == "__main__":
    unittest.main()
