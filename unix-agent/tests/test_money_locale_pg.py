"""money columns are printed and parsed with lc_monetary. A database whose lc_monetary differs from the server's (ALTER DATABASE ... SET) must come back
with the same amounts after a database restore, an object restore and row recovery.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_money_locale_pg -v'
"""
import os
import subprocess
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_database, restore_object

LOC = "it_IT.utf8"
HAVE = LOC in subprocess.run(["locale", "-a"], stdout=subprocess.PIPE, universal_newlines=True).stdout
S = {}


def setUpModule():
    if not HAVE:
        raise unittest.SkipTest("locale %s not available" % LOC)
    base.setUpModule()
    q("postgres", "CREATE DATABASE soldi")
    q("postgres", "ALTER DATABASE soldi SET lc_monetary = '%s'" % LOC)
    q("postgres", "ALTER DATABASE soldi SET timezone = 'Europe/Rome'; ALTER DATABASE soldi SET DateStyle = 'SQL, DMY'; ALTER DATABASE soldi SET IntervalStyle = 'sql_standard'")
    q("soldi", "CREATE TABLE fatture (id int PRIMARY KEY, importo money, emessa timestamptz DEFAULT now(), scadenza interval DEFAULT '30 days 2 hours')")
    q("soldi", "INSERT INTO fatture (id, importo) SELECT g, (g * 1234.56)::numeric::money FROM generate_series(1, 50) g")
    q("soldi", "CREATE TABLE eventi (quando timestamptz, cosa text, PRIMARY KEY (quando, cosa)); INSERT INTO eventi SELECT now() - g * interval '1 hour', 'e' || g FROM generate_series(1, 20) g")
    S["sum"] = q("soldi", "SELECT sum(importo::numeric) FROM fatture")[0][0]
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["t"] = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
    time.sleep(1.2)
    q("soldi", "DELETE FROM fatture WHERE id > 25")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    if HAVE:
        base.tearDownModule()


class Money(unittest.TestCase):
    def test_01_database_restore(self):
        restore_database(F.ctx, "soldi", target_time=S["t"], new_name="soldi_back")
        self.assertEqual(q("soldi_back", "SELECT sum(importo::numeric) FROM fatture")[0][0], S["sum"])

    def test_02_object_restore(self):
        restore_object(F.ctx, "soldi", objects=["soldi.public.fatture"], target_time=S["t"], stage_db="pgarca_stage_money")
        promote_object(F.ctx, "pgarca_stage_money", "soldi", mode="replace", drop_stage=True)
        self.assertEqual(q("soldi", "SELECT sum(importo::numeric) FROM fatture")[0][0], S["sum"])

    def test_03_row_recovery(self):
        import json
        from pg_arca.engine.granular import apply_rows, diff_object
        q("soldi", "DELETE FROM fatture WHERE id > 40; UPDATE fatture SET importo = 1::money WHERE id = 5")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)
        restore_object(F.ctx, "soldi", objects=["soldi.public.fatture"], target_time=S["t"], stage_db="pgarca_stage_mrows")
        d = diff_object(F.ctx, "pgarca_stage_mrows", "soldi.public.fatture")
        self.assertEqual((d["counts"]["missing_now"], d["counts"]["changed"]), (10, 1))
        keys = [json.dumps(x["key"]) for x in d["missing_now"]] + [json.dumps(x["key"]) for x in d["changed"]]
        apply_rows(F.ctx, "pgarca_stage_mrows", "soldi.public.fatture", restore_keys=keys)
        self.assertEqual(q("soldi", "SELECT sum(importo::numeric) FROM fatture")[0][0], S["sum"])
        self.assertEqual(q("soldi", "SELECT importo::numeric FROM fatture WHERE id = 5")[0][0], "6172.80")
        q("postgres", "DROP DATABASE pgarca_stage_mrows")

    def test_04_rows_keyed_by_a_timestamp_in_a_database_with_its_own_timezone(self):
        import json
        from pg_arca.engine.granular import apply_rows, diff_object
        q("soldi", "DELETE FROM eventi WHERE cosa IN ('e3', 'e4')")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)
        restore_object(F.ctx, "soldi", objects=["soldi.public.eventi"], target_time=S["t"], stage_db="pgarca_stage_ev")
        d = diff_object(F.ctx, "pgarca_stage_ev", "soldi.public.eventi")
        self.assertEqual((d["counts"]["missing_now"], d["counts"]["added_since"], d["counts"]["changed"]), (2, 0, 0), d["counts"])
        r = apply_rows(F.ctx, "pgarca_stage_ev", "soldi.public.eventi", restore_keys=[json.dumps(x["key"]) for x in d["missing_now"]])
        self.assertEqual(r["inserted"], 2)
        self.assertEqual(q("soldi", "SELECT count(*) FROM eventi")[0][0], "20")
        q("postgres", "DROP DATABASE pgarca_stage_ev")


if __name__ == "__main__":
    unittest.main()
