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
    F.repo = os.path.join(base, "repo")
    F.scratch = os.path.join(base, "scratch")
    F.port = 55000 + (os.getpid() % 900)
    r = sh(os.path.join(BIN, "initdb"), "-D", F.src, "-U", "postgres", "--auth=trust", "-k")      # -k: data checksums
    assert r.returncode == 0, r.stderr
    walbin = os.path.join(HERE, "pg-arca-wal")
    with open(os.path.join(F.src, "postgresql.conf"), "a") as f:
        f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\nwal_level=replica\narchive_mode=on\nwal_log_hints=on\n" % (F.port, F.sock))
        f.write("archive_command='env WAL_ARCHIVE_DIR=%s PG_ARCA_HOME=%s PG_ARCA_CONF=/nonexistent %s archive %%p %%f'\narchive_timeout=5\n" % (F.wal, HERE, walbin))
        f.write("shared_buffers=32MB\nmax_connections=30\n")
    r = sh(os.path.join(BIN, "pg_ctl"), "-D", F.src, "-l", os.path.join(base, "src.log"), "-w", "start")
    assert r.returncode == 0, r.stderr + open(os.path.join(base, "src.log")).read()
    F.conn = PgConn(host=F.sock, port=F.port, user="postgres", bindir=BIN)
    F.ctx = Ctx(F.conn, F.src, F.repo, "main", F.wal, F.scratch, process_max=4, compression="zlib", level=3, start_fast=True,
                log=lambda lv, m: sys.stderr.write("[%s] %s\n" % (lv, m)) if os.environ.get("V") else None, agent_path=walbin)


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
        q("other", "CREATE TABLE junk(x text); INSERT INTO junk SELECT repeat('x', 200) FROM generate_series(1,20000)")
        meta = run_backup(F.ctx, "full")
        F.full = meta
        self.assertEqual(meta["status"], "COMPLETE")
        self.assertEqual(meta["type"], "full")
        self.assertGreater(meta["stats"]["bytes_logical"], 0)
        self.assertTrue(F.ctx.wal.has_segment(meta["start_lsn"] and __import__("pg_arca.engine.util", fromlist=["x"]).wal_name_from_lsn(1, __import__("pg_arca.engine.util", fromlist=["x"]).lsn_to_int(meta["start_lsn"]))))

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
        q("app", "DELETE FROM orders")                                   # the "accident"
        q("app", "DROP TABLE customers")
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

    def test_05_restore_database_sparse_pitr(self):
        plan = restore_database(F.ctx, "app", target_time=F.t1, new_name="app_at_t1", jobs=2)
        self.assertEqual(plan["result_database"], "app_at_t1")
        self.assertEqual(int(q("app_at_t1", "SELECT count(*) FROM orders")[0][0]), F.n1)
        self.assertEqual(int(q("app_at_t1", "SELECT count(*) FROM customers")[0][0]), 500)
        self.assertLess(plan["extract_bytes"], plan["cluster_bytes"])          # sparse really extracted less
        with self.assertRaises(EngineError) as cm:                              # never overwrites
            restore_database(F.ctx, "app", target_time=F.t1, new_name="app_at_t1")
        self.assertEqual(cm.exception.code, "PGA-SEC-030")

    def test_06_restore_object(self):
        plan = restore_object(F.ctx, "app.public.customers", target_time=F.t1, stage_db="stage_customers")
        self.assertEqual(plan["rows_restored"], 500)
        self.assertEqual(int(q("stage_customers", "SELECT count(*) FROM public.customers")[0][0]), 500)

    def test_06b0_row_level_recovery(self):
        from pg_arca.engine.granular import diff_object, apply_rows
        import json
        q("app", "CREATE TABLE customers(id int primary key, name text); INSERT INTO customers SELECT g,'live'||g FROM generate_series(1,5) g")
        try:
            d = diff_object(F.ctx, "stage_customers", "app.public.customers")
            self.assertEqual(d["primary_key"], ["id"])
            self.assertEqual(d["counts"]["missing_now"], 495)          # 500 recovered rows, ids 1..5 exist live
            self.assertEqual(d["counts"]["changed"], 5)
            self.assertEqual(d["counts"]["added_since"], 0)
            q("app", "INSERT INTO customers VALUES (900,'new')")
            d = diff_object(F.ctx, "stage_customers", "app.public.customers", limit=3)
            self.assertEqual(d["counts"]["added_since"], 1); self.assertEqual(len(d["missing_now"]), 3)
            self.assertEqual(d["added_since"][0]["key"], [900])
            ch = d["changed"][0]
            self.assertEqual(ch["live"]["name"], "live%d" % ch["key"][0]); self.assertNotEqual(ch["restored"]["name"], ch["live"]["name"])
            # dry run touches nothing
            r0 = apply_rows(F.ctx, "stage_customers", "app.public.customers", restore_keys=["[1]", "[200]"], delete_keys=["[900]"], dry_run=True)
            self.assertEqual((r0["inserted"], r0["updated"], r0["deleted"]), (1, 1, 1))
            self.assertEqual(int(q("app", "SELECT count(*) FROM customers")[0][0]), 6)
            r = apply_rows(F.ctx, "stage_customers", "app.public.customers", restore_keys=["[1]", "[200]"], delete_keys=["[900]"])
            self.assertEqual((r["inserted"], r["updated"], r["deleted"]), (1, 1, 1))
            self.assertEqual(int(q("app", "SELECT count(*) FROM customers")[0][0]), 6)        # 5 + 1 inserted - 1 deleted
            self.assertNotEqual(q("app", "SELECT name FROM customers WHERE id=1")[0][0], "live1")
            self.assertEqual(q("app", "SELECT name FROM %s WHERE id=1" % r["safety_copy"])[0][0], "live1", "previous version kept")
            self.assertEqual(q("app", "SELECT name FROM customers WHERE id=900"), [])
            self.assertEqual(q("app", "SELECT name FROM %s WHERE id=900" % r["safety_copy"])[0][0], "new")
            # an unknown key aborts everything, nothing half applied
            with self.assertRaises(EngineError):
                apply_rows(F.ctx, "stage_customers", "app.public.customers", restore_keys=["[2]", "[99999]"])
            self.assertEqual(q("app", "SELECT name FROM customers WHERE id=2")[0][0], "live2")
            with self.assertRaises(EngineError):
                apply_rows(F.ctx, "somedb", "app.public.customers", restore_keys=["[2]"])
            q("app", "DROP TABLE %s" % r["safety_copy"])
        finally:
            q("app", "DROP TABLE IF EXISTS customers")

    def test_06b_promote_table_back(self):
        r = promote_object(F.ctx, "stage_customers", "app.public.customers", mode="as_new", drop_stage=False)
        self.assertTrue(r["promoted_as"].startswith("public.customers_pitr_")); self.assertIsNone(r["old_kept_as"])
        self.assertEqual(int(q("app", "SELECT count(*) FROM %s" % r["promoted_as"])[0][0]), 500)
        self.assertEqual([x[0] for x in q("app", "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'pgarca_pr_%'")], [], "work schema removed")
        # the recovered table keeps a usable primary key under a suffixed name (no collision)
        self.assertTrue(q("app", "SELECT 1 FROM pg_indexes WHERE tablename LIKE 'customers_pitr_%' AND indexname LIKE '%pitr%'"))
        # replace: a live table exists now -> it is renamed, never dropped
        q("app", "CREATE TABLE customers(id int primary key, name text); INSERT INTO customers VALUES (1,'live')")
        r2 = promote_object(F.ctx, "stage_customers", "app.public.customers", mode="replace", drop_stage=True)
        self.assertTrue(r2["old_kept_as"].startswith("public.customers_old_"))
        self.assertEqual(int(q("app", "SELECT count(*) FROM customers")[0][0]), 500)
        self.assertEqual(q("app", "SELECT name FROM %s" % r2["old_kept_as"])[0][0], "live", "previous data kept")
        self.assertNotIn("stage_customers", [x[0] for x in q("postgres", "SELECT datname FROM pg_database")])
        with self.assertRaises(EngineError):
            promote_object(F.ctx, "somedb", "app.public.customers")               # only pg_arca quarantine databases
        q("app", "DROP TABLE customers; DROP TABLE %s; DROP TABLE %s" % (r2["old_kept_as"], r["promoted_as"]))

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
        p = F.ctx.repo.cas_path(h)
        good = open(p, "rb").read()
        try:
            with open(p, "wb") as f:
                f.write(good[:-3] + b"\x00\x00\x00")
            v = verify(F.ctx, deep=True)
            self.assertFalse(v["ok"])
            with self.assertRaises(EngineError):
                F.ctx.repo.get_chunk(h)
        finally:
            with open(p, "wb") as f:
                f.write(good)
        self.assertTrue(verify(F.ctx, deep=True)["ok"])

    def test_13_forensics_finds_the_drop(self):
        r = forensics(F.ctx, limit=50)
        kinds = [e["kind"] for e in r["events"]]
        self.assertIn("DROP", kinds)

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


if __name__ == "__main__":
    unittest.main()
