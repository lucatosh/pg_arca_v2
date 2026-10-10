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
    F.repo = os.path.join(base, "repo")
    F.scratch = os.path.join(base, "scratch")
    F.port = 55000 + (os.getpid() % 900)
    F.seg = int(os.environ.get("PG_ARCA_TEST_WALSEG", "16")) * 1024 * 1024                      # non-default WAL segment size (initdb --wal-segsize): 1..1024 MB
    r = sh(os.path.join(BIN, "initdb"), "-D", F.src, "-U", "postgres", "--auth=trust", "-k", "--wal-segsize=%d" % (F.seg // 1048576),
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

    def test_06z_encryption_really_active(self):
        if not F.key:
            self.skipTest("run with PG_ARCA_TEST_ENCRYPT=1")
        import json
        self.assertEqual(json.load(open(os.path.join(F.repo, "repo.json")))["encryption"]["alg"], "aes-256-gcm")
        chunks = [os.path.join(dp, f) for dp, _, fs in os.walk(os.path.join(F.repo, "cas")) for f in fs if ".tmp." not in f]
        self.assertTrue(chunks)
        self.assertTrue(all(open(c, "rb").read(1) == b"E" for c in chunks[:200]))
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
            time.sleep(4); flag["c"] = True; th.join(30)
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
