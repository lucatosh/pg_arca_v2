"""Asynchronous WAL archiving against a REAL PostgreSQL: archive_command spools, an in-process pusher drains the spool into the archive, a
backup taken meanwhile still waits for (and gets) its WAL from the archive, and with the pusher stopped archive_command goes synchronous.
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_wal_spool_pg -v'
"""
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from pg_arca import wal_spool
from pg_arca.engine.backup import run_backup
from pg_arca.engine.maintenance import verify

SKIP = T.SKIP


def setUpModule():
    if SKIP:
        raise unittest.SkipTest(SKIP)
    T.setUpModule()


def tearDownModule():
    if SKIP:
        return
    T.tearDownModule()


class SpoolPgTests(unittest.TestCase):
    def test_spool_drains_and_backups_get_their_wal(self):
        F = T.F
        state = os.path.join(F.base, "state")
        os.makedirs(state, exist_ok=True)
        conf = os.path.join(F.base, "agent-async.conf")
        with open(conf, "w") as f:
            json.dump({"wal_archive_dir": F.wal, "compression": "zlib", "wal_segment_size": F.seg, "state_dir": state, "wal_archive_async": True}, f)
        walbin = os.path.join(T.HERE, "pg-arca-wal")
        cmd = "env WAL_ARCHIVE_DIR=%s PG_ARCA_HOME=%s PG_ARCA_CONF=%s %s archive %%p %%f" % (F.wal, T.HERE, conf, walbin)
        T.q("postgres", "ALTER SYSTEM SET archive_command = '%s'" % cmd.replace("'", "''"))
        T.q("postgres", "SELECT pg_reload_conf()")
        spool = wal_spool.spool_dir(state)
        pu = wal_spool.Pusher(F.ctx.wal, spool, workers=2, log=lambda lv, m: sys.stderr.write("[%s] %s\n" % (lv, m)) if os.environ.get("V") else None)
        th = pu.start(interval=0.5)
        try:
            time.sleep(1.5)                                                # heartbeat on disk before the first spooled segment
            T.q("postgres", "CREATE DATABASE spooldb")
            T.q("spooldb", "CREATE TABLE t AS SELECT g, repeat('x', 400) p FROM generate_series(1, 60000) g")
            for _ in range(4):
                T.q("spooldb", "UPDATE t SET p = p WHERE g % 5 = 0")
                T.q("postgres", "SELECT pg_switch_wal()")
            seen_spool = False
            t0 = time.time()
            while time.time() - t0 < 30:                               # the spool must have been used, and must drain
                if wal_spool.pending(spool):
                    seen_spool = True
                if seen_spool and not wal_spool.pending(spool):
                    break
                time.sleep(0.2)
            self.assertTrue(seen_spool or pu.pushed > 0, "nothing went through the spool: archive_command did not use it")
            # a full backup while archiving is asynchronous: its WAL must reach the archive through the pusher
            m = run_backup(F.ctx, "full", archive_timeout=120)
            self.assertEqual(m["status"], "COMPLETE")
            self.assertTrue(verify(F.ctx)["ok"])
            self.assertGreater(pu.pushed, 0)
            # the backup waits for the segments it needs; the .backup label PostgreSQL archives right after pg_backup_stop may still be in the
            # spool for one push interval (seen on the PG17 matrix on a loaded VM): it must drain, not be there already
            t0 = time.time()
            while wal_spool.pending(spool) and time.time() - t0 < 15:
                time.sleep(0.2)
            self.assertEqual(wal_spool.pending(spool), [])
            st = wal_spool.status(spool)
            self.assertTrue(st["alive"] and st["pending"] == 0 and not st.get("last_error"))
        finally:
            pu.stop()
            th.join(5)
        # pusher gone: the heartbeat ages out and archive_command archives synchronously again (no segment stuck in the spool)
        hb = os.path.join(spool, wal_spool.HEARTBEAT)
        old = time.time() - wal_spool.PUSHER_STALE_SEC - 5
        os.utime(hb, (old, old))
        before = len(F.ctx.wal.list_segments())
        T.q("spooldb", "UPDATE t SET p = p WHERE g % 7 = 0")
        T.q("postgres", "SELECT pg_switch_wal()")
        t0 = time.time()
        while time.time() - t0 < 30 and len(F.ctx.wal.list_segments()) <= before:
            time.sleep(0.3)
        self.assertGreater(len(F.ctx.wal.list_segments()), before, "synchronous path archived the new segment")
        self.assertEqual(wal_spool.pending(spool), [], "nothing spooled while the pusher is dead")
        T.q("postgres", "ALTER SYSTEM RESET archive_command")
        T.q("postgres", "SELECT pg_reload_conf()")


if __name__ == "__main__":
    unittest.main()
