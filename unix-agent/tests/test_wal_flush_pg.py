"""A restore to 'now' (no target, or a target of the last minutes) must include what was written seconds before: the last WAL is only in the current,
not yet archived segment. When the backed-up server is reachable as a primary (same system identifier), the segment is switched and its archiving
awaited before the recovery. Another cluster is never touched.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_wal_flush_pg -v'
"""
import datetime
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_database
from pg_arca.engine.restore import flush_current_wal


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE fresh")
    q("fresh", "CREATE TABLE t (id int PRIMARY KEY, v text)")
    run_backup(F.ctx, "full")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(2)


def tearDownModule():
    base.tearDownModule()


class Flush(unittest.TestCase):
    def test_01_no_target_includes_the_last_seconds(self):
        q("fresh", "INSERT INTO t VALUES (1, 'written just now')")
        r = restore_database(F.ctx, "fresh", new_name="fresh_now")
        self.assertEqual(q("fresh_now", "SELECT v FROM t WHERE id = 1"), [["written just now"]])
        self.assertTrue((r.get("wal_flushed") or {}).get("archived"), r.get("wal_flushed"))
        self.assertFalse(r.get("target_clamped"), "the target was reached, not clamped")

    def test_02_recent_target_time_includes_the_last_seconds(self):
        q("fresh", "INSERT INTO t VALUES (2, 'two')")
        time.sleep(1.1)
        t = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
        r = restore_database(F.ctx, "fresh", target_time=t, new_name="fresh_t")
        self.assertEqual(q("fresh_t", "SELECT count(*) FROM t WHERE id = 2")[0][0], "1")
        self.assertTrue((r.get("wal_flushed") or {}).get("archived"), r.get("wal_flushed"))

    def test_03_old_targets_and_other_clusters_are_left_alone(self):
        chain = [{"system_identifier": q("postgres", "SELECT system_identifier FROM pg_control_system()")[0][0]}]
        old = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=2)).strftime("%Y-%m-%d %H:%M:%S+00")
        self.assertIsNone(flush_current_wal(F.ctx, chain, target_time=old), "a target of hours ago is archived long since")
        self.assertIsNone(flush_current_wal(F.ctx, chain, target_lsn="0/1000000"), "explicit positions are not touched")
        # the fixture archives every 5 s (archive_timeout): a timed switch between the two readings is not ours (seen on PG17 on a loaded VM)
        q("postgres", "ALTER SYSTEM SET archive_timeout = 0"); q("postgres", "SELECT pg_reload_conf()"); time.sleep(0.5)
        try:
            before = q("postgres", "SELECT pg_current_wal_lsn()")[0][0]
            self.assertIsNone(flush_current_wal(F.ctx, [{"system_identifier": "1234"}]), "another cluster (central recovery host's own PostgreSQL)")
            after = q("postgres", "SELECT pg_current_wal_lsn()")[0][0]
            seg = int(q("postgres", "SELECT setting FROM pg_settings WHERE name = 'wal_segment_size'")[0][0])
            lsn = lambda x: (int(x.split("/")[0], 16) << 32) | int(x.split("/")[1], 16)
            self.assertFalse(lsn(after) % seg == 0 and lsn(after) > lsn(before), "no WAL switch on a cluster that is not the backed-up one (%s -> %s)" % (before, after))
        finally:
            q("postgres", "ALTER SYSTEM RESET archive_timeout"); q("postgres", "SELECT pg_reload_conf()")


if __name__ == "__main__":
    unittest.main()
