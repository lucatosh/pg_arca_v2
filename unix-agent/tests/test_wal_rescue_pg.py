"""The failover hole and its rescue, on a REAL primary + standby: the primary's archiver is broken, segments pile up un-archived, the primary dies, the standby is
promoted. Without the rescue the archive has a hole and PITR through it is impossible; with it the segments are published from the standby's staging copy.
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_wal_rescue_pg -v'
"""
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from tests import test_engine_standby_pg as SB
from tests import test_engine_failover_pg as FO
from pg_arca.engine.backup import run_backup
from pg_arca.engine.pgsession import PgSession
from pg_arca.wal_rescue import WalRescue, _lsn_int

SKIP = T.SKIP
S = SB.S
setUpModule = SB.setUpModule
tearDownModule = SB.tearDownModule
X = T.Fx()


class Cfg(dict):
    pass


def role(conn):
    s = PgSession(conn.with_db("postgres"))
    try:
        rec = s.scalar("SELECT pg_is_in_recovery()") == "t"
        if rec:
            lsn = s.scalar("SELECT COALESCE(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())::text")
            tli = int(s.scalar("SELECT timeline_id FROM pg_control_checkpoint()"))
        else:
            lsn = s.scalar("SELECT pg_current_wal_insert_lsn()::text")
            tli = int(s.scalar("SELECT ('x' || substr(pg_walfile_name(pg_current_wal_insert_lsn()), 1, 8))::bit(32)::int"))
        return rec, tli, _lsn_int(lsn) // T.F.seg
    finally:
        s.close()


class RescueTests(unittest.TestCase):
    def test_01_hole_is_created_and_rescued(self):
        F = T.F
        rescue = WalRescue(None, F.ctx.wal, Cfg(state_dir=os.path.join(F.base, "state")), min_age=0)
        T.q("app", "DELETE FROM orders")
        run_backup(F.ctx, "full")
        # healthy cluster: nothing is missing from the archive, so nothing is staged (no extra write traffic)
        rec, tli, segno = role(S.conn)
        r = rescue.pass_once(os.path.join(S.sdir, "pg_wal"), rec, tli, segno)
        self.assertEqual(r["staged"], 0, r)
        # the primary's archiver breaks; WAL keeps being produced and completed but is never archived
        T.q("postgres", "ALTER SYSTEM SET archive_command='false'"); T.q("postgres", "SELECT pg_reload_conf()")
        for i in range(3):
            T.q("app", "INSERT INTO orders(note) SELECT 'L%d ' || g FROM generate_series(1,3000) g" % i)
            T.q("postgres", "SELECT pg_switch_wal()")
        T.q("app", "INSERT INTO orders(note) VALUES ('LAST 1')")
        time.sleep(4)
        for _ in range(30):                                        # the standby has received everything
            s = PgSession(S.conn.with_db("app"))
            try:
                if s.scalar("SELECT count(*) FROM orders WHERE note LIKE 'LAST%'") == "1":
                    break
            finally:
                s.close()
            time.sleep(1)
        rec, tli, segno = role(S.conn)
        self.assertTrue(rec)
        r = rescue.pass_once(os.path.join(S.sdir, "pg_wal"), rec, tli, segno)
        self.assertGreaterEqual(r["staged"], 3, r)
        # the primary dies; the standby is promoted
        T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", F.src, "-m", "immediate", "stop")
        self.assertEqual(T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", S.sdir, "-w", "promote").returncode, 0)
        for _ in range(30):
            if role(S.conn)[0] is False:
                break
            time.sleep(1)
        s = PgSession(S.conn.with_db("app"))
        try:
            s.query("INSERT INTO orders(note) VALUES ('NEWTLI 1')")
            s.query("SELECT pg_switch_wal()")
        finally:
            s.close()
        time.sleep(5)
        v = F.ctx.wal._compute_continuity()
        self.assertGreater(v["gap_count"], 0, "without the rescue the archive must show the hole: %s" % v)
        rec, tli, segno = role(S.conn)
        self.assertFalse(rec); self.assertEqual(tli, 2)
        r = rescue.pass_once(os.path.join(S.sdir, "pg_wal"), rec, tli, segno)
        self.assertGreaterEqual(r["published"], 3, r)
        v = F.ctx.wal._compute_continuity()
        self.assertEqual(v["gap_count"], 0, v)
        self.assertEqual([x for x in os.listdir(rescue.stage) if not x.startswith(".")], [], "staging emptied")
        X.ok = True

    def test_02_pitr_through_the_rescued_stretch(self):
        s = PgSession(S.conn.with_db("app"))
        try:
            s.query("SELECT pg_switch_wal()")
        finally:
            s.close()
        time.sleep(3)
        FO.X.full2 = run_backup(S.ctx, "full")
        rows, tli = FO.count_after_restore(None, target_time=None) if False else FO.count_after_restore(None)
        self.assertEqual(rows.get("LAST"), 1, rows)
        self.assertEqual(rows.get("L0"), 3000, rows)
        self.assertEqual(rows.get("L2"), 3000, rows)


if __name__ == "__main__":
    unittest.main()
