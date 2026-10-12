"""Tablespaces created AFTER the full backup. A recovery replays the WAL from the FULL's start, and PostgreSQL replays CREATE TABLESPACE on the
ABSOLUTE path in the record, removing the version directory it finds there and re-pointing pg_tblspc to it: on the production host that is the live
tablespace. Found by this test: a database restore deleted production's files. Now:
  - every restore on this host is refused before touching anything (PGA-RST-050 / instance plan 'ts_created'), production intact
  - after a new FULL backup the tablespace is part of the backup, relocated into the scratch / the given remap: the same restores work

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_tablespace_later_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import BIN, F, q, sh

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_database, restore_object
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance
from pg_arca.engine.util import EngineError


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE tsl")
    q("tsl", "CREATE TABLE base_t AS SELECT generate_series(1, 100) AS id")
    run_backup(F.ctx, "full")
    for n, rows in (("ts_mid", 300), ("ts_late", 500)):
        d = os.path.join(F.base, n)
        os.makedirs(d)
        q("postgres", "CREATE TABLESPACE %s LOCATION '%s'" % (n, d))
        q("tsl", "CREATE TABLE %s_t TABLESPACE %s AS SELECT generate_series(1, %d) AS id" % (n[3:], n, rows))
        if n == "ts_mid":
            run_backup(F.ctx, "incr")                                    # an incremental does NOT help: the replay still starts at the full
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    base.tearDownModule()


def walk():
    return sorted(os.path.relpath(os.path.join(a, f), F.base) for n in ("ts_mid", "ts_late") for a, _, fs in os.walk(os.path.join(F.base, n)) for f in fs)


class TsLater(unittest.TestCase):
    def test_flow(self):
        before = walk()
        # 1. refused everywhere on this host, nothing touched
        for fn in (lambda: restore_database(F.ctx, "tsl", new_name="tsl_back"),
                   lambda: restore_object(F.ctx, "tsl.public.late_t", stage_db="pgarca_stage_tsl")):
            with self.assertRaises(EngineError) as e:
                fn()
            self.assertEqual(e.exception.code, "PGA-RST-050", e.exception)
        p = restore_instance(F.ctx, dest=os.path.join(F.base, "inst_x"), dry_run=True)
        self.assertIn("ts_created", [c["id"] for c in p["preflight"]["checks"] if c["level"] == "bad"], p["preflight"])
        self.assertEqual(walk(), before, "production's tablespace directories must be untouched")
        self.assertEqual(q("postgres", "SELECT count(*) FROM pg_database WHERE datname LIKE 'tsl_back%' OR datname LIKE 'pgarca_stage_%'")[0][0], "0")
        # 2. a new FULL backup: the tablespaces are in it and relocated -> everything works, production intact
        run_backup(F.ctx, "full")
        restore_database(F.ctx, "tsl", new_name="tsl_back")
        self.assertEqual(q("tsl_back", "SELECT (SELECT count(*) FROM mid_t) + (SELECT count(*) FROM late_t)")[0][0], "800")
        q("tsl", "DROP TABLE late_t")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        restore_object(F.ctx, "tsl.public.late_t", stage_db="pgarca_stage_tsl", target_time=q("postgres", "SELECT to_char((now() - interval '3 seconds') at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0])
        promote_object(F.ctx, "pgarca_stage_tsl", "tsl", mode="missing_only", drop_stage=True)
        self.assertEqual(q("tsl", "SELECT count(*) FROM late_t")[0][0], "500")
        dest = os.path.join(F.base, "inst")
        oids = dict(q("postgres", "SELECT spcname, oid FROM pg_tablespace WHERE spcname LIKE 'ts_%'"))
        restore_instance(F.ctx, dest=dest, tablespace_remap={oids[n]: os.path.join(F.base, "reloc_" + n) for n in oids})
        port = F.port + 7
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-o", "-p %d -k %s" % (port, F.sock), "-l", dest + ".log", "-w", "-t", "120", "start")
        self.assertEqual(r.returncode, 0, open(dest + ".log").read()[-1500:])
        try:
            s = PgSession(PgConn(host=F.sock, port=port, user="postgres", bindir=BIN).with_db("tsl"))
            for _ in range(60):
                if s.scalar("SELECT pg_is_in_recovery()") == "f":
                    break
                time.sleep(1)
            self.assertEqual(s.scalar("SELECT (SELECT count(*) FROM base_t) + (SELECT count(*) FROM mid_t) + (SELECT count(*) FROM late_t)"), "900")
            s.close()
        finally:
            sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")
        q("tsl", "CHECKPOINT")
        self.assertEqual(q("tsl", "SELECT (SELECT count(*) FROM mid_t) + (SELECT count(*) FROM late_t)")[0][0], "800", "production still reads its tablespaces")

    def test_z_database_created_later_in_a_tablespace_empty_at_full_time(self):
        # the manifest lists files, not directories: a tablespace with no files at backup time had no version directory (PG_16_...) in the copy,
        # and replaying CREATE DATABASE into it after the consistency point made PostgreSQL PANIC ('missing directory'). Found by a database restore.
        d = os.path.join(F.base, "ts_empty")
        os.makedirs(d)
        q("postgres", "CREATE TABLESPACE ts_empty LOCATION '%s'" % d)
        run_backup(F.ctx, "full")
        q("postgres", "CREATE DATABASE in_empty TABLESPACE ts_empty")
        q("in_empty", "CREATE TABLE t AS SELECT generate_series(1, 250) AS id")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        restore_database(F.ctx, "in_empty", new_name="in_empty_back")
        self.assertEqual(q("in_empty_back", "SELECT count(*) FROM t")[0][0], "250")
        restore_database(F.ctx, "tsl", new_name="tsl_back_z")              # another database: in_empty is left out of the sparse recovery
        self.assertEqual(q("tsl_back_z", "SELECT count(*) FROM base_t")[0][0], "100")
        dest = os.path.join(F.base, "inst_z")
        oids = dict(q("postgres", "SELECT spcname, oid FROM pg_tablespace WHERE spcname LIKE 'ts_%'"))
        restore_instance(F.ctx, dest=dest, tablespace_remap={oids[n]: os.path.join(F.base, "relocz_" + n) for n in oids})
        port = F.port + 8
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-o", "-p %d -k %s" % (port, F.sock), "-l", dest + ".log", "-w", "-t", "120", "start")
        self.assertEqual(r.returncode, 0, open(dest + ".log").read()[-1500:])
        try:
            s = PgSession(PgConn(host=F.sock, port=port, user="postgres", bindir=BIN).with_db("in_empty"))
            for _ in range(60):
                if s.scalar("SELECT pg_is_in_recovery()") == "f":
                    break
                time.sleep(1)
            self.assertEqual(s.scalar("SELECT count(*) FROM t"), "250")
            s.close()
        finally:
            sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")


if __name__ == "__main__":
    unittest.main()
