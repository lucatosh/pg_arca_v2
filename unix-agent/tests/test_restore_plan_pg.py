"""The restore check (restore_plan) says what the real run will do, with the options of the real run (independent review of the restore flows):
  - a delta / resumed whole-server restore onto a directory that is not empty is checked AS such (it was refused as "not empty");
  - tables of a database that no longer exists, to be put back by the tool at the end: refused by the check and by the run BEFORE any recovery.
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_restore_plan_pg -v'
"""
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup
from pg_arca.engine.util import EngineError
from pg_arca.executor import OperationExecutor


class X(object):
    pass


class _NoPatroni(object):
    url = ""


def setUpModule():
    T.setUpModule()
    F.ctx.conn.bindir = T.BIN
    q("postgres", "CREATE DATABASE shop")
    q("shop", "CREATE TABLE orders (id int PRIMARY KEY); INSERT INTO orders SELECT generate_series(1, 50)")
    q("postgres", "CREATE DATABASE gone")
    q("gone", "CREATE TABLE t (id int); INSERT INTO t SELECT generate_series(1, 5)")
    run_backup(F.ctx, "full")
    q("postgres", "DROP DATABASE gone")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(1)
    X.ex = OperationExecutor({"state_dir": os.path.join(F.base, "state"), "log_dir": F.base}, None, _NoPatroni())
    X.ex._ctx_ro = lambda: F.ctx
    X.ex._ctx = lambda: F.ctx


def tearDownModule():
    T.tearDownModule()


class Plan(unittest.TestCase):
    def test_01_delta_onto_a_directory_that_is_not_empty(self):
        d = tempfile.mkdtemp(dir=F.base)
        with open(os.path.join(d, "PG_VERSION"), "w") as f:
            f.write("16\n")
        with self.assertRaises(EngineError) as e:
            X.ex.h_restore_plan({"scope": "instance", "destination": d})
        self.assertIn("PGA-SEC-005", e.exception.as_text())
        plan = X.ex.h_restore_plan({"scope": "instance", "destination": d, "delta": True})
        self.assertTrue(plan, "the delta restore is checked as a delta restore")

    def test_02_objects_of_a_dropped_database_with_a_put_back(self):
        with self.assertRaises(EngineError) as e:
            X.ex.h_restore_plan({"scope": "object", "object": "gone.public.t", "finish": "promote", "promote_mode": "missing_only"})
        self.assertIn("PGA-GEN-086", e.exception.as_text())
        t0 = time.time()
        with self.assertRaises(EngineError):
            X.ex.h_restore_object({"object": "gone.public.t", "finish": "promote", "promote_mode": "missing_only"})
        self.assertLess(time.time() - t0, 10, "refused before any recovery")
        plan = X.ex.h_restore_plan({"scope": "object", "object": "gone.public.t"})          # only a copy to check: fine
        self.assertTrue(plan)

    def test_03_objects_of_a_live_database_with_a_put_back_pass(self):
        plan = X.ex.h_restore_plan({"scope": "object", "object": "shop.public.orders", "finish": "promote", "promote_mode": "as_new"})
        self.assertTrue(plan)


if __name__ == "__main__":
    unittest.main()
