"""Databases with names real customers use: spaces, capitals, dashes, an apostrophe, unicode. Database restore, object restore and promotion must work.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_weird_names_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_database, restore_object
from pg_arca.engine.util import EngineError, quote_ident

NAMES = ["Vendite Q1-2026", "l'archivio", "Ünïcödé dati"]
S = {}


def setUpModule():
    base.setUpModule()
    for n in NAMES:
        q("postgres", "CREATE DATABASE %s" % quote_ident(n))
        q(n, "CREATE TABLE \"Righe Ordine\" (id int PRIMARY KEY, v text); INSERT INTO \"Righe Ordine\" SELECT g, 'v' || g FROM generate_series(1, 30) g")
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["t"] = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
    time.sleep(1.2)
    for n in NAMES:
        q(n, "DELETE FROM \"Righe Ordine\" WHERE id > 10")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    base.tearDownModule()


class Weird(unittest.TestCase):
    def test_01_database_restore_with_default_new_name(self):
        for n in NAMES:
            r = restore_database(F.ctx, n, target_time=S["t"])
            self.assertEqual(q(r["result_database"], "SELECT count(*) FROM \"Righe Ordine\"")[0][0], "30", r["result_database"])
        self.assertEqual(q("postgres", "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE datname LIKE '%_restored'")[0][0],
                         "Unicode_dati_restored,Vendite_Q1_2026_restored,l_archivio_restored")

    def test_02_object_restore_and_promotion(self):
        for i, n in enumerate(NAMES):
            st = "pgarca_stage_w%d" % i
            restore_object(F.ctx, n, objects=['%s.public."Righe Ordine"' % (n if "." not in n else '"%s"' % n)], target_time=S["t"], stage_db=st)
            promote_object(F.ctx, st, n, mode="replace", drop_stage=True)
            self.assertEqual(q(n, "SELECT count(*) FROM \"Righe Ordine\"")[0][0], "30", n)


if __name__ == "__main__":
    unittest.main()
