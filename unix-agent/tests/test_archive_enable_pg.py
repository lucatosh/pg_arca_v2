"""archive_enable on a REAL standalone PostgreSQL that has archiving off: apply, restart, idempotent re-run, then a backup + immediate restore work.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_archive_enable_pg'"""
import os
import shutil
import sys
import tempfile
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
class ArchiveEnable(unittest.TestCase):
    def test_enable_restart_backup_restore(self):
        b = tempfile.mkdtemp(prefix="arca_ae_"); data, sock, wal = b + "/data", b + "/s", b + "/wal"; os.makedirs(sock); port = 56700 + os.getpid() % 200
        env = dict(os.environ, PATH=HERE + os.pathsep + os.environ["PATH"], WAL_ARCHIVE_DIR=wal, PG_ARCA_HOME=HERE, PG_ARCA_CONF="/nonexistent")
        self.assertEqual(sh(os.path.join(BIN, "initdb"), "-D", data, "-U", "postgres", "--auth=trust").returncode, 0)    # NO checksums, archiving off: the hard case
        with open(data + "/postgresql.conf", "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\nwal_level=minimal\nmax_wal_senders=0\n" % (port, sock))
        start = lambda: sh(os.path.join(BIN, "pg_ctl"), "-D", data, "-l", b + "/l", "-w", "start", env=env)
        stop = lambda: sh(os.path.join(BIN, "pg_ctl"), "-D", data, "-m", "fast", "-w", "stop")
        self.assertEqual(start().returncode, 0)
        try:
            db = PostgresClient(user="postgres", port=port, host="", socket_dir=sock)
            old_path = os.environ["PATH"]; os.environ["PATH"] = env["PATH"]
            try:
                ex = OperationExecutor({"state_dir": b + "/state"}, db, NoPatroni(), None, None)
                r = ex.h_archive_enable({})
                self.assertTrue(r["restart_required"]); self.assertIn("archive_mode", r["changed"]); self.assertEqual(r["changed"].get("wal_level"), "replica")
                self.assertEqual(r["changed"].get("wal_log_hints"), "on"); self.assertIn("pg-arca-wal archive %p %f", r["changed"]["archive_command"])
                stop(); self.assertEqual(start().returncode, 0)
                r2 = ex.h_archive_enable({})
                self.assertTrue(r2.get("already_enabled"), r2)                                    # idempotent
                # a foreign archiver is never replaced silently
                db.alter_system("archive_command", "pgbackrest --stanza=x archive-push %p")
                with self.assertRaises(OpError):
                    ex.h_archive_enable({})
                self.assertIn("changed", ex.h_archive_enable({"replace_foreign": True}))
            finally:
                os.environ["PATH"] = old_path
            conn = PgConn(host=sock, port=port, user="postgres", bindir=BIN)
            ctx = Ctx(conn, data, b + "/repo", "main", wal, b + "/scr", process_max=2, compression="zlib", level=3, start_fast=True, log=lambda l, m: None,
                      agent_path=os.path.join(HERE, "pg-arca-wal"), key_file=None)
            s = PgSession(conn.with_db("postgres")); s.query("create table t as select g from generate_series(1,2000) g"); s.close()
            meta = run_backup(ctx, "full"); self.assertEqual(meta["status"], "COMPLETE")
            plan = restore_instance(ctx, dest=b + "/restored", immediate=True, action="promote"); self.assertTrue(plan["set"])
        finally:
            stop(); shutil.rmtree(b, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
