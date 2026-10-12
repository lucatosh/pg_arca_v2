"""Restores under real faults: what breaks must break CLEANLY (nothing half-done, a message that says what and where, the live database untouched).
  - the table to replace is locked by a long transaction of the application
  - an archived WAL segment is corrupt (bit rot) / a segment is missing in the middle of the archive
  - the application keeps writing during the restore

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_restore_faults_pg -v'
"""
import glob
import os
import subprocess
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import BIN, F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_database, restore_object
from pg_arca.engine.util import EngineError

DB = "faults"
S = {}


def now_utc():
    return q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, "CREATE TABLE acc (id int PRIMARY KEY, bal numeric); INSERT INTO acc SELECT g, 100 FROM generate_series(1, 1000) g")
    q(DB, "CREATE TABLE log (id bigserial PRIMARY KEY, at timestamptz DEFAULT now(), what text)")
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["t_ok"] = now_utc()
    time.sleep(1.2)
    q(DB, "UPDATE acc SET bal = 0")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    base.tearDownModule()


def psql_bg(sql, db=DB):
    """A client session that stays open (the application holding a lock)."""
    p = subprocess.Popen([os.path.join(BIN, "psql"), "-h", F.sock, "-p", str(F.port), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    p.stdin.write(sql + "\n")
    p.stdin.flush()
    return p


class Faults(unittest.TestCase):
    def test_01_replace_blocked_by_a_lock_rolls_back_cleanly(self):
        restore_object(F.ctx, DB, objects=["%s.public.acc" % DB], target_time=S["t_ok"], stage_db="pgarca_stage_lock")
        holder = psql_bg("BEGIN; LOCK TABLE acc IN ACCESS SHARE MODE; SELECT pg_sleep(60);")
        time.sleep(1)
        try:
            t0 = time.time()
            with self.assertRaises(EngineError) as cm:
                promote_object(F.ctx, "pgarca_stage_lock", DB, mode="replace", drop_stage=False)
            took = time.time() - t0
            self.assertLess(took, 60, "the lock timeout ends the wait, not the other transaction")
            self.assertIn("rolled back", cm.exception.message)
        finally:
            holder.kill()
            q("postgres", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(60)%' AND pid <> pg_backend_pid()")
            time.sleep(0.5)
        # nothing half-done: the live table is the same, no temporary or old copies left, the quarantine is still there to retry
        self.assertEqual(q(DB, "SELECT sum(bal) FROM acc")[0][0], "0")
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_class WHERE relname ~ '^acc_(pitr|old)_'")[0][0], "0", q(DB, "SELECT relname FROM pg_class WHERE relname ~ '^acc_'"))
        self.assertEqual(q("postgres", "SELECT count(*) FROM pg_database WHERE datname = 'pgarca_stage_lock'")[0][0], "1")
        promote_object(F.ctx, "pgarca_stage_lock", DB, mode="replace", drop_stage=True)          # retry once the lock is gone
        self.assertEqual(q(DB, "SELECT sum(bal)::int FROM acc")[0][0], "100000")

    def test_02_application_writing_during_the_promotion(self):
        # rows inserted while the recovered table is being loaded under a temporary name land in the live table, which becomes the kept _old_ copy
        restore_object(F.ctx, DB, objects=["%s.public.log" % DB], target_time=S["t_ok"], stage_db="pgarca_stage_w")
        stop = threading.Event()
        errs = []

        def writer():
            while not stop.is_set():
                try:
                    q(DB, "INSERT INTO log(what) VALUES ('app')")
                except EngineError as e:
                    errs.append(e.message)
                time.sleep(0.02)
        th = threading.Thread(target=writer)
        th.start()
        try:
            r = promote_object(F.ctx, "pgarca_stage_w", DB, mode="replace", drop_stage=True)
        finally:
            stop.set()
            th.join()
        ok = r["old_kept_as"] if isinstance(r["old_kept_as"], str) else r["old_kept_as"][0]
        old = ok.split(".", 1)[1]
        self.assertGreater(int(q(DB, "SELECT count(*) FROM %s" % old)[0][0]), 0, "the application's rows are in the kept copy, not lost")
        q(DB, "INSERT INTO log(what) VALUES ('after')")                      # the recovered table works, its sequence did not go backwards
        self.assertFalse([e for e in errs if "does not exist" not in e and "relation" not in e], errs[:3])

    def _segments(self):
        return sorted(p for p in glob.glob(os.path.join(F.wal, "0000000*")) if not p.endswith(".meta") and ".history" not in p and ".backup" not in p)

    def test_03_corrupt_wal_segment_stops_the_recovery_with_its_name(self):
        q(DB, "INSERT INTO log(what) SELECT 'x' || g FROM generate_series(1, 5000) g")
        t_after = now_utc()
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)
        full = F.ctx.repo.complete_sets()[0]
        from pg_arca.engine.util import lsn_to_int, wal_segno, wal_name
        first = wal_name(full["timeline"], wal_segno(lsn_to_int(full["start_lsn"]), F.seg) + 1, F.seg)       # a segment the replay must read
        victim = [p for p in self._segments() if os.path.basename(p).startswith(first)][0]
        data = bytearray(open(victim, "rb").read())
        keep = bytes(data)
        data[len(data) // 2] ^= 0xFF
        open(victim, "wb").write(bytes(data))
        try:
            with self.assertRaises(EngineError) as cm:
                restore_database(F.ctx, DB, target_time=t_after, new_name="faults_corrupt")
            msg = cm.exception.message + " " + (getattr(cm.exception, "hint", "") or "")
            self.assertTrue(first in msg or "checksum" in msg.lower() or "corrupt" in msg.lower() or "PGA-WAL-05" in msg, msg[:800])
            self.assertEqual(q("postgres", "SELECT count(*) FROM pg_database WHERE datname = 'faults_corrupt'")[0][0], "0", "nothing half-restored")
        finally:
            open(victim, "wb").write(keep)

    def test_04_missing_segment_is_refused_before_the_recovery(self):
        # segment A: a commit, the point t_mid, another commit (so the replay can stop inside A); then B (removed: the hole) and C after it
        sw = lambda: (q("postgres", "SELECT pg_switch_wal()"), time.sleep(2.5))
        q(DB, "INSERT INTO log(what) VALUES ('a1')")
        time.sleep(1.1)
        t_mid = now_utc()
        time.sleep(1.1)
        q(DB, "INSERT INTO log(what) VALUES ('a2')")
        seg_b = q("postgres", "SELECT pg_walfile_name(pg_current_wal_lsn())")[0][0]
        sw()
        q(DB, "INSERT INTO log(what) VALUES ('b')")
        name = q("postgres", "SELECT pg_walfile_name(pg_current_wal_lsn())")[0][0]
        sw()
        q(DB, "INSERT INTO log(what) VALUES ('c')")
        time.sleep(1.1)
        t_after = now_utc()
        sw()
        sw()
        self.assertNotEqual(seg_b, name)
        victims = [p for p in glob.glob(os.path.join(F.wal, name + "*"))]
        self.assertTrue(victims)
        hidden = os.path.join(F.base, "hidden")
        os.makedirs(hidden, exist_ok=True)
        for v in victims:
            os.rename(v, os.path.join(hidden, os.path.basename(v)))
        try:
            for dry in (True, False):                                             # refused by the plan, before any recovery
                with self.assertRaises(EngineError) as cm:
                    restore_database(F.ctx, DB, target_time=t_after, new_name="faults_gap", dry_run=dry)
                self.assertEqual(cm.exception.code, "PGA-WAL-022"); self.assertIn(name, cm.exception.message)
            with self.assertRaises(EngineError) as cm:
                restore_database(F.ctx, DB, new_name="faults_gap")                # 'latest' too: it would silently end at the hole
            self.assertIn(name, cm.exception.message)
            restore_database(F.ctx, DB, target_time=t_mid, new_name="faults_before_gap")      # a point BEFORE the hole still works
            self.assertEqual(q("faults_before_gap", "SELECT count(*) FROM log WHERE what IN ('a1', 'a2')")[0][0], "1")
            from pg_arca.engine.restore import restore_instance
            p = restore_instance(F.ctx, dest=os.path.join(F.base, "inst_gap"), dry_run=True)        # disaster recovery to the end: said, not refused
            self.assertEqual(p.get("wal_hole"), name)
            self.assertIn("wal_hole", [c["id"] for c in p["preflight"]["checks"] if c["level"] == "warn"])
        finally:
            for v in victims:
                os.rename(os.path.join(hidden, os.path.basename(v)), v)

    def test_05_agent_killed_in_the_middle_of_a_promotion(self):
        # the agent process dies (restart, OOM, reboot) after loading the recovered table under its temporary name and before the swap
        restore_object(F.ctx, DB, objects=["%s.public.acc" % DB], target_time=S["t_ok"], stage_db="pgarca_stage_kill")
        jdir = os.path.join(F.base, "journal")
        script = os.path.join(F.base, "killme.py")
        open(script, "w").write("""
import os, sys
sys.path.insert(0, %r)
from tests import test_engine_pg as base
from tests.test_engine_pg import F
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.pgsession import PgConn
from pg_arca.engine.granular import promote_object
ctx = Ctx(PgConn(host=%r, port=%d, user="postgres", bindir=%r), %r, %r, "main", %r, %r, key_file=%r)
ctx.promote_journal_dir = %r
def die(p):
    if p.get("phase") == "swap":
        os._exit(9)
promote_object(ctx, "pgarca_stage_kill", "", mode="replace", drop_stage=False, progress=die)
""" % (os.path.dirname(os.path.dirname(os.path.abspath(__file__))), F.sock, F.port, BIN, F.src, F.repo, F.wal, F.scratch, F.key or None, jdir))
        r = subprocess.run([sys.executable, script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(r.returncode, 9, r.stderr[-800:])
        left = q(DB, "SELECT relname FROM pg_class WHERE relname ~ '^acc_pitr_' AND relkind = 'r'")
        self.assertTrue(left, "the temporary table is left behind by the dead agent")
        self.assertEqual(len(os.listdir(jdir)), 1, "and the journal says so")
        F.ctx.promote_journal_dir = jdir
        try:
            from pg_arca.engine.granular import cleanup_interrupted_promotions
            gone = cleanup_interrupted_promotions(F.ctx)
        finally:
            F.ctx.promote_journal_dir = None
        self.assertEqual(gone, ["public.%s" % left[0][0]])
        self.assertEqual(q(DB, "SELECT count(*) FROM pg_class WHERE relname ~ '^acc_pitr_'")[0][0], "0")
        self.assertEqual(os.listdir(jdir), [])
        self.assertEqual(q(DB, "SELECT count(*) FROM acc")[0][0], "1000", "the live table was never touched")
        q("postgres", "DROP DATABASE pgarca_stage_kill")

    def test_06_agent_killed_during_a_recovery_leaves_no_instance_running(self):
        script = os.path.join(F.base, "killrec.py")
        open(script, "w").write("""
import os, sys
sys.path.insert(0, %r)
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.pgsession import PgConn
from pg_arca.engine.granular import restore_database
ctx = Ctx(PgConn(host=%r, port=%d, user="postgres", bindir=%r), %r, %r, "main", %r, %r, key_file=%r, agent_path=%r, seg_size=%d, compression="zlib")
def die(p):
    if p.get("phase") == "transfer":
        os._exit(9)
restore_database(ctx, %r, new_name="faults_killed", progress=die)
""" % (os.path.dirname(os.path.dirname(os.path.abspath(__file__))), F.sock, F.port, BIN, F.src, F.repo, F.wal, F.scratch, F.key or None, F.ctx.agent_path, F.seg, DB))
        r = subprocess.run([sys.executable, script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(r.returncode, 9, r.stderr[-800:])
        left = [d for d in os.listdir(F.scratch) if d.startswith("eph-")]
        self.assertTrue(left, "the dead agent left its recovery instance behind")
        pid = int(open(os.path.join(F.scratch, left[0], "postmaster.pid")).readline())
        os.kill(pid, 0)                                                        # and it is still running
        from pg_arca.engine import ephemeral
        os.utime(os.path.join(F.scratch, left[0], ".pgarca-scratch"), (time.time() - 120, time.time() - 120))
        gone = ephemeral.reap_stale(F.ctx)
        self.assertEqual(gone, left)
        time.sleep(1)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertFalse(os.path.exists(os.path.join(F.scratch, left[0])))
        self.assertEqual(q("postgres", "SELECT 1")[0][0], "1", "the live server was not touched")


if __name__ == "__main__":
    unittest.main()
