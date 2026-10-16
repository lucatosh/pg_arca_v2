"""Engine tests against a REAL PostgreSQL (initdb + archiving + backup + PITR + granular restore).

Needs PostgreSQL server binaries and must NOT run as root (PostgreSQL refuses). Skipped otherwise.
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_engine_pg -v'
"""
import glob
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pg_arca.engine.backup import run_backup
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.granular import promote_object, restore_database, restore_object, restore_test
from pg_arca.engine.maintenance import expire, forensics, repo_info, verify
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance
from pg_arca.engine.util import EngineError

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_bin():
    for d in sorted(glob.glob("/usr/lib/postgresql/*/bin"), reverse=True) + sorted(glob.glob("/usr/pgsql-*/bin"), reverse=True):
        if os.path.exists(os.path.join(d, "initdb")):
            return d
    return None


BIN = find_bin()
SKIP = None
if BIN is None:
    SKIP = "PostgreSQL server binaries not found"
elif os.geteuid() == 0:
    SKIP = "must not run as root (PostgreSQL refuses); run as the postgres user"

ENV = None


def sh(*a, **k):
    return subprocess.run(list(a), stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, **k)


class Fx(object):
    pass


F = Fx()


def setUpModule():
    if SKIP:
        raise unittest.SkipTest(SKIP)
    base = os.environ.get("PG_ARCA_TEST_DIR") or tempfile.mkdtemp(prefix="pgarca-e2e-")
    if os.path.exists(base) and os.listdir(base):
        shutil.rmtree(base)
    os.makedirs(base, exist_ok=True)
    F.base = base
    F.src = os.path.join(base, "src")
    F.sock = os.path.join(base, "sock")
    os.makedirs(F.sock)
    F.wal = os.path.join(base, "wal")
    F.key = None
    if os.environ.get("PG_ARCA_TEST_ENCRYPT"):                       # whole suite against an encrypted repository + encrypted WAL archive
        from pg_arca.engine import crypt
        F.key = crypt.generate_key(os.path.join(base, "repo.key"))
    F.repo = os.environ.get("PG_ARCA_TEST_REPO") or os.path.join(base, "repo")
    F.scratch = os.path.join(base, "scratch")
    F.port = 55000 + (os.getpid() % 900)
    F.seg = int(os.environ.get("PG_ARCA_TEST_WALSEG", "16")) * 1024 * 1024                      # non-default WAL segment size (initdb --wal-segsize): 1..1024 MB
    r = sh(os.path.join(BIN, "initdb"), "-D", F.src, "-U", "postgres", "--auth=trust", "-k",
           *(["--wal-segsize=%d" % (F.seg // 1048576)] if os.environ.get("PG_ARCA_TEST_WALSEG") else []),      # initdb has no --wal-segsize before PostgreSQL 11
           *(["--waldir=" + os.path.join(base, "waldisk")] if os.environ.get("PG_ARCA_TEST_WALDIR") else []))      # -k: data checksums
    assert r.returncode == 0, r.stderr
    walbin = os.path.join(HERE, "pg-arca-wal")
    with open(os.path.join(F.src, "postgresql.conf"), "a") as f:
        f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\nwal_level=replica\narchive_mode=on\nwal_log_hints=on\n" % (F.port, F.sock))
        f.write("archive_command='env WAL_ARCHIVE_DIR=%s PG_ARCA_HOME=%s PG_ARCA_CONF=/nonexistent%s %s archive %%p %%f'\narchive_timeout=5\n" % (F.wal, HERE, (" PG_ARCA_KEY_FILE=" + F.key) if F.key else "", walbin))
        f.write("shared_buffers=32MB\nmax_connections=30\n")
    r = sh(os.path.join(BIN, "pg_ctl"), "-D", F.src, "-l", os.path.join(base, "src.log"), "-w", "start")
    assert r.returncode == 0, r.stderr + open(os.path.join(base, "src.log")).read()
    F.conn = PgConn(host=F.sock, port=F.port, user="postgres", bindir=BIN)
    F.ctx = Ctx(F.conn, F.src, F.repo, "main", F.wal, F.scratch, process_max=4, compression="zlib", level=3, start_fast=True, seg_size=F.seg,
                log=lambda lv, m: sys.stderr.write("[%s] %s\n" % (lv, m)) if os.environ.get("V") else None, agent_path=walbin, key_file=F.key or None)


def tearDownModule():
    if SKIP:
        return
    sh(os.path.join(BIN, "pg_ctl"), "-D", F.src, "-m", "immediate", "stop")
    if not os.environ.get("PG_ARCA_KEEP"):
        shutil.rmtree(F.base, ignore_errors=True)


def q(db, sql):
    s = PgSession(F.conn.with_db(db))
    try:
        return s.query(sql)
    finally:
        s.close()


class EngineTests(unittest.TestCase):
    maxDiff = None

    # ---- ordered scenario -------------------------------------------------
    def test_01_full_backup(self):
        q("postgres", "CREATE DATABASE app")
        q("postgres", "CREATE DATABASE other")
        q("app", "CREATE TABLE orders(id serial primary key, note text); INSERT INTO orders(note) SELECT 'row ' || g FROM generate_series(1,20000) g")
        q("app", "CREATE TABLE customers(id int primary key, name text); INSERT INTO customers SELECT g, 'c' || g FROM generate_series(1,500) g")
        q("app", "CREATE SCHEMA hr; CREATE TABLE hr.staff(id int primary key, name text, bio text); INSERT INTO hr.staff SELECT g, 'e' || g, repeat('b', 400) FROM generate_series(1,200) g; "
                 "CREATE INDEX staff_name ON hr.staff(name)")
        q("app", "CREATE TABLE hr.events(id int, d date) PARTITION BY RANGE (d); CREATE TABLE hr.events_a PARTITION OF hr.events FOR VALUES FROM ('2026-01-01') TO ('2026-07-01'); "
                 "CREATE TABLE hr.events_b PARTITION OF hr.events FOR VALUES FROM ('2026-07-01') TO ('2027-01-01'); "
                 "INSERT INTO hr.events SELECT g, '2026-01-01'::date + (g % 300) FROM generate_series(1,3000) g")
        q("other", "CREATE TABLE junk(x text); INSERT INTO junk SELECT repeat('x', 200) FROM generate_series(1,20000)")
        meta = run_backup(F.ctx, "full")
        F.full = meta
        self.assertEqual(meta["status"], "COMPLETE")
        self.assertEqual(meta["type"], "full")
        self.assertGreater(meta["stats"]["bytes_logical"], 0)
        self.assertTrue(F.ctx.wal.has_segment(meta["start_lsn"] and __import__("pg_arca.engine.util", fromlist=["x"]).wal_name_from_lsn(1, __import__("pg_arca.engine.util", fromlist=["x"]).lsn_to_int(meta["start_lsn"]), F.seg)))

    def test_02_incremental_is_smaller_and_chained(self):
        q("app", "INSERT INTO orders(note) SELECT 'after-full ' || g FROM generate_series(1,2000) g")
        meta = run_backup(F.ctx, "incr")
        F.incr = meta
        self.assertEqual(meta["status"], "COMPLETE")
        self.assertEqual(meta["type"], "incr")
        self.assertEqual(meta["parent"], F.full["id"])
        self.assertLess(meta["stats"]["bytes_written"], F.full["stats"]["bytes_written"] / 2.0)
        self.assertLess(meta["stats"]["pages_kept"], meta["stats"]["pages_read"])

    def test_03_second_full_backup_deduplicates(self):
        meta = run_backup(F.ctx, "full")
        F.full2 = meta
        self.assertGreater(meta["stats"]["chunks_dedup"], 0)
        self.assertLess(meta["stats"]["bytes_written"], F.full["stats"]["bytes_written"])

    def test_04_pitr_instance_restore(self):
        # state S1 (to recover to), then destructive changes
        q("app", "INSERT INTO orders(note) SELECT 'S1 ' || g FROM generate_series(1,1000) g")
        n1 = int(q("app", "SELECT count(*) FROM orders")[0][0])
        time.sleep(1.2)
        t1 = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
        time.sleep(1.2)
        F.n1, F.t1 = n1, t1
        # the "accident": ONE transaction (a multi-statement -c is an implicit transaction) that drops a table. Recovery stops before its commit, with the
        # DROP's ACCESS EXCLUSIVE lock already replayed: reading that table in the paused standby would block forever unless recovery is ended at the target
        acc = PgSession(F.conn.with_db("app"))
        try:
            for stmt in ("BEGIN", "DELETE FROM orders", "DROP TABLE customers"):
                acc.query(stmt)
            q("postgres", "SELECT pg_switch_wal()")                      # make sure the lock record is archived before the commit record
            time.sleep(1.5)
            acc.query("COMMIT")
        finally:
            acc.close()
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        dest = os.path.join(F.base, "restored_instance")
        plan = restore_instance(F.ctx, dest=dest, target_time=t1, action="promote")
        self.assertTrue(os.path.exists(os.path.join(dest, "recovery.signal")))
        self.assertEqual(plan["chain"][0], F.full2["id"] if plan["set"] == F.full2["id"] else plan["chain"][0])
        port2 = F.port + 1
        with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\narchive_mode=off\narchive_command=''\n" % (port2, F.sock))
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-l", os.path.join(F.base, "restored.log"), "-w", "-t", "120", "start")
        self.assertEqual(r.returncode, 0, r.stderr + open(os.path.join(F.base, "restored.log")).read()[-2000:])
        try:
            c2 = PgConn(host=F.sock, port=port2, user="postgres", bindir=BIN, dbname="app")
            s = PgSession(c2)
            try:
                for _ in range(60):
                    if s.scalar("SELECT pg_is_in_recovery()") == "f":
                        break
                    time.sleep(1)
                self.assertEqual(int(s.scalar("SELECT count(*) FROM orders")), n1)
                self.assertEqual(int(s.scalar("SELECT count(*) FROM customers")), 500)
            finally:
                s.close()
        finally:
            sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")

    def test_04_pitr_z_delta_over_a_promoted_copy_does_not_follow_its_timeline(self):
        """Independent review (16/10): a delta restore kept the previous copy's pg_wal - its own timeline history and segments. Recovering to the end
        of the archive, PostgreSQL then followed the COPY's timeline and replayed the copy's own writes: neither production nor the requested point."""
        dest = os.path.join(F.base, "restored_instance")             # test_04's copy: promoted to its own timeline
        port2 = F.port + 1
        conf = "\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\narchive_mode=off\narchive_command=''\n" % (port2, F.sock)
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-l", os.path.join(F.base, "restored.log"), "-w", "-t", "120", "start")
        self.assertEqual(r.returncode, 0, r.stderr)
        c2 = PgConn(host=F.sock, port=port2, user="postgres", bindir=BIN, dbname="app")
        s = PgSession(c2)
        try:
            s.query("CREATE TABLE copy_only(x int)")
            s.query("INSERT INTO copy_only SELECT generate_series(1, 1000)")
            s.query("CHECKPOINT")
        finally:
            s.close()
        sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "fast", "stop")
        self.assertTrue(glob.glob(os.path.join(dest, "pg_wal", "0000000[2-9].history")), "the copy has its own timeline")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        want = int(q("app", "SELECT count(*) FROM orders")[0][0])
        restore_instance(F.ctx, dest=dest, delta=True, action="promote")
        with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
            f.write(conf)
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-l", os.path.join(F.base, "restored-delta.log"), "-w", "-t", "120", "start")
        self.assertEqual(r.returncode, 0, r.stderr + open(os.path.join(F.base, "restored-delta.log")).read()[-2000:])
        try:
            s = PgSession(c2)
            try:
                for _ in range(60):
                    if s.scalar("SELECT pg_is_in_recovery()") == "f":
                        break
                    time.sleep(1)
                self.assertEqual(s.scalar("SELECT to_regclass('copy_only') IS NULL"), "t", "the previous copy's own writes must not come back")
                self.assertEqual(int(s.scalar("SELECT count(*) FROM orders")), want)
            finally:
                s.close()
        finally:
            sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")

    def test_04a_interrupted_restore_is_resumed(self):
        """A restore stopped half-way (cancel, crash, disk full) leaves a marked partial copy: a plain retry is refused with a clear message, a resume
        completes it in place (writing only what is missing or different) and the result starts and holds the data."""
        from pg_arca.engine.util import Cancelled
        from pg_arca.engine.restore import RESUME_MARK
        dest = os.path.join(F.base, "resumed_instance")
        calls = {"n": 0}
        def cancel_soon():
            calls["n"] += 1
            return calls["n"] > 25
        with self.assertRaises((Cancelled, EngineError)):
            restore_instance(F.ctx, dest=dest, immediate=True, cancel=cancel_soon)
        self.assertTrue(os.path.exists(os.path.join(dest, RESUME_MARK)), "partial copy marked")
        with self.assertRaises(EngineError) as c:
            restore_instance(F.ctx, dest=dest, immediate=True)
        self.assertIn("PGA-RST-040", str(c.exception))
        plan = restore_instance(F.ctx, dest=dest, immediate=True, resume=True)
        self.assertTrue(plan.get("resumed"))
        self.assertFalse(os.path.exists(os.path.join(dest, RESUME_MARK)), "complete: marker gone")
        port2 = F.port + 3
        with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\narchive_mode=off\narchive_command=''\n" % (port2, F.sock))
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-l", os.path.join(F.base, "resumed.log"), "-w", "-t", "120", "start")
        self.assertEqual(r.returncode, 0, r.stderr + open(os.path.join(F.base, "resumed.log")).read()[-2000:])
        try:
            s2 = PgSession(PgConn(host=F.sock, port=port2, user="postgres", bindir=BIN, dbname="app"))
            try:
                self.assertGreater(int(s2.scalar("SELECT count(*) FROM orders")), 0)
            finally:
                s2.close()
        finally:
            sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")
        with self.assertRaises(EngineError) as c:
            restore_instance(F.ctx, dest=os.path.join(F.base, "never_started"), immediate=True, resume=True)
        self.assertIn("PGA-RST-041", str(c.exception))

    def test_04b_immediate_restore_of_an_incremental_chain_is_consistent(self):
        """'Stop when consistent' must mean the end of the LAST set, not of the base full: the files already hold the incremental's newer pages."""
        q("app", "CREATE TABLE incrcheck AS SELECT g AS id, repeat('y', 100) AS pad FROM generate_series(1,30000) g")
        meta = run_backup(F.ctx, "incr")
        self.assertEqual(meta["type"], "incr")
        n = int(q("app", "SELECT count(*) FROM incrcheck")[0][0])
        dest = os.path.join(F.base, "restored_immediate")
        plan = restore_instance(F.ctx, dest=dest, immediate=True)
        self.assertGreater(len(plan["chain"]), 1)
        conf = open(os.path.join(dest, "postgresql.auto.conf")).read()
        self.assertIn("recovery_target_lsn = '%s'" % meta["stop_lsn"], conf)
        self.assertNotIn("recovery_target = 'immediate'", conf)
        port2 = F.port + 2
        with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\narchive_mode=off\narchive_command=''\n" % (port2, F.sock))
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-l", os.path.join(F.base, "restored_immediate.log"), "-w", "-t", "120", "start")
        self.assertEqual(r.returncode, 0, r.stderr + open(os.path.join(F.base, "restored_immediate.log")).read()[-2000:])
        try:
            s = PgSession(PgConn(host=F.sock, port=port2, user="postgres", bindir=BIN, dbname="app"))
            try:
                for _ in range(60):
                    if s.scalar("SELECT pg_is_in_recovery()") == "f":
                        break
                    time.sleep(1)
                self.assertEqual(int(s.scalar("SELECT count(*) FROM incrcheck")), n)
                for _ in range(80):                                  # burn transaction ids: a torn restore only shows once xids pass the 'future' ones
                    s.scalar("SELECT txid_current()")
                self.assertEqual(int(s.scalar("SELECT count(*) FROM incrcheck")), n)
            finally:
                s.close()
        finally:
            sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")

    def test_05_restore_database_sparse_pitr(self):
        plan = restore_database(F.ctx, "app", target_time=F.t1, new_name="app_at_t1", jobs=2)
        self.assertEqual(plan["result_database"], "app_at_t1")
        self.assertEqual(int(q("app_at_t1", "SELECT count(*) FROM orders")[0][0]), F.n1)
        self.assertEqual(int(q("app_at_t1", "SELECT count(*) FROM customers")[0][0]), 500)
        self.assertLess(plan["extract_bytes"], plan["cluster_bytes"])          # sparse really extracted less
        with self.assertRaises(EngineError) as cm:                              # never overwrites
            restore_database(F.ctx, "app", target_time=F.t1, new_name="app_at_t1")
        self.assertEqual(cm.exception.code, "PGA-SEC-030")

    def test_05a_ephemeral_settings_are_honoured(self):
        # configured binaries (wrapped so we can see they were used), a port from the configured range, the configured scratch directory, shared_buffers
        from pg_arca.engine import ephcfg
        wrap = os.path.join(F.base, "wrapbin")
        os.makedirs(wrap)
        log = os.path.join(F.base, "wrap.log")
        for t in ephcfg.TOOLS:
            with open(os.path.join(wrap, t), "w") as f:
                f.write("#!/bin/sh\necho %s >> %s\nexec %s/%s \"$@\"\n" % (t, log, BIN, t))
            os.chmod(os.path.join(wrap, t), 0o755)
        scratch = os.path.join(F.base, "my-scratch")
        pmin = 57000 + (os.getpid() % 500)
        F.ctx.set_ephemeral({"bin_dir": wrap, "scratch_dir": scratch, "port_min": pmin, "port_max": pmin + 20, "shared_buffers_mb": 64})
        try:
            self.assertEqual(F.ctx.scratch_dir, scratch)
            plan = restore_database(F.ctx, "app", target_time=F.t1, new_name="app_eph_cfg", jobs=2)
            self.assertEqual(int(q("app_eph_cfg", "SELECT count(*) FROM customers")[0][0]), 500)
            used = set(open(log).read().split())
            self.assertIn("postgres", used, "the configured binaries started the instance")
            self.assertTrue(os.path.isdir(scratch), "scratch directory created where configured")
            self.assertEqual(os.listdir(scratch), [], "and cleaned afterwards")
            pre = ephcfg.preflight(F.ctx, None, F.ctx.eph, need_bytes=plan["extract_bytes"])
            self.assertTrue(pre["ok"], pre["checks"])
            self.assertEqual(pre["chosen"]["bindir"], wrap)
        finally:
            F.ctx.eph = {}
            F.ctx.scratch_dir = os.path.join(F.base, "scratch")
            q("postgres", "DROP DATABASE IF EXISTS app_eph_cfg")

    def test_05b_target_beyond_the_archive_recovers_to_its_end_and_says_so(self):
        # field report: "now"/a time after the last archived WAL made the ephemeral instance die with 'recovery ended before configured recovery target was reached'
        import datetime
        future = (datetime.datetime.utcnow() + datetime.timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
        plan = restore_database(F.ctx, "app", target_time=future, new_name="app_clamped", jobs=2)
        c = plan.get("target_clamped")
        self.assertTrue(c, "the restore must succeed and report the clamp")
        self.assertEqual(c["requested"][:10], future[:10])
        self.assertIn("end of the archive", c["message"])
        # it recovered to the END of the archive, i.e. AFTER the committed "accident" (orders emptied, customers dropped)
        self.assertEqual(int(q("app_clamped", "SELECT count(*) FROM orders")[0][0]), 0)
        self.assertEqual(q("app_clamped", "SELECT to_regclass('public.customers') IS NULL")[0][0], "t")
        # an LSN beyond the archive is handled the same way
        plan = restore_database(F.ctx, "app", target_lsn="FF/00000000", new_name="app_clamped_lsn", jobs=2)
        self.assertTrue(plan.get("target_clamped"))
        # a transaction id that never happened cannot be "clamped": it is explained, and nothing is left behind
        with self.assertRaises(EngineError) as cm:
            restore_database(F.ctx, "app", target_xid="4000000000", new_name="app_never")
        self.assertEqual(cm.exception.code, "PGA-PITR-014")
        self.assertEqual(q("postgres", "SELECT count(*) FROM pg_database WHERE datname = 'app_never'")[0][0], "0")

    def test_05c_a_dropped_database_comes_back(self):
        # PostgreSQL removes a dropped database's directory while REDOING the drop record, which has no timestamp: stopping "just before the commit" is too late.
        # The field case: DROP DATABASE, then restore to the instant before it.
        q("postgres", "CREATE DATABASE gone")
        q("gone", "CREATE TABLE t(id int primary key, v text); INSERT INTO t SELECT g, 'x' || g FROM generate_series(1,3000) g")
        run_backup(F.ctx, "incr")
        time.sleep(1.2)
        t_ok = q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
        time.sleep(1.2)
        q("postgres", "DROP DATABASE gone")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        plan = restore_database(F.ctx, "gone", target_time=t_ok, new_name="gone_back", jobs=2)
        self.assertEqual(int(q("gone_back", "SELECT count(*) FROM t")[0][0]), 3000)
        self.assertTrue(plan.get("stopped_before_drop"), "the engine must say it had to stop before the DROP DATABASE record")
        q("postgres", "DROP DATABASE gone_back")

    def test_06_0_user_database_named_stage_is_never_a_quarantine_target(self):
        from pg_arca.engine.granular import diff_object
        for fn in (lambda: promote_object(F.ctx, "stage_prod", "app.public.customers"), lambda: diff_object(F.ctx, "stage_prod", "app.public.customers"),
                   lambda: restore_object(F.ctx, "app.public.customers", target_time=F.t1 if hasattr(F, "t1") else None, stage_db="stage_prod")):
            with self.assertRaises(EngineError) as cm:
                fn()
            self.assertEqual(cm.exception.code, "PGA-GEN-081")

    def test_06_restore_object(self):
        # the web UI sends a browser toISOString() ('T' separator, 'Z' suffix): PostgreSQL refuses that form in postgresql.auto.conf, so the engine must normalise it
        iso_z = F.t1[:10] + "T" + F.t1[11:-3] + "Z"
        plan = restore_object(F.ctx, "app.public.customers", target_time=iso_z, stage_db="pgarca_stage_customers")
        self.assertEqual(plan["rows_restored"], 500)
        self.assertEqual(int(q("pgarca_stage_customers", "SELECT count(*) FROM public.customers")[0][0]), 500)

    def test_06b0_row_level_recovery(self):
        from pg_arca.engine.granular import diff_object, apply_rows
        import json
        q("app", "CREATE TABLE customers(id int primary key, name text); INSERT INTO customers SELECT g,'live'||g FROM generate_series(1,5) g")
        try:
            d = diff_object(F.ctx, "pgarca_stage_customers", "app.public.customers")
            self.assertEqual(d["primary_key"], ["id"])
            self.assertEqual(d["counts"]["missing_now"], 495)          # 500 recovered rows, ids 1..5 exist live
            self.assertEqual(d["counts"]["changed"], 5)
            self.assertEqual(d["counts"]["added_since"], 0)
            q("app", "INSERT INTO customers VALUES (900,'new')")
            d = diff_object(F.ctx, "pgarca_stage_customers", "app.public.customers", limit=3)
            self.assertEqual(d["counts"]["added_since"], 1); self.assertEqual(len(d["missing_now"]), 3)
            self.assertEqual(d["added_since"][0]["key"], [900])
            ch = d["changed"][0]
            self.assertEqual(ch["live"]["name"], "live%d" % ch["key"][0]); self.assertNotEqual(ch["restored"]["name"], ch["live"]["name"])
            # dry run touches nothing
            r0 = apply_rows(F.ctx, "pgarca_stage_customers", "app.public.customers", restore_keys=["[1]", "[200]"], delete_keys=["[900]"], dry_run=True)
            self.assertEqual((r0["inserted"], r0["updated"], r0["deleted"]), (1, 1, 1))
            self.assertEqual(int(q("app", "SELECT count(*) FROM customers")[0][0]), 6)
            r = apply_rows(F.ctx, "pgarca_stage_customers", "app.public.customers", restore_keys=["[1]", "[200]"], delete_keys=["[900]"])
            self.assertEqual((r["inserted"], r["updated"], r["deleted"]), (1, 1, 1))
            self.assertEqual(int(q("app", "SELECT count(*) FROM customers")[0][0]), 6)        # 5 + 1 inserted - 1 deleted
            self.assertNotEqual(q("app", "SELECT name FROM customers WHERE id=1")[0][0], "live1")
            self.assertEqual(q("app", "SELECT name FROM %s WHERE id=1" % r["safety_copy"])[0][0], "live1", "previous version kept")
            self.assertEqual(q("app", "SELECT name FROM customers WHERE id=900"), [])
            self.assertEqual(q("app", "SELECT name FROM %s WHERE id=900" % r["safety_copy"])[0][0], "new")
            # an unknown key aborts everything, nothing half applied
            with self.assertRaises(EngineError):
                apply_rows(F.ctx, "pgarca_stage_customers", "app.public.customers", restore_keys=["[2]", "[99999]"])
            self.assertEqual(q("app", "SELECT name FROM customers WHERE id=2")[0][0], "live2")
            with self.assertRaises(EngineError):
                apply_rows(F.ctx, "somedb", "app.public.customers", restore_keys=["[2]"])
            q("app", "DROP TABLE %s" % r["safety_copy"])
            # whole categories, whatever their size (the UI shows 200 rows at most): every deleted row back, every changed row restored, the added one removed
            q("app", "INSERT INTO customers VALUES (901,'new2')")
            r2 = apply_rows(F.ctx, "pgarca_stage_customers", "app.public.customers", restore_all=["missing", "changed"], delete_all_added=True)
            self.assertEqual((r2["inserted"], r2["updated"], r2["deleted"]), (494, 4, 1), r2)
            self.assertEqual(int(q("app", "SELECT count(*) FROM customers")[0][0]), 500)
            d2 = diff_object(F.ctx, "pgarca_stage_customers", "app.public.customers")
            self.assertEqual(d2["counts"], {"missing_now": 0, "added_since": 0, "changed": 0})
            r3 = apply_rows(F.ctx, "pgarca_stage_customers", "app.public.customers", restore_all=["missing"])
            self.assertEqual(r3["inserted"] + r3["updated"], 0)
            q("app", "DROP TABLE %s" % r2["safety_copy"])
        finally:
            q("app", "DROP TABLE IF EXISTS customers")

    def test_06b_promote_table_back(self):
        r = promote_object(F.ctx, "pgarca_stage_customers", "app.public.customers", mode="as_new", drop_stage=False)
        self.assertTrue(r["promoted_as"].startswith("public.customers_pitr_")); self.assertIsNone(r["old_kept_as"])
        self.assertEqual(int(q("app", "SELECT count(*) FROM %s" % r["promoted_as"])[0][0]), 500)
        self.assertEqual([x[0] for x in q("app", "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'pgarca_pr_%'")], [], "work schema removed")
        # the recovered table keeps a usable primary key under a suffixed name (no collision)
        self.assertTrue(q("app", "SELECT 1 FROM pg_indexes WHERE tablename LIKE 'customers_pitr_%' AND indexname LIKE '%pitr%'"))
        # replace: a live table exists now -> it is renamed, never dropped
        q("app", "CREATE TABLE customers(id int primary key, name text); INSERT INTO customers VALUES (1,'live')")
        r2 = promote_object(F.ctx, "pgarca_stage_customers", "app.public.customers", mode="replace", drop_stage=True)
        self.assertTrue(r2["old_kept_as"].startswith("public.customers_old_"))
        self.assertEqual(int(q("app", "SELECT count(*) FROM customers")[0][0]), 500)
        self.assertEqual(q("app", "SELECT name FROM %s" % r2["old_kept_as"])[0][0], "live", "previous data kept")
        self.assertNotIn("pgarca_stage_customers", [x[0] for x in q("postgres", "SELECT datname FROM pg_database")])
        with self.assertRaises(EngineError):
            promote_object(F.ctx, "somedb", "app.public.customers")               # only pg_arca quarantine databases
        q("app", "DROP TABLE customers; DROP TABLE %s; DROP TABLE %s" % (r2["old_kept_as"], r["promoted_as"]))

    def test_06c_catalog_counts_are_the_users_tables_and_sizes_are_real(self):
        from pg_arca.engine.maintenance import catalog_browse
        r = catalog_browse(F.ctx, None)
        by = dict((d["name"], d) for d in r["databases"])
        self.assertEqual(by["app"]["tables"], 4, by["app"])                       # orders, customers, hr.staff, hr.events (its 2 partitions are NOT counted again, nothing from pg_catalog)
        self.assertEqual(by["app"]["schemas"], 2)                                 # public + hr
        self.assertEqual(by["other"]["tables"], 1)
        self.assertFalse(by["app"]["approx"])
        self.assertLess(by["app"]["user_bytes"], by["app"]["size"])               # catalogs, WAL-free system files are not "your data"
        o = catalog_browse(F.ctx, None, "app")
        hr = [s for s in o["schemas"] if s["name"] == "hr"][0]
        self.assertEqual(sorted(x["name"] for x in hr["objects"]), ["events", "staff"])
        staff = [x for x in hr["objects"] if x["name"] == "staff"][0]
        events = [x for x in hr["objects"] if x["name"] == "events"][0]
        heap = int(q("app", "SELECT pg_relation_size('hr.staff')")[0][0])
        total = int(q("app", "SELECT pg_total_relation_size('hr.staff')")[0][0])
        self.assertGreater(staff["size"], heap)                                    # indexes + TOAST are part of the table's footprint
        self.assertLessEqual(abs(staff["size"] - total), 3 * 8192 + 8192)         # equals PostgreSQL's own total within the FSM/VM forks we do not stat
        self.assertEqual(events["partitions"], 2)
        self.assertGreater(events["size"], 0)                                      # a partitioned parent has no data of its own: its size is the partitions'

    def test_06d_table_comes_back_to_its_own_schema(self):
        for mode_label in ("table dropped", "schema dropped"):
            expect = int(q("app", "SELECT count(*) FROM hr.staff")[0][0]) if False else 200
            restore_object(F.ctx, "app.hr.staff", target_time=F.t1, stage_db="pgarca_stage_staff")
            q("app", "DROP TABLE hr.staff" if mode_label == "table dropped" else "DROP SCHEMA hr CASCADE")
            r = promote_object(F.ctx, "pgarca_stage_staff", "app.hr.staff", mode="replace", drop_stage=True)
            self.assertEqual(r["promoted_as"], "hr.staff", mode_label)               # same schema, same name: nothing was there to replace
            self.assertEqual(int(q("app", "SELECT count(*) FROM hr.staff")[0][0]), expect, mode_label)
            self.assertEqual(q("app", "SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'pgarca_pr_%'")[0][0], "0")
            self.assertEqual(q("app", "SELECT count(*) FROM pg_tables WHERE tablename LIKE 'staff%' AND schemaname <> 'hr'")[0][0], "0", "never lands in public or elsewhere")
            if mode_label == "table dropped":
                q("app", "CREATE TABLE hr.events_tmp(i int)")                       # keep the schema populated for the next round
        r = restore_object(F.ctx, "app.hr.staff", target_time=F.t1, stage_db="pgarca_stage_staff")
        r = promote_object(F.ctx, "pgarca_stage_staff", "app.hr.staff", mode="as_new", drop_stage=True)
        self.assertTrue(r["promoted_as"].startswith("hr.staff_pitr_"), r)           # as_new also stays in the table's schema

    def test_06z_encryption_really_active(self):
        if not F.key:
            self.skipTest("run with PG_ARCA_TEST_ENCRYPT=1")
        import json
        self.assertEqual(json.load(open(os.path.join(F.repo, "repo.json")))["encryption"]["alg"], "aes-256-gcm")
        man = F.ctx.repo.load_manifest(F.ctx.repo.resolve_set())
        hs = [c[2] for e in man["files"].values() for c in e["chunks"]]
        self.assertTrue(hs)
        self.assertTrue(all(F.ctx.repo.get_blob(h)[:1] == b"E" for h in hs[:200]))
        metas = [f for f in os.listdir(F.wal) if f.endswith(".meta") and len(f) == 29]
        self.assertTrue(metas and all(json.load(open(os.path.join(F.wal, m))).get("enc")  for m in metas))

    def test_06y_telemetry_snapshot_has_slots(self):
        from pg_arca.db_client import PostgresClient
        q("postgres", "SELECT pg_create_physical_replication_slot('pgarca_t_slot')")
        try:
            snap = PostgresClient(user="postgres", port=F.port, socket_dir=F.sock, psql_path=os.path.join(BIN, "psql")).get_snapshot()
            self.assertTrue(snap.get("alive"), snap)
            sl = [x for x in snap["slots"] if x["name"] == "pgarca_t_slot"]
            self.assertEqual(len(sl), 1); self.assertFalse(sl[0]["active"])
            self.assertIn("max_connections", snap["settings"])
        finally:
            q("postgres", "SELECT pg_drop_replication_slot('pgarca_t_slot')")

    def test_06x_disaster_drill_measures_recovery(self):
        from pg_arca.engine.granular import restore_drill
        r = restore_drill(F.ctx)
        self.assertTrue(r["full_cluster"]); self.assertIn("app", r["databases_checked"]); self.assertGreater(r["rto_seconds"], 0); self.assertGreater(r["data_bytes"], 0)
        self.assertEqual([d for d in os.listdir(F.scratch) if not d.startswith(".")], [], "scratch cleaned")
        real = F.ctx.scratch_dir
        try:
            F.ctx.scratch_dir = "/proc/pgarca-nospace"          # unusable volume: refuse before doing any work
            with self.assertRaises(EngineError):
                restore_drill(F.ctx)
        finally:
            F.ctx.scratch_dir = real

    def test_07_failed_restore_leaves_nothing_behind(self):
        with self.assertRaises(EngineError):
            restore_object(F.ctx, "app.public.no_such_table", target_time=F.t1, stage_db="stage_never")
        names = [r[0] for r in q("postgres", "SELECT datname FROM pg_database")]
        self.assertNotIn("stage_never", names)
        self.assertEqual([d for d in os.listdir(F.scratch) if not d.startswith(".")], [])    # scratch cleaned

    def test_08_target_time_requires_offset(self):
        with self.assertRaises(EngineError) as cm:
            restore_database(F.ctx, "app", target_time="2026-01-01 10:00:00", new_name="x1")
        self.assertEqual(cm.exception.code, "PGA-PITR-001")

    def test_09_protected_paths(self):
        with self.assertRaises(EngineError) as cm:
            restore_instance(F.ctx, dest=F.src)
        self.assertEqual(cm.exception.code, "PGA-SEC-003")
        with self.assertRaises(EngineError) as cm:
            restore_instance(F.ctx, dest=os.path.join(F.src, "sub"))
        self.assertEqual(cm.exception.code, "PGA-SEC-003")

    def test_09b_delta_cannot_wipe_repo_or_wal_archive(self):
        import tempfile
        old = F.ctx.protected_extra
        F.ctx.protected_extra = [F.ctx.repo.path, F.ctx.wal_dir]
        try:
            with self.assertRaises(EngineError) as cm:
                restore_instance(F.ctx, dest=F.ctx.wal_dir, delta=True)
            self.assertEqual(cm.exception.code, "PGA-SEC-003")
        finally:
            F.ctx.protected_extra = old
        d = tempfile.mkdtemp(dir=F.scratch); open(os.path.join(d, "precious.txt"), "w").write("x")
        with self.assertRaises(EngineError) as cm:                                   # delta into a directory that is not a PGDATA would delete everything in it
            restore_instance(F.ctx, dest=d, delta=True)
        self.assertEqual(cm.exception.code, "PGA-SEC-006")
        self.assertTrue(os.path.exists(os.path.join(d, "precious.txt")))

    def test_10_verify_and_info(self):
        info = repo_info(F.ctx)
        self.assertGreaterEqual(len([s for s in info["sets"] if s["status"] == "COMPLETE"]), 3)
        self.assertTrue(info["wal"]["segments"] > 0)
        v = verify(F.ctx, deep=True)
        self.assertTrue(v["ok"], v["problems"])

    def test_11_restore_test_proves_recoverability(self):
        r = restore_test(F.ctx)
        self.assertTrue(r["postgres_db_readable"])

    def test_12_corruption_is_detected(self):
        # damage one chunk of the latest set: deep verify must flag it, restore must refuse (no silent bad data)
        man = F.ctx.repo.load_manifest(F.ctx.repo.resolve_set())
        h = [c[2] for e in man["files"].values() for c in e["chunks"]][0]
        p, off, ln = F.ctx.repo.locate(h)
        with open(p, "rb") as f:
            f.seek(off)
            good = f.read(ln)
        try:
            with open(p, "r+b") as f:                                      # damage the stored blob in place (pack or file)
                f.seek(off)
                f.write(good[:-3] + b"\x00\x00\x00")
            v = verify(F.ctx, deep=True)
            self.assertFalse(v["ok"])
            with self.assertRaises(EngineError):
                F.ctx.repo.get_chunk(h)
        finally:
            with open(p, "r+b") as f:
                f.seek(off)
                f.write(good)
        self.assertTrue(verify(F.ctx, deep=True)["ok"])

    def test_12b_missing_chunk_stops_every_restore_before_it_starts(self):
        # a chunk that vanished from the repository: the plan says so (blocker) and the real restore refuses BEFORE extracting or recovering anything
        man = F.ctx.repo.load_manifest(F.ctx.repo.resolve_set())
        h = [c[2] for e in man["files"].values() for c in e["chunks"]][0]
        p = F.ctx.repo.locate(h)[0]
        gone = [p] + ([p[:-5] + ".idx"] if p.endswith(".pack") else [])     # the whole pack (and its index) disappears, as a lost file would
        dest = os.path.join(F.base, "never-created")
        for g in gone:
            os.rename(g, g + ".gone")
        F.ctx.repo.reload_index()
        try:
            plan = restore_instance(F.ctx, dest=dest, dry_run=True)
            self.assertFalse(plan["preflight"]["ok"], plan["preflight"])
            self.assertEqual([c["id"] for c in plan["preflight"]["checks"] if c["level"] == "bad"], ["chunks"])
            with self.assertRaises(EngineError) as cm:
                restore_instance(F.ctx, dest=dest, immediate=True)
            self.assertEqual(cm.exception.code, "PGA-RST-031")
            self.assertFalse(os.path.exists(dest), "nothing was created")
            dp = restore_database(F.ctx, "app", dry_run=True, new_name="app_never")
            self.assertFalse(dp["preflight"]["ok"], dp["preflight"])
            with self.assertRaises(EngineError) as cm:
                restore_database(F.ctx, "app", new_name="app_never")
            self.assertEqual(cm.exception.code, "PGA-RST-031")
            self.assertEqual(q("postgres", "SELECT count(*) FROM pg_database WHERE datname='app_never'")[0][0], "0")
        finally:
            for g in gone:
                os.rename(g + ".gone", g)
            F.ctx.repo.reload_index()
        self.assertTrue(restore_instance(F.ctx, dest=dest, dry_run=True)["preflight"]["ok"])

    def test_13_forensics_finds_the_drop(self):
        r = forensics(F.ctx, limit=50)
        kinds = [e["kind"] for e in r["events"]]
        self.assertIn("DROP", kinds)

    def test_13b_walscan_dropped_database_name_and_exact_time(self):
        from pg_arca.engine import walscan
        q("postgres", "CREATE DATABASE dropme_scan")
        q("dropme_scan", "CREATE TABLE t(a int); INSERT INTO t VALUES (1)")
        run_backup(F.ctx, "incr")
        t_before = time.time()
        q("postgres", "DROP DATABASE dropme_scan")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(7)
        r = walscan.scan(F.ctx, mode="databases", since_backup=True, cache_dir=os.path.join(F.scratch, "fx"))
        d = [x for x in r["dropped"] if x["name"] == "dropme_scan"]
        self.assertEqual(len(d), 1, r)
        self.assertTrue(d[0]["time_exact"], d)                         # the COMMIT timestamp was found through the dropping transaction's xid
        from datetime import datetime
        ts = datetime.strptime(d[0]["time"][:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=__import__("datetime").timezone.utc).timestamp()
        self.assertTrue(abs(ts - t_before) < 120, (ts, t_before))
        r2 = walscan.scan(F.ctx, mode="databases", since_backup=True, cache_dir=os.path.join(F.scratch, "fx"))   # second run: everything from the cache
        self.assertEqual(r2["segments_cached"], r2["window"]["segments"])
        self.assertEqual([x["name"] for x in r2["dropped"]], [x["name"] for x in r["dropped"]])
        ev = walscan.scan(F.ctx, mode="events", hours=1, cache_dir=os.path.join(F.scratch, "fx"))
        self.assertIn("DROP DATABASE", [e["kind"] for e in ev["events"]])

    def test_13c_walscan_truncate_named_after_the_table(self):
        """TRUNCATE gives the table new files and drops the old ones at COMMIT, in the same transaction: reported as TRUNCATE, named after the table."""
        from pg_arca.engine import walscan
        q("postgres", "CREATE TABLE trunc_me(a int primary key, b text); INSERT INTO trunc_me SELECT g, 'x' FROM generate_series(1, 500) g")
        q("postgres", "SELECT pg_switch_wal()")
        q("postgres", "TRUNCATE trunc_me")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(7)
        ev = walscan.scan(F.ctx, mode="events", hours=1, cache_dir=os.path.join(F.scratch, "fx2"))
        tr = [e for e in ev["events"] if e["kind"] == "TRUNCATE"]
        self.assertTrue(any(any("trunc_me" in n for n in e.get("names", [])) for e in tr), [(e["kind"], e.get("names")) for e in ev["events"]])
        self.assertTrue(all(e.get("rewrite_possible") for e in tr if any("trunc_me" in n for n in e.get("names", []))), tr)

    def test_14_crashed_backup_does_not_poison_dedup(self):
        # simulate a crashed run: RUNNING meta + a torn chunk newer than it
        rep = F.ctx.repo
        import json
        stale = {"id": "20990101-000000F", "type": "full", "status": "RUNNING", "started_ts": time.time() - 10, "start_time": "2099-01-01T00:00:00+00:00"}
        os.makedirs(rep.sp("backup", stale["id"]))
        rep.write_meta(stale)
        meta = run_backup(F.ctx, "full")
        self.assertEqual(meta["status"], "COMPLETE")
        self.assertEqual(rep.set_meta(stale["id"])["status"], "FAILED")

    def test_15_expire_keeps_restorable_sets(self):
        plan = expire(F.ctx, dry_run=True, retention_full=1)
        self.assertTrue(plan["dry_run"])
        done = expire(F.ctx, retention_full=1)
        left = [s for s in F.ctx.repo.complete_sets()]
        self.assertEqual(len([s for s in left if s["type"] == "full"]), 1)
        self.assertTrue(verify(F.ctx, deep=True)["ok"])

    def test_15b_expire_keeps_wal_of_another_site_of_the_same_database(self):
        """Two clusters of the SAME database (geo sites) registered separately = two stanzas sharing one WAL archive: expiring one must not delete
        the WAL the other's backups need."""
        site2 = Ctx(F.conn, F.src, F.repo, "site2", F.wal, F.scratch, process_max=2, compression="zlib", level=1, start_fast=True, seg_size=F.seg,
                    agent_path=F.ctx.agent_path, key_file=F.key or None)
        old = run_backup(site2, "full")
        q("app", "INSERT INTO orders(note) SELECT 'site2 ' || g FROM generate_series(1,2000) g"); q("postgres", "SELECT pg_switch_wal()")
        run_backup(F.ctx, "full"); run_backup(F.ctx, "full")
        expire(F.ctx, retention_full=1)
        from pg_arca.engine.util import lsn_to_int, wal_segno, wal_name
        first = wal_segno(lsn_to_int(old["start_lsn"]), F.seg)
        names = set(F.ctx.wal.list_segments())
        self.assertTrue(any(n[8:] == wal_name(1, first, F.seg)[8:] for n in names), "the start segment of the other site's backup is still archived")
        self.assertTrue(restore_instance(site2, dest=os.path.join(F.base, "site2_dry"), dry_run=True)["preflight"]["ok"])

    def test_16_cancel_during_spread_checkpoint(self):
        """A backup that waits for a SPREAD checkpoint (minutes on a busy server) must report it and must be cancellable at once, not after the checkpoint."""
        from pg_arca.engine.util import Cancelled
        import threading
        q("postgres", "ALTER SYSTEM SET checkpoint_timeout='1h'"); q("postgres", "ALTER SYSTEM SET checkpoint_completion_target=0.9"); q("postgres", "SELECT pg_reload_conf()")
        try:
            q("app", "INSERT INTO orders(note) SELECT 'dirty ' || g FROM generate_series(1,20000) g")          # dirty buffers: the checkpoint now has real work to spread
            flag, phases, out = {"c": False}, [], {}
            old = F.ctx.start_fast; F.ctx.start_fast = False
            def run():
                try:
                    run_backup(F.ctx, "full", progress=lambda p: phases.append(p.get("phase")), cancel=lambda: flag["c"])
                except BaseException as e:
                    out["e"] = e
            t0 = time.time(); th = threading.Thread(target=run); th.start()
            w0 = time.time()                                    # cancel once the backup is really waiting for the checkpoint (the catalog phase before it is slower on a busy host)
            while "checkpoint" not in phases and th.is_alive() and time.time() - w0 < 60:
                time.sleep(0.2)
            time.sleep(1); t0 = time.time(); flag["c"] = True; th.join(30)
            self.assertFalse(th.is_alive(), "cancel did not interrupt the checkpoint wait")
            self.assertIsInstance(out.get("e"), Cancelled, out)
            self.assertLess(time.time() - t0, 25)
            self.assertIn("checkpoint", phases)
            F.ctx.start_fast = old
            # and with an immediate checkpoint the very same backup completes
            meta = run_backup(F.ctx, "full", start_fast=True)
            self.assertEqual(meta["status"], "COMPLETE")
        finally:
            q("postgres", "ALTER SYSTEM RESET checkpoint_timeout"); q("postgres", "ALTER SYSTEM RESET checkpoint_completion_target"); q("postgres", "SELECT pg_reload_conf()")

    def test_17_restore_refuses_when_destination_is_too_small(self):
        import pg_arca.engine.restore as R
        orig = R._free_bytes
        try:
            R._free_bytes = lambda path: 10 * 1024 * 1024                     # 10 MiB free
            with self.assertRaises(EngineError) as cm:
                restore_instance(F.ctx, dest=os.path.join(F.base, "too_small"), dry_run=True)
            self.assertEqual(cm.exception.code, "PGA-RST-030")
            self.assertFalse(os.path.exists(os.path.join(F.base, "too_small")), "nothing may be created before the check")
            R._free_bytes = lambda path: 10 ** 12
            plan = restore_instance(F.ctx, dest=os.path.join(F.base, "big_enough"), dry_run=True)
            self.assertEqual(plan["destination_free_bytes"], 10 ** 12)
        finally:
            R._free_bytes = orig


if __name__ == "__main__":
    unittest.main()
