"""A table that references large objects (oid / lo columns): restoring the table must bring back the large objects its rows reference when they were
deleted since (lo_unlink, or the lo_manage trigger of the lo extension) - otherwise the rows come back pointing at nothing.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_objects_lobs_pg -v'
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

DB = "archivio"
S = {}


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, "CREATE EXTENSION lo")
    q(DB, "CREATE TABLE allegati (id int PRIMARY KEY, nome text, file oid, anteprima lo)")
    q(DB, "CREATE TRIGGER t_lo BEFORE UPDATE OR DELETE ON allegati FOR EACH ROW EXECUTE FUNCTION lo_manage(anteprima)")
    q(DB, "INSERT INTO allegati SELECT g, 'doc' || g, lo_from_bytea(0, convert_to('contenuto ' || g, 'UTF8')), lo_from_bytea(0, convert_to('mini ' || g, 'UTF8'))::lo FROM generate_series(1, 40) g")
    q(DB, "CREATE TABLE altro (id int PRIMARY KEY, file oid); INSERT INTO altro VALUES (1, lo_from_bytea(0, 'altro'::bytea))")     # not selected: untouched
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["t"] = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
    S["content"] = q(DB, "SELECT string_agg(convert_from(lo_get(file), 'UTF8') || '/' || convert_from(lo_get(anteprima::oid), 'UTF8'), ',' ORDER BY id) FROM allegati")[0][0]
    time.sleep(1.2)
    # the documents 31..40 are deleted: rows and their large objects (lo_manage unlinks 'anteprima', the application unlinks 'file')
    q(DB, "SELECT lo_unlink(file) FROM allegati WHERE id > 30; DELETE FROM allegati WHERE id > 30")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    base.tearDownModule()


def content():
    return q(DB, "SELECT string_agg(convert_from(lo_get(file), 'UTF8') || '/' || convert_from(lo_get(anteprima::oid), 'UTF8'), ',' ORDER BY id) FROM allegati")[0][0]


class Lobs(unittest.TestCase):
    def test_01_table_restore_brings_back_the_large_objects_its_rows_reference(self):
        restore_object(F.ctx, DB, objects=["%s.public.allegati" % DB], target_time=S["t"], stage_db="pgarca_stage_lo")
        r = promote_object(F.ctx, "pgarca_stage_lo", DB, mode="replace", drop_stage=False)
        self.assertEqual(q(DB, "SELECT count(*) FROM allegati")[0][0], "40")
        self.assertEqual(content(), S["content"], "every row's large objects are readable again")
        self.assertEqual(r.get("large_objects_restored"), 20, r)
        self.assertEqual(q(DB, "SELECT convert_from(lo_get(file), 'UTF8') FROM altro")[0][0], "altro")
        q("postgres", "DROP DATABASE pgarca_stage_lo")

    def test_02_row_recovery_brings_back_their_large_objects(self):
        q(DB, "SELECT lo_unlink(file) FROM allegati WHERE id IN (5, 6); DELETE FROM allegati WHERE id IN (5, 6)")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)
        restore_object(F.ctx, DB, objects=["%s.public.allegati" % DB], target_time=S["t"], stage_db="pgarca_stage_lo2")
        d = diff_object(F.ctx, "pgarca_stage_lo2", "%s.public.allegati" % DB)
        r = apply_rows(F.ctx, "pgarca_stage_lo2", "%s.public.allegati" % DB, restore_keys=[json.dumps(x["key"]) for x in d["missing_now"]])
        self.assertEqual(r["inserted"], 2)
        self.assertEqual(q(DB, "SELECT convert_from(lo_get(file), 'UTF8') FROM allegati WHERE id = 5")[0][0], "contenuto 5")
        q("postgres", "DROP DATABASE pgarca_stage_lo2")


if __name__ == "__main__":
    unittest.main()
