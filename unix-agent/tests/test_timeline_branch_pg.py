"""The production database is rewound: a PITR copy taken to an instant in the PAST becomes the new production (same archive, archiving kept on),
while the WAL of the abandoned future (timeline 1 after the branch point) stays in the archive. This is what a DBA does after a logical disaster
when the business accepts losing what came after it. Afterwards every restore must pick the right history:
  - "latest" follows the new timeline: A, B, then D (never C, the abandoned future)
  - an instant between the branch and D on the new timeline: A, B
  - the same instant on the OLD timeline (timeline=1, from the old backup): A, B, C
  - backups of the new production are timeline 2 and build on what exists; retention and a deep verify keep both histories restorable as long as needed
  - the WAL archive does not report a false gap where the timelines fork

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_timeline_branch_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.maintenance import expire, verify
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance

X = T.Fx()


def setUpModule():
    T.setUpModule()


def tearDownModule():
    if getattr(X, "new", None):
        T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", X.new, "-m", "immediate", "stop")
    T.tearDownModule()


def now_utc():
    return q("postgres", "SELECT to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]


def wait_archived():
    last = q("postgres", "SELECT pg_walfile_name(pg_switch_wal() - 1)")[0][0]
    for _ in range(90):
        got = q("postgres", "SELECT COALESCE(last_archived_wal, '') FROM pg_stat_archiver")[0][0] or ""
        if got[8:] >= last[8:] and got[:8] >= last[:8]:
            return last
        time.sleep(1)
    raise AssertionError("segment %s never archived" % last)


def rows_after_restore(ctx, **kw):
    """Restore into a fresh directory, start it on another port (no archiving), and count the tags."""
    dest = os.path.join(F.base, "check_%d" % int(time.time() * 1000))
    restore_instance(ctx, dest=dest, action="promote", **kw)
    port2 = F.port + 5
    with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
        f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\narchive_mode=off\narchive_command=''\n" % (port2, F.sock))
    r = T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-l", dest + ".log", "-w", "-t", "120", "start")
    assert r.returncode == 0, r.stderr + open(dest + ".log").read()[-2500:]
    try:
        s = PgSession(PgConn(host=F.sock, port=port2, user="postgres", bindir=T.BIN, dbname="tl"))
        try:
            for _ in range(60):
                if s.scalar("SELECT pg_is_in_recovery()") == "f":
                    break
                time.sleep(1)
            return {r[0]: int(r[1]) for r in s.query("SELECT tag, count(*) FROM notes GROUP BY 1")}
        finally:
            s.close()
    finally:
        T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")
        T.sh("rm", "-rf", dest)


class TimelineBranch(unittest.TestCase):
    def test_01_production_is_rewound_to_an_instant_in_the_past(self):
        q("postgres", "CREATE DATABASE tl")
        q("tl", "CREATE TABLE notes (id serial PRIMARY KEY, tag text); INSERT INTO notes (tag) SELECT 'A' FROM generate_series(1, 100)")
        X.full1 = run_backup(F.ctx, "full")
        q("tl", "INSERT INTO notes (tag) SELECT 'B' FROM generate_series(1, 50)")
        time.sleep(1.2); X.t_branch = now_utc(); time.sleep(1.2)
        q("tl", "INSERT INTO notes (tag) SELECT 'C' FROM generate_series(1, 25)")          # the future that will be abandoned
        time.sleep(1.2); X.t_after_c = now_utc(); time.sleep(1.2)
        wait_archived()
        X.incr_c = run_backup(F.ctx, "incr")                                             # taken on the future that will be abandoned: past the fork
        self.assertEqual(X.incr_c["timeline"], 1)
        wait_archived()
        # the rewound copy becomes production: same port and socket, archiving to the same archive (keep_archiving)
        X.new = os.path.join(F.base, "rewound")
        restore_instance(F.ctx, dest=X.new, target_time=X.t_branch, action="promote", keep_archiving=True)
        T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", F.src, "-m", "fast", "stop")
        r = T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", X.new, "-l", X.new + ".log", "-w", "-t", "180", "start")
        self.assertEqual(r.returncode, 0, r.stderr + open(X.new + ".log").read()[-2500:])
        for _ in range(60):
            if q("postgres", "SELECT pg_is_in_recovery()")[0][0] == "f":
                break
            time.sleep(1)
        self.assertEqual(q("tl", "SELECT string_agg(tag || count, ',' ORDER BY tag) FROM (SELECT tag, count(*) FROM notes GROUP BY 1) x")[0][0], "A100,B50")
        self.assertEqual(q("postgres", "SELECT timeline_id FROM pg_control_checkpoint()")[0][0], "2")
        time.sleep(1.2); X.t_before_d = now_utc(); time.sleep(1.2)
        q("tl", "INSERT INTO notes (tag) SELECT 'D' FROM generate_series(1, 10)")
        wait_archived()
        X.ctx2 = Ctx(F.conn, X.new, F.repo, "main", F.wal, F.scratch, process_max=4, compression="zlib", level=3, start_fast=True, seg_size=F.seg,
                     agent_path=F.ctx.agent_path, key_file=F.key or None)
        self.assertTrue(F.ctx.wal.has_segment("00000002.history"), "the new timeline's history file is archived")

    def test_02_backup_of_the_new_production_is_timeline_2(self):
        m = run_backup(X.ctx2, "incr")
        self.assertEqual(m["status"], "COMPLETE")
        self.assertEqual(m["timeline"], 2)
        X.b2 = m

    def test_03_latest_follows_the_new_history(self):
        self.assertEqual(rows_after_restore(X.ctx2), {"A": 100, "B": 50, "D": 10})

    def test_04_an_instant_after_the_branch_on_the_new_timeline(self):
        self.assertEqual(rows_after_restore(X.ctx2, target_time=X.t_after_c), {"A": 100, "B": 50})

    def test_04b_an_incremental_past_the_fork_is_not_used(self):
        """Independent review (16/10): the newest backup before the target is the incremental taken on timeline 1 AFTER the branch point; its
        files hold the abandoned future (C). Recovering along timeline 2 from it gave a diverged cluster that PostgreSQL believed consistent.
        The chain now stops before it and the WAL does the rest."""
        self.assertEqual(rows_after_restore(X.ctx2, target_time=X.t_before_d), {"A": 100, "B": 50})

    def test_05_the_same_instant_on_the_abandoned_timeline(self):
        self.assertEqual(rows_after_restore(X.ctx2, set_spec=X.full1["id"], target_time=X.t_after_c, timeline="1"), {"A": 100, "B": 50, "C": 25})

    def test_06_the_archive_has_no_false_gap_at_the_fork(self):
        v = F.ctx.wal._compute_continuity()
        self.assertEqual(v.get("gap_count"), 0, {k: v.get(k) for k in v if k != "segments"})

    def test_07_retention_and_verify_keep_what_is_needed(self):
        q("tl", "INSERT INTO notes (tag) SELECT 'E' FROM generate_series(1, 5)")
        full2 = run_backup(X.ctx2, "full")
        self.assertEqual(full2["timeline"], 2)
        r = expire(X.ctx2, retention_full=1)
        self.assertIn(X.full1["id"], r["delete_sets"], "the old timeline's full goes once a newer full exists")
        self.assertTrue(verify(X.ctx2, deep=True)["ok"])
        q("tl", "INSERT INTO notes (tag) SELECT 'F' FROM generate_series(1, 3)")
        time.sleep(1.2); t_f = now_utc(); time.sleep(1.2)
        q("tl", "INSERT INTO notes (tag) SELECT 'G' FROM generate_series(1, 2)")
        wait_archived()
        self.assertEqual(rows_after_restore(X.ctx2), {"A": 100, "B": 50, "D": 10, "E": 5, "F": 3, "G": 2})
        self.assertEqual(rows_after_restore(X.ctx2, target_time=t_f), {"A": 100, "B": 50, "D": 10, "E": 5, "F": 3}, "PITR inside the kept window, on timeline 2")

if __name__ == "__main__":
    unittest.main()
