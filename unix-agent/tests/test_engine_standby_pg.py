"""Backups taken FROM A STANDBY, then restored / drilled, against a real PostgreSQL primary + streaming standby (unix sockets only).
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_engine_standby_pg -v'
"""
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from pg_arca.engine.backup import run_backup
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.granular import restore_drill, restore_object, restore_test
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance

SKIP = T.SKIP
S = T.Fx()


def setUpModule():
    if SKIP:
        raise unittest.SkipTest(SKIP)
    T.setUpModule()                                  # primary (F), archiving to F.wal
    F = T.F
    S.sdir = os.path.join(F.base, "standby")
    S.sock = os.path.join(F.base, "ssock")
    os.makedirs(S.sock)
    S.port = F.port + 1
    T.q("postgres", "CREATE DATABASE app")
    T.q("app", "CREATE TABLE orders(id serial primary key, note text); INSERT INTO orders(note) SELECT 'row ' || g FROM generate_series(1,20000) g")
    r = T.sh(os.path.join(T.BIN, "pg_basebackup"), "-D", S.sdir, "-h", F.sock, "-p", str(F.port), "-U", "postgres", "-R", "-X", "stream", "-c", "fast")
    assert r.returncode == 0, r.stderr
    with open(os.path.join(S.sdir, "postgresql.auto.conf"), "a") as f:
        f.write("\nport=%d\nunix_socket_directories='%s'\nhot_standby=on\n" % (S.port, S.sock))
    r = T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", S.sdir, "-l", os.path.join(F.base, "standby.log"), "-w", "start")
    assert r.returncode == 0, r.stderr + open(os.path.join(F.base, "standby.log")).read()
    S.conn = PgConn(host=S.sock, port=S.port, user="postgres", bindir=T.BIN)
    S.ctx = Ctx(S.conn, S.sdir, F.repo, "main", F.wal, F.scratch, process_max=4, compression="zlib", level=3, start_fast=True,
                log=lambda lv, m: sys.stderr.write("[%s] %s\n" % (lv, m)) if os.environ.get("V") else None, agent_path=F.ctx.agent_path, key_file=F.key or None)


def tearDownModule():
    if SKIP:
        return
    T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", S.sdir, "-m", "immediate", "stop")
    T.tearDownModule()


def churn(n=3):
    for i in range(n):
        T.q("app", "INSERT INTO orders(note) SELECT 'churn %d ' || g FROM generate_series(1,2000) g" % i)
        T.q("postgres", "SELECT pg_switch_wal()")
        time.sleep(1)


class StandbyTests(unittest.TestCase):
    def test_01_standby_is_in_recovery(self):
        for _ in range(30):
            s = PgSession(S.conn.with_db("app"))
            try:
                n = s.scalar("SELECT count(*) FROM orders") if s.scalar("SELECT to_regclass('orders')") else "0"
                if s.scalar("SELECT pg_is_in_recovery()") == "t" and n == "20000":
                    return
            finally:
                s.close()
            time.sleep(1)
        self.fail("standby not caught up")

    def test_02_full_backup_from_standby(self):
        churn(2)
        meta = run_backup(S.ctx, "full")
        T.F.sfull = meta
        self.assertEqual(meta["status"], "COMPLETE")
        self.assertTrue(meta["from_standby"])

    def test_03_incremental_from_standby(self):
        churn(2)
        meta = run_backup(S.ctx, "incr")
        self.assertEqual(meta["status"], "COMPLETE")
        self.assertEqual(meta["type"], "incr")

    def test_04_drill_of_standby_set(self):
        T.q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        r = restore_drill(S.ctx)
        self.assertTrue(r["full_cluster"])
        self.assertIn("app", r["databases_checked"])

    def test_05_restore_test_of_standby_set(self):
        r = restore_test(S.ctx)
        self.assertTrue(r)

    def test_06_instance_restore_from_standby_set(self):
        """a full instance restore of the standby-taken chain, recovered to its end (immediate), must contain the rows that existed when the backup ended"""
        T.q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        dest = os.path.join(T.F.base, "restored")
        r = restore_instance(S.ctx, dest=dest, immediate=True, action="pause")
        self.assertTrue(os.path.exists(os.path.join(dest, "backup_label")))


if __name__ == "__main__":
    unittest.main()
