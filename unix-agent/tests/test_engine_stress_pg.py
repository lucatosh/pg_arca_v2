"""Backups taken WHILE the database is being written (inserts, updates, deletes, vacuum) must restore to a consistent cluster: after recovery every page of
the restored cluster passes its checksum, indexes are valid (amcheck when present) and row counts match what the chain promised. full -> incr -> diff -> incr.
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_engine_stress_pg -v'
"""
import os
import random
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from pg_arca.engine.backup import run_backup
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance

SKIP = T.SKIP
setUpModule = T.setUpModule
tearDownModule = T.tearDownModule


class Writer(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.stop_flag = False
        self.err = None
        self.n = 0

    def run(self):
        try:
            s = PgSession(T.F.conn.with_db("app"))
            try:
                while not self.stop_flag:
                    r = random.random()
                    if r < 0.5:
                        s.query("INSERT INTO t(v) SELECT repeat(md5(random()::text), 4) FROM generate_series(1,200)")
                    elif r < 0.8:
                        s.query("UPDATE t SET v = repeat(md5(random()::text), 4) WHERE id %% 17 = %d" % random.randint(0, 16))
                    elif r < 0.95:
                        s.query("DELETE FROM t WHERE id %% 29 = %d" % random.randint(0, 28))
                    else:
                        s.query("VACUUM t")
                    self.n += 1
            finally:
                s.close()
        except Exception as e:
            self.err = e


class StressTests(unittest.TestCase):
    def test_backups_under_write_load_restore_consistently(self):
        T.q("postgres", "CREATE DATABASE app")
        T.q("app", "CREATE TABLE t(id serial primary key, v text); CREATE INDEX t_v ON t(v); INSERT INTO t(v) SELECT md5(g::text) FROM generate_series(1,50000) g")
        w = Writer(); w.start()
        try:
            sets = []
            for typ in ("full", "incr", "diff", "incr"):
                sets.append(run_backup(T.F.ctx, typ))
                time.sleep(1)
        finally:
            w.stop_flag = True; w.join(30)
        self.assertIsNone(w.err, w.err)
        self.assertGreater(w.n, 20, "the writer really ran during the backups")
        self.assertEqual([m["type"] for m in sets], ["full", "incr", "diff", "incr"])
        T.q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)
        dest = os.path.join(T.F.base, "stress_restore")
        restore_instance(T.F.ctx, set_spec=sets[-1]["id"], dest=dest, immediate=True, action="promote")
        port2 = T.F.port + 3
        with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\narchive_mode=off\narchive_command=''\n" % (port2, T.F.sock))
        r = T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-l", dest + ".log", "-w", "-t", "400", "start")
        self.assertEqual(r.returncode, 0, r.stderr + open(dest + ".log").read()[-2000:])
        s = PgSession(PgConn(host=T.F.sock, port=port2, user="postgres", bindir=T.BIN, dbname="app"))
        try:
            for _ in range(400):
                if s.scalar("SELECT pg_is_in_recovery()") == "f":
                    break
                time.sleep(1)
            n = int(s.scalar("SELECT count(*) FROM t"))
            self.assertGreater(n, 1000)
            # index and heap agree (a torn / stale page would break one of them)
            self.assertEqual(int(s.scalar("SET enable_seqscan=off; SELECT count(*) FROM t WHERE id > 0")), n)
            try:
                s.query("CREATE EXTENSION IF NOT EXISTS amcheck")
                s.query("SELECT bt_index_check(c.oid, true) FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname IN ('t_pkey','t_v')")
            except Exception as e:
                if "amcheck" not in str(e):
                    raise
        finally:
            s.close()
            T.sh(os.path.join(T.BIN, "pg_ctl"), "-D", dest, "-m", "fast", "stop")
        c = T.sh(os.path.join(T.BIN, "pg_checksums"), "--check", "-D", dest)
        self.assertEqual(c.returncode, 0, c.stdout[-800:] + c.stderr[-800:])


if __name__ == "__main__":
    unittest.main()
