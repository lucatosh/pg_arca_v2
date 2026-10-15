"""Incremental backups driven by WAL summaries, on a REAL PostgreSQL 17+ (skipped below 17: the lab matrix runs it on 17 and 18).
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_wal_summary_pg -v'
What is checked: after `ALTER SYSTEM SET summarize_wal = on`, an incremental reads only the changed relation files (meta.wal_summaries.used,
bytes not read > 0, unchanged big table untouched), the restore of that incremental is byte-for-byte right (rows of the changed and of the
unchanged tables), a truncated table and a new table are handled, and with summarize_wal off the engine falls back to the page scan."""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from pg_arca.engine.backup import run_backup
from pg_arca.engine.maintenance import verify
from pg_arca.engine.restore import restore_instance

SKIP = T.SKIP


def setUpModule():
    if SKIP:
        raise unittest.SkipTest(SKIP)
    T.setUpModule()
    v = int(T.q("postgres", "SHOW server_version_num")[0][0])
    if v < 170000:
        T.tearDownModule()
        raise unittest.SkipTest("WAL summaries need PostgreSQL 17+ (this is %d)" % v)
    T.q("postgres", "ALTER SYSTEM SET summarize_wal = on")
    T.q("postgres", "SELECT pg_reload_conf()")
    time.sleep(2)
    T.q("postgres", "CREATE DATABASE ws")
    T.q("ws", "CREATE TABLE big(id int primary key, pad text); INSERT INTO big SELECT g, repeat('x', 500) FROM generate_series(1, 60000) g")
    T.q("ws", "CREATE TABLE small(id int primary key, v text); INSERT INTO small SELECT g, 'v' FROM generate_series(1, 2000) g")
    T.q("ws", "CREATE TABLE trunc_me(id int); INSERT INTO trunc_me SELECT g FROM generate_series(1, 20000) g")
    T.q("ws", "CHECKPOINT")


def tearDownModule():
    if SKIP:
        return
    T.tearDownModule()


def rel_of(db, table):
    return T.q(db, "SELECT pg_relation_filepath('%s')" % table)[0][0]


class WalSummaryTests(unittest.TestCase):
    def test_01_incremental_reads_only_what_changed(self):
        F = T.F
        full = run_backup(F.ctx, "full")
        self.assertEqual(full["status"], "COMPLETE")
        big_path, small_path = rel_of("ws", "big"), rel_of("ws", "small")
        T.q("ws", "UPDATE small SET v = 'changed' WHERE id <= 100")
        T.q("ws", "TRUNCATE trunc_me")
        T.q("ws", "CREATE TABLE newt(id int); INSERT INTO newt SELECT g FROM generate_series(1, 5000) g")
        T.q("postgres", "CHECKPOINT")
        T.q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        incr = run_backup(F.ctx, "incr")
        self.assertEqual(incr["type"], "incr")
        ws = incr.get("wal_summaries") or {}
        self.assertTrue(ws.get("used"), ws)
        self.assertGreater(ws["files_unread"], 0, ws)
        self.assertGreater(incr["stats"]["bytes_not_read"], 0, incr["stats"])
        man = F.ctx.repo.load_manifest(incr)
        self.assertEqual(man["files"][big_path]["chunks"], [], "big table untouched: not read, no chunk")
        self.assertTrue(man["files"][small_path]["chunks"], "small table changed: its changed chunks are there")
        self.assertLess(len(man["files"][small_path]["chunks"]), 8, "and only the changed ones")
        self.assertTrue(verify(F.ctx, deep=True)["ok"])
        # the restore of the incremental has exactly the right data
        dest = os.path.join(F.base, "ws-restored")
        r = restore_instance(F.ctx, dest=dest, immediate=True)
        self.assertTrue(r.get("ok", True), r)
        port2 = F.port + 7
        with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\narchive_mode=off\narchive_command=''\nsummarize_wal=off\n" % (port2, F.sock))
        rr = T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-l", os.path.join(F.base, "ws-restored.log"), "-w", "-t", "120", "start")
        self.assertEqual(rr.returncode, 0, rr.stderr + open(os.path.join(F.base, "ws-restored.log")).read()[-2000:])
        try:
            q2 = lambda sql: T.sh(os.path.join(T.BIN, "psql"), "-X", "-At", "-h", F.sock, "-p", str(port2), "-d", "ws", "-c", sql).stdout.strip()
            self.assertEqual(q2("SELECT count(*), sum(length(pad)) FROM big"), "60000|30000000")
            self.assertEqual(q2("SELECT count(*) FROM small WHERE v = 'changed'"), "100")
            self.assertEqual(q2("SELECT count(*) FROM trunc_me"), "0")
            self.assertEqual(q2("SELECT count(*) FROM newt"), "5000")
        finally:
            T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")

    def test_02_without_summaries_the_page_scan_is_used(self):
        F = T.F
        T.q("postgres", "ALTER SYSTEM SET summarize_wal = off")
        T.q("postgres", "SELECT pg_reload_conf()")
        time.sleep(2)
        try:
            T.q("ws", "UPDATE small SET v = 'again' WHERE id <= 10")
            incr = run_backup(F.ctx, "incr")
            ws = incr.get("wal_summaries") or {}
            self.assertFalse(ws.get("used"), ws)
            self.assertEqual(incr["stats"]["bytes_not_read"], 0)
            self.assertTrue(verify(F.ctx, deep=True)["ok"])
        finally:
            T.q("postgres", "ALTER SYSTEM SET summarize_wal = on")
            T.q("postgres", "SELECT pg_reload_conf()")


if __name__ == "__main__":
    unittest.main()
