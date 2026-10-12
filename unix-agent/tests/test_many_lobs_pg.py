"""A database with many large objects (document stores): database restore must bring them all back (pg_dump handles each one separately; the recovery
instance must not run out of shared memory / locks).

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_many_lobs_pg -v'      (PG_ARCA_LOBS=n to change the count)
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

N = int(os.environ.get("PG_ARCA_LOBS", "30000"))


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE docs")
    q("docs", "CREATE TABLE doc (id int PRIMARY KEY, blob oid); INSERT INTO doc SELECT g, lo_from_bytea(0, convert_to('documento ' || g, 'UTF8')) FROM generate_series(1, %d) g" % N)
    run_backup(F.ctx, "full")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    base.tearDownModule()


class Lobs(unittest.TestCase):
    def test_restore_database_with_many_large_objects(self):
        t0 = time.time()
        r = restore_database(F.ctx, "docs", new_name="docs_back")
        took = time.time() - t0
        self.assertEqual(q("docs_back", "SELECT count(*) FROM pg_largeobject_metadata")[0][0], str(N))
        self.assertEqual(q("docs_back", "SELECT convert_from(lo_get(blob), 'UTF8') FROM doc WHERE id = %d" % N)[0][0], "documento %d" % N)
        print("LOBS %d restored in %.1f s" % (N, took))


if __name__ == "__main__":
    unittest.main()
