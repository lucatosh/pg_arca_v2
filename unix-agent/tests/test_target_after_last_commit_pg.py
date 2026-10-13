"""A recovery TIME after the last transaction in the archive: an idle database ('restore to 10 minutes ago' when nothing was written since), or the end
of an abandoned timeline. PostgreSQL (13+) only stops at a time when it meets a commit/abort record AFTER it; with none it replays everything and then
refuses to start ('recovery ended before configured recovery target was reached'). The state at that time IS the end of the archive, so:
  - a whole-instance restore must give a copy that STARTS, with every row (clamped to the end of the archive, and said)
  - a database restore and a table restore give the same rows
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_target_after_last_commit_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_database
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance

X = T.Fx()


def setUpModule():
    T.setUpModule()
    q("postgres", "CREATE DATABASE idle")
    q("idle", "CREATE TABLE notes (id serial PRIMARY KEY, tag text); INSERT INTO notes (tag) SELECT 'A' FROM generate_series(1, 100)")
    run_backup(F.ctx, "full")
    q("idle", "INSERT INTO notes (tag) SELECT 'B' FROM generate_series(1, 50)")
    time.sleep(2)
    X.t = q("postgres", "SELECT to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
    time.sleep(1)
    last = q("postgres", "SELECT pg_walfile_name(pg_switch_wal() - 1)")[0][0]
    for _ in range(90):
        if (q("postgres", "SELECT COALESCE(last_archived_wal, '') FROM pg_stat_archiver")[0][0] or "") >= last:
            break
        time.sleep(1)


def tearDownModule():
    T.tearDownModule()


class AfterLastCommit(unittest.TestCase):
    def test_01_instance_restore_starts_with_every_row(self):
        dest = os.path.join(F.base, "inst")
        plan = restore_instance(F.ctx, dest=dest, target_time=X.t, action="promote")
        port2 = F.port + 5
        with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\n" % (port2, F.sock))
        r = T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-l", dest + ".log", "-w", "-t", "120", "start")
        try:
            self.assertEqual(r.returncode, 0, open(dest + ".log").read()[-1500:])
            s = PgSession(PgConn(host=F.sock, port=port2, user="postgres", bindir=T.BIN, dbname="idle"))
            try:
                for _ in range(60):
                    if s.scalar("SELECT pg_is_in_recovery()") == "f":
                        break
                    time.sleep(1)
                self.assertEqual(s.query("SELECT tag, count(*) FROM notes GROUP BY 1 ORDER BY 1"), [["A", "100"], ["B", "50"]])
            finally:
                s.close()
        finally:
            T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")
        self.assertTrue(plan.get("target_clamped"), plan)
        self.assertIn("end of the archive", plan["start_hint"])

    def test_02_database_restore_gives_the_same_rows(self):
        restore_database(F.ctx, "idle", target_time=X.t, new_name="idle_back")
        self.assertEqual(q("idle_back", "SELECT tag, count(*) FROM notes GROUP BY 1 ORDER BY 1"), [["A", "100"], ["B", "50"]])


if __name__ == "__main__":
    unittest.main()
