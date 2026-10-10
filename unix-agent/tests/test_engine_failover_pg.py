"""PITR ACROSS A FAILOVER: base backup on the old primary (timeline 1), the standby is promoted (timeline 2), new data and a new backup on the new primary.
Recovery to a point BEFORE the failover and to a point AFTER it must both work and give the right rows (real PostgreSQL primary + streaming standby).
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_engine_failover_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from tests import test_engine_standby_pg as SB
from pg_arca.engine.backup import run_backup
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance

SKIP = T.SKIP
S = SB.S
X = T.Fx()
setUpModule = SB.setUpModule
tearDownModule = SB.tearDownModule


def utc_now(ctx_conn):
    s = PgSession(ctx_conn.with_db("postgres"))
    try:
        return s.scalar("SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")
    finally:
        s.close()


def count_after_restore(set_spec, **kw):
    dest = os.path.join(T.F.base, "restored_%d" % int(time.time() * 1000))
    restore_instance(S.ctx, set_spec=set_spec, dest=dest, action="promote", **kw)
    port2 = T.F.port + 5
    with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
        f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\narchive_mode=off\narchive_command=''\n" % (port2, T.F.sock))
    r = T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-l", dest + ".log", "-w", "-t", "120", "start")
    assert r.returncode == 0, r.stderr + open(dest + ".log").read()[-2500:]
    try:
        s = PgSession(PgConn(host=T.F.sock, port=port2, user="postgres", bindir=T.BIN, dbname="app"))
        try:
            for _ in range(60):
                if s.scalar("SELECT pg_is_in_recovery()") == "f":
                    break
                time.sleep(1)
            return {r[0]: int(r[1]) for r in s.query("SELECT split_part(note,' ',1), count(*) FROM orders GROUP BY 1")}, int(s.scalar("SELECT timeline_id FROM pg_control_checkpoint()"))
        finally:
            s.close()
    finally:
        T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")


class FailoverTests(unittest.TestCase):
    def test_01_full_on_old_primary_then_failover(self):
        T.q("app", "DELETE FROM orders")
        SB.churn(1)
        X.full = run_backup(T.F.ctx, "full")                       # timeline 1, on the primary
        self.assertEqual(X.full["timeline"], 1)
        T.q("app", "INSERT INTO orders(note) SELECT 'A ' || g FROM generate_series(1,100) g")
        time.sleep(1.2); X.tA = utc_now(T.F.ctx.conn); time.sleep(1.2)
        T.q("app", "INSERT INTO orders(note) SELECT 'B ' || g FROM generate_series(1,50) g")
        T.q("postgres", "SELECT pg_switch_wal()")
        for _ in range(30):                                        # standby caught up
            s = PgSession(S.conn.with_db("app"))
            try:
                if s.scalar("SELECT count(*) FROM orders WHERE note LIKE 'B %'") == "50":
                    break
            finally:
                s.close()
            time.sleep(1)
        last = T.q("postgres", "SELECT pg_walfile_name(pg_switch_wal() - 1)")[0][0]
        for _ in range(60):                                        # a HEALTHY primary has archived everything before it dies (the unarchived case is tested separately)
            if (T.q("postgres", "SELECT COALESCE(last_archived_wal, '') FROM pg_stat_archiver")[0][0] or "") >= last:
                break
            time.sleep(1)
        T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", T.F.src, "-m", "immediate", "stop")          # the primary dies
        r = T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", S.sdir, "-w", "promote")
        self.assertEqual(r.returncode, 0, r.stderr)
        for _ in range(30):
            s = PgSession(S.conn.with_db("app"))
            try:
                if s.scalar("SELECT pg_is_in_recovery()") == "f":
                    break
            finally:
                s.close()
            time.sleep(1)
        # the promoted node archives: its archive_command comes from the primary's configuration
        time.sleep(1.2); X.tB = utc_now(S.conn); time.sleep(1.2)
        s = PgSession(S.conn.with_db("app"))
        try:
            s.query("INSERT INTO orders(note) SELECT 'C ' || g FROM generate_series(1,25) g")
            s.query("SELECT pg_switch_wal()")
        finally:
            s.close()
        time.sleep(3)

    def test_02_new_backup_on_new_primary_is_timeline_2(self):
        meta = run_backup(S.ctx, "full")
        self.assertEqual(meta["status"], "COMPLETE")
        self.assertEqual(meta["timeline"], 2)
        X.full2 = meta

    def test_03_pitr_before_failover_uses_the_old_timeline_base(self):
        s = PgSession(S.conn.with_db("postgres"))
        try:
            s.query("SELECT pg_switch_wal()")
        finally:
            s.close()
        time.sleep(2)
        rows, tli = count_after_restore(X.full["id"], target_time=X.tA)
        self.assertEqual(rows, {"A": 100, "churn": 2000}, rows)

    def test_04_pitr_to_the_failover_point_gives_a_and_b(self):
        rows, tli = count_after_restore(None, target_time=X.tB)
        self.assertEqual(rows, {"A": 100, "B": 50, "churn": 2000}, rows)

    def test_05_restore_to_latest_follows_the_new_timeline(self):
        rows, tli = count_after_restore(None)
        self.assertEqual(rows, {"A": 100, "B": 50, "C": 25, "churn": 2000}, rows)
        self.assertGreaterEqual(tli, 2)


    def test_06_wal_archive_has_no_false_gap_after_failover(self):
        v = T.F.ctx.wal._compute_continuity()
        sys.stderr.write("continuity after failover: %s\n" % {k: v.get(k) for k in v if k != "segments"})
        self.assertEqual(v.get("gap_count"), 0, v)


if __name__ == "__main__":
    unittest.main()
