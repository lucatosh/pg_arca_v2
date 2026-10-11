"""Backup and point-in-time restore WHILE the database is being written to (real PostgreSQL).

A writer commits one row at a time (id, timestamp, payload derived from id) during a full backup, an incremental, and after a chosen target time.
The instance restored at that target must hold exactly the rows committed up to it: ids 1..N without holes, no torn row, none stamped after the target,
and the source's row N+1 must have been written at/after the target (the cut is at the target, not earlier).
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_live_pg -v'
"""
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.test_engine_pg import BIN, SKIP, HERE, sh                      # same binaries / rules as the engine suite
from pg_arca.engine.backup import run_backup
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.granular import restore_object
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance


class Fx(object):
    pass


F = Fx()


def setUpModule():
    if SKIP:
        raise unittest.SkipTest(SKIP)
    F.base = tempfile.mkdtemp(prefix="pgarca-live-")
    F.src, F.sock, F.wal, F.repo, F.scratch = (os.path.join(F.base, x) for x in ("src", "sock", "wal", "repo", "scratch"))
    os.makedirs(F.sock)
    F.port = 56000 + (os.getpid() % 900)
    r = sh(os.path.join(BIN, "initdb"), "-D", F.src, "-U", "postgres", "--auth=trust", "-k")
    assert r.returncode == 0, r.stderr
    walbin = os.path.join(HERE, "pg-arca-wal")
    with open(os.path.join(F.src, "postgresql.conf"), "a") as f:
        f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\nwal_level=replica\narchive_mode=on\n" % (F.port, F.sock))
        f.write("archive_command='env WAL_ARCHIVE_DIR=%s PG_ARCA_HOME=%s PG_ARCA_CONF=/nonexistent %s archive %%p %%f'\narchive_timeout=5\nshared_buffers=32MB\n" % (F.wal, HERE, walbin))
    r = sh(os.path.join(BIN, "pg_ctl"), "-D", F.src, "-l", os.path.join(F.base, "src.log"), "-w", "start")
    assert r.returncode == 0, r.stderr
    F.conn = PgConn(host=F.sock, port=F.port, user="postgres", bindir=BIN)
    F.ctx = Ctx(F.conn, F.src, F.repo, "main", F.wal, F.scratch, process_max=4, compression="zlib", level=1, start_fast=True, seg_size=16 * 1024 * 1024, agent_path=walbin)


def tearDownModule():
    if SKIP:
        return
    sh(os.path.join(BIN, "pg_ctl"), "-D", F.src, "-m", "immediate", "stop")
    if not os.environ.get("PG_ARCA_KEEP"):
        shutil.rmtree(F.base, ignore_errors=True)


def q(sql, db="postgres", conn=None):
    s = PgSession((conn or F.conn).with_db(db))
    try:
        return s.query(sql)
    finally:
        s.close()


