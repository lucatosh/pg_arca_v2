"""Backup + PITR restore of an instance with a NON-default layout (real PostgreSQL): configuration files outside PGDATA (Debian style),
custom port/socket, a tablespace in its own directory. Proves the engine is not tied to the layout of the lab or of the default packages.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_engine_layout_pg'"""
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.test_engine_pg import BIN, SKIP, sh, HERE
from pg_arca.engine.backup import run_backup
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance


@unittest.skipIf(SKIP, "PostgreSQL binaries not available")
class DebianLayout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp(prefix="arca_dl_")
        b = cls.base
        cls.data, cls.etc, cls.sock, cls.ts, cls.wal = (os.path.join(b, x) for x in ("var_lib/main", "etc/main", "run", "ts_fast", "walarch"))
        for d in (cls.etc, cls.sock, cls.ts):
            os.makedirs(d)
        r = sh(os.path.join(BIN, "initdb"), "-D", cls.data, "-U", "postgres", "--auth=trust", "-k")
        assert r.returncode == 0, r.stderr
        for f in ("postgresql.conf", "pg_hba.conf", "pg_ident.conf"):
            shutil.move(os.path.join(cls.data, f), os.path.join(cls.etc, f))
        cls.port = 56000 + (os.getpid() % 800)
        walbin = os.path.join(HERE, "pg-arca-wal")
        with open(os.path.join(cls.etc, "postgresql.conf"), "a") as f:
            f.write("\ndata_directory='%s'\nhba_file='%s'\nident_file='%s'\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\n" % (
                cls.data, os.path.join(cls.etc, "pg_hba.conf"), os.path.join(cls.etc, "pg_ident.conf"), cls.port, cls.sock))
            f.write("wal_level=replica\narchive_mode=on\nwal_log_hints=on\narchive_timeout=5\nmax_connections=30\nshared_buffers=32MB\n")
            f.write("archive_command='env WAL_ARCHIVE_DIR=%s PG_ARCA_HOME=%s PG_ARCA_CONF=/nonexistent %s archive %%p %%f'\n" % (cls.wal, HERE, walbin))
        # Debian style: PGDATA does not contain the config, the server is started with -c config_file
        cls.start_args = "-o \"-c config_file=%s\"" % os.path.join(cls.etc, "postgresql.conf")
        r = sh("bash", "-c", "%s -D %s %s -l %s -w start" % (os.path.join(BIN, "pg_ctl"), cls.data, cls.start_args, os.path.join(b, "src.log")))
        assert r.returncode == 0, r.stderr + open(os.path.join(b, "src.log")).read()[-1500:]
        cls.conn = PgConn(host=cls.sock, port=cls.port, user="postgres", bindir=BIN)
        cls.ctx = Ctx(cls.conn, cls.data, os.path.join(b, "repo"), "main", cls.wal, os.path.join(b, "scratch"), process_max=2, compression="zlib", level=3,
                      start_fast=True, log=lambda lv, m: None, agent_path=walbin, key_file=None)

    @classmethod
    def tearDownClass(cls):
        sh(os.path.join(BIN, "pg_ctl"), "-D", cls.data, "-m", "immediate", "stop")
        shutil.rmtree(cls.base, ignore_errors=True)

    def q(self, db, sql):
        s = PgSession(self.conn.with_db(db))
        try:
            return s.query(sql)
        finally:
            s.close()

    def test_full_backup_pitr_restore_keeps_external_config_and_tablespace(self):
        self.q("postgres", "CREATE TABLESPACE fast LOCATION '%s'" % self.ts)
        self.q("postgres", "CREATE DATABASE app")
        self.q("app", "CREATE TABLE a(id int, v text) TABLESPACE fast; INSERT INTO a SELECT g, 'x' || g FROM generate_series(1,5000) g")
        self.q("app", "CREATE TABLE b(id int); INSERT INTO b SELECT g FROM generate_series(1,100) g")
        meta = run_backup(self.ctx, "full")
        self.assertEqual(meta["status"], "COMPLETE")
        self.q("app", "INSERT INTO a SELECT g, 'y' FROM generate_series(1,1000) g")
        time.sleep(1.2)
        t1 = self.q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
        time.sleep(1.2)
        self.q("app", "DROP TABLE a")                                         # the accident
        self.q("postgres", "SELECT pg_switch_wal()"); time.sleep(2)
        dest = os.path.join(self.base, "restored")
        plan = restore_instance(self.ctx, dest=dest, target_time=t1, action="promote")
        self.assertTrue(os.path.exists(os.path.join(dest, "recovery.signal")))
        self.assertTrue(plan.get("tablespaces_relocated"), "operator is told the tablespace was relocated")
        # the tablespace must not point at the ORIGINAL directory of a live server: restore remaps or relocates it, never writes into it
        tsl = os.path.join(dest, "pg_tblspc")
        links = [os.path.realpath(os.path.join(tsl, e)) for e in os.listdir(tsl)]
        self.assertTrue(links and all(not l.startswith(self.ts) for l in links), "restored tablespace must not share the source directory: %s" % links)
        port2 = self.port + 1
        with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\narchive_mode=off\narchive_command=''\n" % (port2, self.sock))
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-l", os.path.join(self.base, "restored.log"), "-w", "-t", "120", "start")
        self.assertEqual(r.returncode, 0, r.stderr + open(os.path.join(self.base, "restored.log")).read()[-2000:])
        try:
            s = PgSession(PgConn(host=self.sock, port=port2, user="postgres", bindir=BIN, dbname="app"))
            try:
                for _ in range(60):
                    if s.scalar("SELECT pg_is_in_recovery()") == "f":
                        break
                    time.sleep(1)
                self.assertEqual(int(s.scalar("SELECT count(*) FROM a")), 6000)       # state at t1, before the DROP
                self.assertEqual(int(s.scalar("SELECT count(*) FROM b")), 100)
            finally:
                s.close()
        finally:
            sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")


if __name__ == "__main__":
    unittest.main()
