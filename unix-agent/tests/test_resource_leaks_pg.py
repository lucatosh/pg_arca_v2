"""The agent is a long-running process: every operation must give back what it took. After a warm-up round, the same operations are repeated and
the process must not keep more open file descriptors, threads or child processes (live or zombie) than before:
backup (full and incremental), verify, repository info, database restore, table restore + promotion, a PITR restore of the instance, retention,
the telemetry loop (discovery + snapshot), and sessions that fail to connect (a server that is down, a wrong port).

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_resource_leaks_pg -v'
"""
import gc
import os
import shutil
import sys
import threading
import time
import unittest
import warnings

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_database, restore_object
from pg_arca.engine.maintenance import expire, repo_info, verify
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance
from pg_arca.engine.util import EngineError
from pg_arca.config import load_config
from pg_arca.runtime import Runtime
from pg_arca.wal_manager import WalManager

DB = "leakdb"


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, "CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t SELECT g, md5(g::text) FROM generate_series(1, 20000) g")
    run_backup(F.ctx, "full")


def tearDownModule():
    base.tearDownModule()


def children():
    me, out = os.getpid(), []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % pid) as f:
                st = f.read()
        except (IOError, OSError):
            continue
        rest = st[st.rindex(")") + 2:].split()
        if int(rest[1]) == me:
            out.append("%s %s %s" % (pid, rest[0], st[st.index("(") + 1:st.rindex(")")]))
    return out


def snapshot():
    gc.collect()
    time.sleep(0.5)
    fds = {}
    for fd in os.listdir("/proc/self/fd"):
        try:
            fds[fd] = os.readlink("/proc/self/fd/%s" % fd)
        except OSError:
            pass
    return {"fds": fds, "threads": sorted(t.name for t in threading.enumerate()), "children": children()}


class Leaks(unittest.TestCase):
    n = 0

    _rt = None

    def rt(self):
        if Leaks._rt is None:
            cfg = load_config()
            cfg.update({"pg_data": F.src, "pg_port": F.port, "pg_host": F.sock, "pg_user": "postgres", "repo_path": F.repo, "wal_archive_dir": F.wal,
                        "state_dir": os.path.join(F.scratch, "state"), "node_name": "leak"})
            Leaks._rt = Runtime(cfg)
        return Leaks._rt

    def round(self):
        Leaks.n += 1
        i = Leaks.n
        q(DB, "UPDATE t SET v = v || '%d' WHERE id %% 10 = %d" % (i, i % 10))
        run_backup(F.ctx, "incr")
        verify(F.ctx)
        repo_info(F.ctx)
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(1.5)
        restore_database(F.ctx, DB, new_name="leak_copy%d" % i)
        q("postgres", "DROP DATABASE leak_copy%d" % i)
        restore_object(F.ctx, DB, objects=["%s.public.t" % DB], stage_db="pgarca_stage_leak%d" % i)
        promote_object(F.ctx, "pgarca_stage_leak%d" % i, DB, mode="as_new", drop_stage=True)
        q(DB, "DO $$ DECLARE r record; BEGIN FOR r IN SELECT relname FROM pg_class WHERE relname LIKE 't\\_pitr\\_%' AND relkind = 'r' LOOP "
              "EXECUTE format('DROP TABLE %I CASCADE', r.relname); END LOOP; END $$")
        dest = os.path.join(F.scratch, "leak_inst%d" % i)
        restore_instance(F.ctx, dest=dest, action="promote")
        shutil.rmtree(dest, ignore_errors=True)
        expire(F.ctx, retention_full=2)
        rt = self.rt()                                        # the telemetry loop: discovery and a snapshot every few seconds, for months
        for _ in range(3):
            rt.refresh()
            snap = rt.build_snapshot(WalManager(F.wal, "none"), None)
            self.assertTrue(snap["postgres"].get("alive"), snap["postgres"])
        for port in (1, F.port + 777):                       # nothing listens there: the session must not leave psql or its pipes behind
            with self.assertRaises(EngineError):
                PgSession(PgConn(host=F.sock, port=port, user="postgres", bindir=base.BIN))

    def test_repeated_operations_give_everything_back(self):
        self.round()                                          # warm-up: imports, caches, the first lazily started helpers
        before = snapshot()
        with warnings.catch_warnings(record=True) as caught:   # a file or pipe the code forgot to close (only the garbage collector saved it)
            warnings.simplefilter("always", ResourceWarning)
            for _ in range(2):
                self.round()
            after = snapshot()
        unclosed = sorted({"%s:%s %s" % (os.path.relpath(w.filename, base.HERE), w.lineno, str(w.message)[:90]) for w in caught
                           if issubclass(w.category, ResourceWarning) and "pg_arca" in w.filename})
        self.assertFalse(unclosed, "left for the garbage collector to close: %s" % unclosed)
        new_fds = {k: v for k, v in after["fds"].items() if before["fds"].get(k) != v}
        self.assertLessEqual(len(after["fds"]), len(before["fds"]), "file descriptors kept open: %s" % new_fds)
        self.assertEqual(after["children"], before["children"], "child processes left behind (pid state name)")
        self.assertLessEqual(len(after["threads"]), len(before["threads"]), "threads left running: %s -> %s" % (before["threads"], after["threads"]))


if __name__ == "__main__":
    unittest.main()
