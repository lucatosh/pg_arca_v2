"""Cancelling a restore at any phase leaves nothing behind: no quarantine / half-created database, no recovery instance still running, no scratch
directory. (An operator presses Annulla in the dock while the restore extracts, recovers or transfers.)

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_cancel_restore_pg -v'
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
from pg_arca.engine.granular import restore_database, restore_object
from pg_arca.engine.util import EngineError

DB = "arca_cancel"


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, "CREATE TABLE big AS SELECT g AS id, md5(g::text) AS v FROM generate_series(1, 200000) g; ALTER TABLE big ADD PRIMARY KEY (id)")
    run_backup(F.ctx, "full")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(2)


def tearDownModule():
    base.tearDownModule()


def leftovers():
    dbs = [r[0] for r in q("postgres", "SELECT datname FROM pg_database WHERE datname LIKE 'pgarca_stage_%' OR datname LIKE 'cancel_copy%'")]
    procs = subprocess.run(["ps", "-eo", "args"], stdout=subprocess.PIPE, universal_newlines=True).stdout
    eph = [l for l in procs.splitlines() if "postgres -D" in l and F.scratch in l]
    scratch = [x for x in os.listdir(F.scratch) if x.startswith(("eph", "pgarca"))] if os.path.isdir(F.scratch) else []
    return dbs, eph, scratch


class Cancel(unittest.TestCase):
    def run_cancel(self, fn, at):
        state = {"seen": []}

        def progress(p):
            state["seen"].append(p.get("phase"))
        cancel = lambda: at in state["seen"]
        try:
            fn(progress, cancel)
            self.fail("cancelled at %s but the restore completed (phases %s)" % (at, state["seen"]))
        except EngineError as ex:
            e = type("E", (), {"exception": ex})
        time.sleep(1)
        dbs, eph, scratch = leftovers()
        self.assertEqual((dbs, eph, scratch), ([], [], []), "cancelled at %s (%s): leftovers" % (at, e.exception))
        return state["seen"]

    def test_object_cancelled_in_each_phase(self):
        for at in ("extract", "recovery", "transfer"):
            seen = self.run_cancel(lambda progress, cancel: restore_object(F.ctx, "%s.public.big" % DB, stage_db="pgarca_stage_cx", progress=progress, cancel=cancel), at)
            self.assertIn(at, seen)

    def test_database_cancelled_in_each_phase(self):
        for at in ("extract", "recovery", "transfer"):
            self.run_cancel(lambda progress, cancel: restore_database(F.ctx, DB, new_name="cancel_copy", progress=progress, cancel=cancel), at)


if __name__ == "__main__":
    unittest.main()
