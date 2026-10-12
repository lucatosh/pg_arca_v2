"""archive_enable on a REAL standalone PostgreSQL that has archiving off: apply, restart, idempotent re-run, then a backup + immediate restore work.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_archive_enable_pg'"""
import os
import time
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
        nock = ["--no-data-checksums"] if "--no-data-checksums" in sh(os.path.join(BIN, "initdb"), "--help").stdout else []   # PostgreSQL 18 enables checksums by default
        self.assertEqual(sh(os.path.join(BIN, "initdb"), "-D", data, "-U", "postgres", "--auth=trust", *nock).returncode, 0)    # NO checksums, archiving off: the hard case
        with open(data + "/postgresql.conf", "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\nwal_level=minimal\nmax_wal_senders=0\n" % (port, sock))
        start = lambda: sh(os.path.join(BIN, "pg_ctl"), "-D", data, "-l", b + "/l", "-w", "start", env=env)
        stop = lambda: sh(os.path.join(BIN, "pg_ctl"), "-D", data, "-m", "fast", "-w", "stop")
        self.assertEqual(start().returncode, 0)
        try:
            db = PostgresClient(user="postgres", port=port, host="", socket_dir=sock)
            saved_env = dict(os.environ); os.environ.update(env)      # the agent's environment: a restart from the agent hands it to the new postmaster (archive_command needs it here)
            try:
                ex = OperationExecutor({"state_dir": b + "/state", "pg_data": data, "pg_bin_dir": BIN}, db, NoPatroni(), None, None)
                r = ex.h_archive_enable({})
                self.assertTrue(r["restart_required"]); self.assertIn("archive_mode", r["changed"]); self.assertEqual(r["changed"].get("wal_level"), "replica")
                self.assertEqual(r["changed"].get("wal_log_hints"), "on"); self.assertIn("pg-arca-wal archive %p %f", r["changed"]["archive_command"])
                # the restart from the console (standalone, no systemd here: pg_ctl restart with the options it was started with)
                self.assertEqual(ex.h_pg_restart({"dry_run": True})["plan"]["method"], "pg_ctl")
                # a broken configuration is refused BEFORE the restart (PostgreSQL would not come back)
                db.alter_system("work_mem", "64MB")
                with open(data + "/postgresql.auto.conf", "a") as f:
                    f.write("shared_buffers = 'not-a-size'\n")
                db.run_psql("SELECT pg_reload_conf();")
                time.sleep(1)
                pl = ex.h_pg_restart({"dry_run": True})["plan"]
                self.assertEqual(pl["method"], "refuse", pl); self.assertIn("shared_buffers", pl["why"])
                with self.assertRaises(OpError):
                    ex.h_pg_restart({})
                with open(data + "/postgresql.auto.conf") as f:
                    lines = [l for l in f if "not-a-size" not in l]
                with open(data + "/postgresql.auto.conf", "w") as f:
                    f.writelines(lines)
                db.run_psql("SELECT pg_reload_conf();")
                time.sleep(1)
                rr = ex.h_pg_restart({})
                self.assertTrue(rr["restarted"], rr); self.assertIn("archive_mode", rr["pending_before"]); self.assertEqual(rr["pending_restart"], [], rr)
                r2 = ex.h_archive_enable({})
                self.assertTrue(r2.get("already_enabled"), r2)                                    # idempotent
                # a foreign archiver is never replaced silently
                db.alter_system("archive_command", "pgbackrest --stanza=x archive-push %p")
                with self.assertRaises(OpError):
                    ex.h_archive_enable({})
                self.assertIn("changed", ex.h_archive_enable({"replace_foreign": True}))
            finally:
                os.environ.clear(); os.environ.update(saved_env)
            conn = PgConn(host=sock, port=port, user="postgres", bindir=BIN)
            ctx = Ctx(conn, data, b + "/repo", "main", wal, b + "/scr", process_max=2, compression="zlib", level=3, start_fast=True, log=lambda l, m: None,
                      agent_path=os.path.join(HERE, "pg-arca-wal"), key_file=None)
            s = PgSession(conn.with_db("postgres")); s.query("create table t as select g from generate_series(1,2000) g"); s.close()
            meta = run_backup(ctx, "full"); self.assertEqual(meta["status"], "COMPLETE")
            plan = restore_instance(ctx, dest=b + "/restored", immediate=True, action="promote"); self.assertTrue(plan["set"])
            # the copy must not archive into production's archive (a new timeline + history file there collides with the next real failover)
            auto = open(b + "/restored/postgresql.auto.conf").read()
            self.assertIn("archive_mode = 'off'", auto); self.assertIn("synchronous_standby_names = ''", auto)
            before = sorted(os.listdir(wal))
            port2 = port + 1
            r = sh(os.path.join(BIN, "pg_ctl"), "-D", b + "/restored", "-o", "-p %d -k %s" % (port2, sock), "-l", b + "/r.log", "-w", "-t", "120", "start", env=env)
            self.assertEqual(r.returncode, 0, open(b + "/r.log").read()[-800:])
            try:
                c2 = PgConn(host=sock, port=port2, user="postgres", bindir=BIN)
                s2 = PgSession(c2.with_db("postgres")); self.assertEqual(s2.scalar("SELECT current_setting('archive_mode')"), "off")
                for _ in range(60):                                          # wait for the end of recovery (promotion = new timeline)
                    if s2.scalar("SELECT pg_is_in_recovery()") == "f":
                        break
                    time.sleep(1)
                s2.query("SELECT pg_switch_wal()"); s2.close()
                time.sleep(2)
                self.assertEqual([x for x in sorted(os.listdir(wal)) if x not in before and x.endswith(".history")], [], "the copy pushed a timeline history into the production archive")
            finally:
                sh(os.path.join(BIN, "pg_ctl"), "-D", b + "/restored", "-m", "immediate", "stop")
        finally:
            stop(); shutil.rmtree(b, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
