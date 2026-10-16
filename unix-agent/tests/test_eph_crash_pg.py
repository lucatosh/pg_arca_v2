"""A process of the recovery instance dies while it replays (OOM killer on a loaded host, seen once in a test run): PostgreSQL's postmaster
reinitializes and resumes recovery, and the restore must ride it out instead of failing with 'cannot connect ... crash of another server
process'.   as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_eph_crash_pg -v'"""
import os
import signal
import subprocess
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_database
from pg_arca.engine import ephemeral


def setUpModule():
    T.setUpModule()
    q("postgres", "CREATE DATABASE crashy")
    q("crashy", "CREATE TABLE t AS SELECT g, repeat('x', 200) p FROM generate_series(1, 20000) g")
    run_backup(F.ctx, "full")
    q("crashy", "INSERT INTO t SELECT g, 'y' FROM generate_series(20001, 60000) g")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    T.tearDownModule()


class EphCrash(unittest.TestCase):
    def test_backend_killed_during_recovery(self):
        killed = []
        orig = ephemeral.Ephemeral.wait_target if hasattr(ephemeral, "Ephemeral") else None
        cls = next(c for c in vars(ephemeral).values() if isinstance(c, type) and hasattr(c, "wait_target"))
        orig = cls.wait_target

        def wrapped(self, *a, **k):
            # kill -9 one non-startup child of the instance's postmaster: the postmaster then reinitializes ("crash of another server process")
            if not killed and self.proc is not None:
                out = subprocess.run(["ps", "-o", "pid=,args=", "--ppid", str(self.proc.pid)], stdout=subprocess.PIPE, universal_newlines=True).stdout
                for line in out.splitlines():
                    pid, _, args = line.strip().partition(" ")
                    if "startup" not in args and ("checkpointer" in args or "background writer" in args):
                        os.kill(int(pid), signal.SIGKILL)
                        killed.append(args)
                        break
            return orig(self, *a, **k)
        cls.wait_target = wrapped
        try:
            restore_database(F.ctx, "crashy", new_name="crashy_back")
        finally:
            cls.wait_target = orig
        self.assertTrue(killed, "a process of the recovery instance was killed")
        self.assertEqual(q("crashy_back", "SELECT count(*) FROM t")[0][0], "60000")


if __name__ == "__main__":
    unittest.main()