class Writer(threading.Thread):
    """psql running a procedure that commits one row per iteration until live.stop has a row."""
    def __init__(self):
        threading.Thread.__init__(self, daemon=True)

    def run(self):
        self.p = subprocess.run([os.path.join(BIN, "psql"), "-X", "-h", F.sock, "-p", str(F.port), "-U", "postgres", "-d", "app", "-c", "CALL live.writer()"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)


CHECK = ("SELECT count(*), coalesce(min(id),0), coalesce(max(id),0), count(*) FILTER (WHERE chk <> md5(id::text) OR payload <> repeat(md5(id::text), 20)), "
         "count(*) FILTER (WHERE ts > '%s') FROM live.ledger")


@unittest.skipIf(SKIP, SKIP or "")
class LivePg(unittest.TestCase):
    def test_backup_and_pitr_during_continuous_inserts(self):
        q("CREATE DATABASE app")
        q("CREATE SCHEMA live; CREATE TABLE live.ledger(id bigint PRIMARY KEY, ts timestamptz NOT NULL, payload text NOT NULL, chk text NOT NULL); CREATE TABLE live.stop(x int); "
          "CREATE TABLE live.bulk AS SELECT g AS id, md5(g::text) AS v FROM generate_series(1, 200000) g", "app")
        q("""CREATE PROCEDURE live.writer() LANGUAGE plpgsql AS $w$ DECLARE i bigint := 0; BEGIN
             LOOP i := i + 1; INSERT INTO live.ledger VALUES (i, clock_timestamp(), repeat(md5(i::text), 20), md5(i::text)); COMMIT;
                  IF i % 100 = 0 THEN EXIT WHEN EXISTS (SELECT 1 FROM live.stop); END IF; END LOOP; END $w$""", "app")
        w = Writer(); w.start(); time.sleep(2)
        try:
            full = run_backup(F.ctx, "full")                                         # under load
            self.assertEqual(full["status"], "COMPLETE")
            q("UPDATE live.bulk SET v = v || 'x' WHERE id % 7 = 0", "app")           # changes for the incremental, still under load
            incr = run_backup(F.ctx, "incr")
            self.assertEqual(incr["status"], "COMPLETE")
            time.sleep(2)
            t_cut = q("SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US')||'+00'")[0][0]
            time.sleep(3)
        finally:
            q("INSERT INTO live.stop VALUES (1)", "app"); w.join(60)
        n_src = int(q("SELECT count(*) FROM live.ledger", "app")[0][0])
        q("SELECT pg_switch_wal()"); time.sleep(8)
        self.assertGreater(n_src, 1000, "the writer really wrote during the backups")

        # 1) whole instance at the cut
        dest = os.path.join(F.base, "pitr")
        restore_instance(F.ctx, dest=dest, target_time=t_cut, action="promote")
        port2 = F.port + 1
        with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\narchive_mode=off\narchive_command=''\n" % (port2, F.sock))
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-l", os.path.join(F.base, "pitr.log"), "-w", "-t", "180", "start")
        self.assertEqual(r.returncode, 0, r.stderr + open(os.path.join(F.base, "pitr.log")).read()[-2000:])
        try:
            c2 = PgConn(host=F.sock, port=port2, user="postgres", bindir=BIN)
            for _ in range(60):
                if q("SELECT pg_is_in_recovery()", conn=c2)[0][0] == "f":
                    break
                time.sleep(1)
            cnt, lo, hi, torn, late = (int(x) for x in q(CHECK % t_cut, "app", conn=c2)[0])
            self.assertEqual(torn, 0, "no torn row")
            self.assertEqual(late, 0, "nothing stamped after the target")
            self.assertEqual((cnt, lo), (hi, 1), "ids 1..N without holes (%d rows, %d..%d)" % (cnt, lo, hi))
            self.assertLess(hi, n_src)
            nxt = q("SELECT ts > timestamptz '%s' - interval '1 second' FROM live.ledger WHERE id = %d" % (t_cut, hi + 1), "app")[0][0]
            self.assertEqual(nxt, "t", "the next row was written at the target: the cut is at the target, not earlier")
            bulk = q("SELECT count(*), count(*) FILTER (WHERE v LIKE '%x') FROM live.bulk", "app", conn=c2)[0]
            self.assertEqual([int(x) for x in bulk], [200000, 200000 // 7], "the incremental's changes are there")
        finally:
            sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")

        # 2) one table at the cut, through the recovery instance, while the source keeps being written
        q("DELETE FROM live.stop", "app"); w2 = Writer(); w2.start(); time.sleep(1)
        try:
            restore_object(F.ctx, "app.live.ledger", stage_db="pgarca_stage_live", target_time=t_cut)
            cnt2, lo2, hi2, torn2, late2 = (int(x) for x in q(CHECK % t_cut, "pgarca_stage_live")[0])
            self.assertEqual((cnt2, lo2, hi2, torn2, late2), (cnt, 1, hi, 0, 0), "same cut through the granular path")
        finally:
            q("INSERT INTO live.stop VALUES (1)", "app"); w2.join(60)
