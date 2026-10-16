"""The agent is killed (SIGKILL: power loss, OOM killer) in the middle of a backup, while chunks are being written. Afterwards:
  - the next backup runs (the stale lock does not block it; the interrupted set is marked FAILED, never used as a parent or for a restore)
  - chunks written around the crash are re-verified before being trusted for deduplication
  - a deep verify of the repository is clean, a restore gives exactly the data, retention removes the interrupted set

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_backup_crash_pg -v'
"""
import os
import signal
import subprocess
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_database
from pg_arca.engine.maintenance import expire, verify

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHILD = r'''
import os, sys
sys.path.insert(0, %(here)r)
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.pgsession import PgConn
from pg_arca.engine.backup import run_backup
ctx = Ctx(PgConn(host=%(sock)r, port=%(port)d, user="postgres", bindir=%(bin)r), %(src)r, %(repo)r, "main", %(wal)r, %(scratch)r, process_max=1, compression="zlib",
          level=9, start_fast=True, seg_size=%(seg)d, agent_path=%(walbin)r, key_file=%(key)r)
run_backup(ctx, %(type)r)
'''


def child(btype):
    code = CHILD % {"here": HERE, "sock": F.sock, "port": F.port, "bin": base.BIN, "src": F.src, "repo": F.repo, "wal": F.wal, "scratch": F.scratch, "seg": F.seg,
                    "walbin": F.ctx.agent_path, "key": F.key or None, "type": btype}
    return subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE crashdb")
    # enough distinct data that a level-9 single-process backup takes several seconds
    q("crashdb", "CREATE TABLE big AS SELECT g AS id, md5(g::text) || md5((g * 7)::text) || repeat(md5(random()::text), 4) AS v FROM generate_series(1, 600000) g")
    q("crashdb", "ALTER TABLE big ADD PRIMARY KEY (id)")


def tearDownModule():
    base.tearDownModule()


