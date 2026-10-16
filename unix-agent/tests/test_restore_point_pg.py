"""Named restore points on a REAL PostgreSQL: marked by the agent operation (pg_create_restore_point + WAL switch), then a whole-server restore to
its LSN - the way the console offers it - gives back exactly the state at the mark, also when an incremental backup was taken before it.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_restore_point_pg'"""
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.test_engine_pg import BIN, SKIP, sh, HERE
from pg_arca.db_client import PostgresClient
from pg_arca.executor import OperationExecutor, OpError
from pg_arca.engine.backup import run_backup
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance


class NoPatroni(object):
    configured = False


@unittest.skipIf(SKIP, "PostgreSQL binaries not available")
class RestorePoint(unittest.TestCase):
    def test_mark_and_restore_to_it(self):
        b = tempfile.mkdtemp(prefix="arca_rp_"); data, sock, wal = b + "/data", b + "/s", b + "/wal"; os.makedirs(sock); port = 56900 + os.getpid() % 90
        env = dict(os.environ, PATH=HERE + os.pathsep + os.environ["PATH"], WAL_ARCHIVE_DIR=wal, PG_ARCA_HOME=HERE, PG_ARCA_CONF="/nonexistent")
        self.assertEqual(sh(os.path.join(BIN, "initdb"), "-D", data, "-U", "postgres", "--auth=trust").returncode, 0)
        with open(data + "/postgresql.conf", "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\nwal_level=replica\narchive_mode=on\nwal_log_hints=on\narchive_timeout=5\n"
                    "archive_command='%s archive %%p %%f'\n" % (port, sock, os.path.join(HERE, "pg-arca-wal")))
        self.assertEqual(sh(os.path.join(BIN, "pg_ctl"), "-D", data, "-l", b + "/l", "-w", "start", env=env).returncode, 0)
        try:
            conn = PgConn(host=sock, port=port, user="postgres", bindir=BIN)
            ctx = Ctx(conn, data, b + "/repo", "main", wal, b + "/scr", process_max=2, compression="zlib", level=3, start_fast=True, log=lambda l, m: None,
                      agent_path=os.path.join(HERE, "pg-arca-wal"), key_file=None)
            s = PgSession(conn.with_db("postgres"))
            s.query("CREATE TABLE t AS SELECT g FROM generate_series(1, 1000) g")
            s.close()
            self.assertEqual(run_backup(ctx, "full")["status"], "COMPLETE")
            s = PgSession(conn.with_db("postgres")); s.query("INSERT INTO t SELECT generate_series(1001, 1500)"); s.close()
            self.assertEqual(run_backup(ctx, "incr")["status"], "COMPLETE")
            s = PgSession(conn.with_db("postgres")); s.query("INSERT INTO t SELECT generate_series(1501, 2000)"); s.close()
            ex = OperationExecutor({"state_dir": b + "/state", "pg_data": data, "pg_bin_dir": BIN}, PostgresClient(user="postgres", port=port, host="", socket_dir=sock), NoPatroni(), None, None)
            with self.assertRaises(OpError):
                ex.h_restore_point({"name": "x'; DROP TABLE t; --"})
            rp = ex.h_restore_point({"name": "Before release 4.2"})
            self.assertRegex(rp["lsn"], r"^[0-9A-F]+/[0-9A-F]+$")
            self.assertTrue(rp["segment"]); self.assertTrue(rp["at"].endswith("Z")); self.assertEqual(rp["timeline"], 1)
            # the "release" that goes wrong
            s = PgSession(conn.with_db("postgres")); s.query("DELETE FROM t WHERE g % 2 = 0"); s.query("SELECT pg_switch_wal()"); s.close()
            time.sleep(3)
            dest = b + "/restored"
            plan = restore_instance(ctx, dest=dest, target_lsn=rp["lsn"], inclusive=False, action="promote")
            self.assertEqual(len(plan["chain"]), 2, "the incremental taken before the mark is used")
            port2 = port + 1
            r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-o", "-p %d -k %s" % (port2, sock), "-l", b + "/r.log", "-w", "-t", "120", "start", env=env)
            self.assertEqual(r.returncode, 0, open(b + "/r.log").read()[-800:])
            try:
                s2 = PgSession(PgConn(host=sock, port=port2, user="postgres", bindir=BIN).with_db("postgres"))
                for _ in range(60):
                    if s2.scalar("SELECT pg_is_in_recovery()") == "f":
                        break
                    time.sleep(1)
                self.assertEqual(int(s2.scalar("SELECT count(*) FROM t")), 2000, "the state at the mark: every row, before the delete")
                s2.close()
            finally:
                sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")
        finally:
            sh(os.path.join(BIN, "pg_ctl"), "-D", data, "-m", "immediate", "stop"); shutil.rmtree(b, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
