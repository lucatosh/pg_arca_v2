"""A database/object restore whose result would land on a STANDBY (read-only: a replica's node, the leader of a geo standby site) is refused in the
plan, before the long recovery, with the way out - instead of failing at the end with 'cannot execute CREATE DATABASE in a read-only transaction'.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_dest_standby_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import BIN, F, q, sh

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_database, restore_object
from pg_arca.engine.util import EngineError

S = {}


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE sbx; ")
    q("sbx", "CREATE TABLE t AS SELECT generate_series(1, 100) AS id")
    run_backup(F.ctx, "full")
    S["dir"] = os.path.join(F.base, "standby")
    r = sh(os.path.join(BIN, "pg_basebackup"), "-h", F.sock, "-p", str(F.port), "-U", "postgres", "-D", S["dir"], "-R", "-X", "stream")
    assert r.returncode == 0, r.stderr
    S["port"] = F.port + 3
    with open(os.path.join(S["dir"], "postgresql.auto.conf"), "a") as f:
        f.write("\nport = %d\narchive_mode = off\n" % S["port"])
    r = sh(os.path.join(BIN, "pg_ctl"), "-D", S["dir"], "-l", S["dir"] + ".log", "-w", "-t", "60", "start")
    assert r.returncode == 0, open(S["dir"] + ".log").read()[-800:]
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(2)


def tearDownModule():
    sh(os.path.join(BIN, "pg_ctl"), "-D", S["dir"], "-m", "immediate", "stop")
    base.tearDownModule()


class DestStandby(unittest.TestCase):
    def test_refused_in_the_plan(self):
        into = {"host": F.sock, "port": S["port"], "user": "postgres"}
        p = restore_database(F.ctx, "sbx", new_name="sbx_copy", into=into, dry_run=True)
        self.assertIn("dest_standby", [c["id"] for c in p["preflight"]["checks"] if c["level"] == "bad"], p["preflight"])
        o = restore_object(F.ctx, "sbx.public.t", into=into, dry_run=True)
        self.assertIn("dest_standby", [c["id"] for c in o["preflight"]["checks"] if c["level"] == "bad"], o["preflight"])
        t0 = time.time()
        with self.assertRaises(EngineError):
            restore_database(F.ctx, "sbx", new_name="sbx_copy", into=into)
        self.assertLess(time.time() - t0, 30, "refused before the recovery, not after it")


if __name__ == "__main__":
    unittest.main()