class Crash(unittest.TestCase):
    def test_killed_full_backup_then_everything_still_works(self):
        sets_dir = os.path.join(F.repo, "stanza", "main", "backup")
        p = child("full")
        # wait until the backup really writes chunks (the set directory exists and the CAS grows), then kill it hard
        t0 = time.time()
        cas = os.path.join(F.repo, "cas", "packs")
        while time.time() - t0 < 60:                                # the open packs grow while chunks are written
            n = sum(os.path.getsize(os.path.join(cas, f)) for f in os.listdir(cas)) if os.path.isdir(cas) else 0
            if n > 300 * 4096:
                break
            time.sleep(0.2)
        self.assertIsNone(p.poll(), "the backup finished before it could be interrupted: make the data bigger")
        os.killpg(p.pid, signal.SIGKILL)
        p.wait()
        killed = [d for d in os.listdir(sets_dir)] if os.path.isdir(sets_dir) else []
        self.assertTrue(killed, "an interrupted set is on disk")
        # the next backup: not blocked by the dead one's lock, never builds on it
        q("crashdb", "UPDATE big SET v = 'after crash' WHERE id <= 1000")
        m = run_backup(F.ctx, "incr")
        self.assertEqual(m["type"], "full", "no complete full existed: the incremental becomes a full, never a child of the interrupted set")
        statuses = {s["id"]: s.get("status") for s in F.ctx.repo.sets()}
        self.assertEqual(statuses[killed[0]], "FAILED", statuses)
        v = verify(F.ctx, deep=True)
        self.assertTrue(v["ok"], v["problems"])
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        restore_database(F.ctx, "crashdb", new_name="crashdb_back")
        self.assertEqual(q("crashdb_back", "SELECT count(*), count(*) FILTER (WHERE v = 'after crash'), md5(string_agg(v, '' ORDER BY id)) FROM big"),
                         q("crashdb", "SELECT count(*), count(*) FILTER (WHERE v = 'after crash'), md5(string_agg(v, '' ORDER BY id)) FROM big"))
        r = expire(F.ctx, retention_full=1)
        self.assertIn(killed[0], r["delete_sets"], "retention removes the interrupted set")
        self.assertTrue(verify(F.ctx, deep=True)["ok"])

    def test_y_died_while_waiting_for_wal(self):
        """The agent dies in the WAL phase (data and manifest durable, set PENDING_WAL). At the next run: if its WAL reached the archive meanwhile
        the set is COMPLETE (it used to be marked FAILED and deleted: a good backup thrown away); if its WAL is not there, FAILED as before."""
        good = run_backup(F.ctx, "full")
        self.assertEqual(good["status"], "COMPLETE")
        repo = F.ctx.repo
        m = repo.set_meta(good["id"]); m["status"] = "PENDING_WAL"; m.pop("completed", None); repo.write_meta(m)
        q("postgres", "SELECT pg_switch_wal()")
        nxt = run_backup(F.ctx, "incr")
        self.assertEqual(repo.set_meta(good["id"])["status"], "COMPLETE", "its WAL is in the archive: completed at the next run")
        self.assertIn("completed at the next run", repo.set_meta(good["id"]).get("note", ""))
        self.assertEqual(nxt["status"], "COMPLETE")
        # WAL never archived (stop point far beyond anything written): FAILED, never COMPLETE
        m = repo.set_meta(nxt["id"]); m["status"] = "PENDING_WAL"; m["stop_lsn"] = "FF/00000000"; repo.write_meta(m)
        run_backup(F.ctx, "incr")
        self.assertEqual(repo.set_meta(nxt["id"])["status"], "FAILED")

    def test_y2_late_wal_completes_an_unrecoverable_set(self):
        """A backup marked UNRECOVERABLE because its WAL did not arrive in time (archiver blocked: seen on the lab's geo pair, 7 sets in a row) is a
        good backup once that WAL reaches the archive: the next run (or retention) completes it instead of deleting it as junk. A set whose WAL
        never comes stays UNRECOVERABLE; an UNRECOVERABLE set for another reason is never touched."""
        from pg_arca.engine.maintenance import expire
        repo = F.ctx.repo
        a = run_backup(F.ctx, "incr")
        m = repo.set_meta(a["id"]); m["status"] = "UNRECOVERABLE"; m["wal_timeout"] = True; m["reason"] = "WAL segment(s) not archived within 120s: x"; m.pop("completed", None); repo.write_meta(m)
        # a divergent copy of one of its segments in the quarantine: the archive's copy may be another server's -> NOT completed automatically
        from pg_arca.engine.backup import _wal_needed
        need = _wal_needed(int(m["timeline"]), m["start_lsn"], m["stop_lsn"], int(m.get("wal_segment_size") or F.ctx.seg_size), False)
        qf = os.path.join(F.ctx.wal.wal_dir, "conflicts", need[0] + ".abcdefabcdef")
        with open(qf, "wb") as fh:
            fh.write(b"other server")
        run_backup(F.ctx, "incr")
        self.assertEqual(repo.set_meta(a["id"])["status"], "UNRECOVERABLE", "a quarantined copy of its WAL: a person decides")
        self.assertIn("quarantine", repo.set_meta(a["id"]).get("late_wal_doubt", ""))
        os.unlink(qf)
        b = run_backup(F.ctx, "incr")
        self.assertEqual(repo.set_meta(a["id"])["status"], "COMPLETE", "its WAL is in the archive now")
        self.assertIn("reached the archive late", repo.set_meta(a["id"]).get("note", ""))
        self.assertNotIn("reason", repo.set_meta(a["id"]))
        m = repo.set_meta(b["id"]); m["status"] = "UNRECOVERABLE"; m["wal_timeout"] = True; m["stop_lsn"] = "FF/00000000"; repo.write_meta(m)
        run_backup(F.ctx, "incr")
        self.assertEqual(repo.set_meta(b["id"])["status"], "UNRECOVERABLE", "WAL never archived: stays unrecoverable")
        m = repo.set_meta(b["id"]); m.pop("wal_timeout"); m["stop_lsn"] = a["stop_lsn"]; repo.write_meta(m)
        expire(F.ctx, dry_run=True)
        self.assertEqual(repo.set_meta(b["id"])["status"], "UNRECOVERABLE", "another reason: never completed")

    def test_z_killed_incremental_does_not_break_the_chain(self):
        q("crashdb", "UPDATE big SET v = md5(v) WHERE id % 3 = 0")
        p = child("incr")
        time.sleep(1.5)
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGKILL)
        p.wait()
        q("crashdb", "UPDATE big SET v = 'last' WHERE id = 1")
        m = run_backup(F.ctx, "incr")
        self.assertEqual(m["status"], "COMPLETE")
        parent = F.ctx.repo.set_meta(m["parent"]) if m.get("parent") else None
        self.assertTrue(parent is None or parent.get("status") == "COMPLETE", "the parent of the new incremental is a complete set")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(2)
        restore_database(F.ctx, "crashdb", new_name="crashdb_back2")
        self.assertEqual(q("crashdb_back2", "SELECT v FROM big WHERE id = 1")[0][0], "last")
        self.assertEqual(q("crashdb_back2", "SELECT md5(string_agg(v, '' ORDER BY id)) FROM big"), q("crashdb", "SELECT md5(string_agg(v, '' ORDER BY id)) FROM big"))


if __name__ == "__main__":
    unittest.main()
