"""Every kind of recovery target against a real PostgreSQL: named restore point, transaction id (inclusive / exclusive), LSN, plus 'latest'.
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_engine_targets_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from pg_arca.engine.backup import run_backup
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance

SKIP = T.SKIP
setUpModule = T.setUpModule
tearDownModule = T.tearDownModule
X = T.Fx()


def rows_after(**kw):
    dest = os.path.join(T.F.base, "rt_%d" % int(time.time() * 1000))
    restore_instance(T.F.ctx, set_spec=X.full["id"], dest=dest, action="promote", **kw)
    port2 = T.F.port + 7
    with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
        f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\narchive_mode=off\narchive_command=''\n" % (port2, T.F.sock))
    r = T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-l", dest + ".log", "-w", "-t", "120", "start")
    assert r.returncode == 0, r.stderr + open(dest + ".log").read()[-2500:]
    try:
        s = PgSession(PgConn(host=T.F.sock, port=port2, user="postgres", bindir=T.BIN, dbname="tg"))
        try:
            for _ in range(60):
                if s.scalar("SELECT pg_is_in_recovery()") == "f":
                    break
                time.sleep(1)
            return [r[0] for r in s.query("SELECT v FROM marks ORDER BY id")]
        finally:
            s.close()
    finally:
        T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")


class TargetTests(unittest.TestCase):
    def test_00_setup(self):
        T.q("postgres", "CREATE DATABASE tg")
        T.q("tg", "CREATE TABLE marks(id serial primary key, v text)")
        X.full = run_backup(T.F.ctx, "full")
        T.q("tg", "INSERT INTO marks(v) VALUES ('one')")
        X.lsn_after_one = T.q("tg", "SELECT pg_current_wal_lsn()")[0][0]
        T.q("tg", "INSERT INTO marks(v) VALUES ('two')")
        X.rp = T.q("postgres", "SELECT pg_create_restore_point('before_three')")[0][0]
        s = PgSession(T.F.conn.with_db("tg"))
        try:
            s.query("BEGIN")
            X.xid = s.scalar("SELECT txid_current()")
            s.query("INSERT INTO marks(v) VALUES ('three')")
            s.query("COMMIT")
        finally:
            s.close()
        T.q("tg", "INSERT INTO marks(v) VALUES ('four')")
        T.q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)

    def test_01_named_restore_point(self):
        self.assertEqual(rows_after(target_name="before_three"), ["one", "two"])

    def test_02_xid_inclusive_and_exclusive(self):
        self.assertEqual(rows_after(target_xid=X.xid, inclusive=True), ["one", "two", "three"])
        self.assertEqual(rows_after(target_xid=X.xid, inclusive=False), ["one", "two"])

    def test_03_lsn(self):
        self.assertEqual(rows_after(target_lsn=X.lsn_after_one, inclusive=True)[:1], ["one"])
        self.assertNotIn("three", rows_after(target_lsn=X.lsn_after_one))

    def test_04_latest(self):
        self.assertEqual(rows_after(), ["one", "two", "three", "four"])


if __name__ == "__main__":
    unittest.main()
