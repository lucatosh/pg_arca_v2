"""Backup engine review (independent, 16/10 night) against a real PostgreSQL:
  - a file the parent did not have (a database created with FILE_COPY copies pages with their OLD LSNs) is stored whole by an incremental;
  - a hole in the WAL archive since the chain's full turns the next incremental into a full (it used to be COMPLETE and unrestorable);
  - data checksums switched off/on (pg_checksums) since the chain's full turn the next incremental into a full;
  - a directory the agent cannot read fails the backup instead of leaving data out of a 'COMPLETE' set.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_backup_review_pg'"""
import os
import shutil
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests import test_engine_pg as T
from tests.test_engine_pg import BIN, F, q, sh
from pg_arca.engine.backup import run_backup
from pg_arca.engine.util import EngineError, lsn_to_int, parse_wal_name, wal_segno


def setUpModule():
    T.setUpModule()
    q("postgres", "CREATE DATABASE tpl")
    q("tpl", "CREATE TABLE t AS SELECT g AS id, repeat('x', 300) AS pad FROM generate_series(1, 20000) g")
    q("postgres", "CHECKPOINT")


def tearDownModule():
    T.tearDownModule()


def archived_wait():
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


class BackupReview(unittest.TestCase):
    def test_01_new_database_is_stored_whole(self):
        run_backup(F.ctx, "full")
        ver = int(q("postgres", "SHOW server_version_num")[0][0])
        q("postgres", "CREATE DATABASE fc TEMPLATE tpl" + (" STRATEGY FILE_COPY" if ver >= 150000 else ""))
        oid = q("postgres", "SELECT oid FROM pg_database WHERE datname = 'fc'")[0][0]
        meta = run_backup(F.ctx, "incr")
        self.assertEqual(meta["type"], "incr")
        man = F.ctx.repo.load_manifest(meta)["files"]
        mine = dict((k, v) for k, v in man.items() if k.startswith("base/%s/" % oid) and v.get("kind") == "pages")
        self.assertTrue(mine)
        for rel, e in mine.items():
            self.assertEqual(sum(c[1] for c in e["chunks"]), e["size"], "%s: stored whole (its pages carry the template's old LSNs)" % rel)

    def test_02_hole_since_the_full_promotes_to_full(self):
        full = run_backup(F.ctx, "full")
        for _ in range(3):
            q("tpl", "UPDATE t SET pad = pad WHERE id < 2000")
            archived_wait()
        seg = F.seg
        lo = wal_segno(lsn_to_int(full["stop_lsn"]), seg)
        names = sorted(n for n in os.listdir(F.wal) if parse_wal_name(n.split(".")[0], seg) and parse_wal_name(n.split(".")[0], seg)[1] > lo + 0)
        names = [n for n in names if not n.endswith((".meta", ".partial", ".history"))]
        self.assertGreaterEqual(len(names), 2, names)
        victim = names[0]
        aside = os.path.join(F.base, "aside")
        os.makedirs(aside, exist_ok=True)
        moved = [n for n in os.listdir(F.wal) if n.startswith(victim.split(".")[0])]
        for n in moved:
            shutil.move(os.path.join(F.wal, n), os.path.join(aside, n))
        try:
            meta = run_backup(F.ctx, "incr")
            self.assertEqual(meta["type"], "full", "a chain with a hole cannot take an incremental")
            self.assertEqual(meta.get("promoted_from"), "incr")
            self.assertEqual(meta["status"], "COMPLETE")
        finally:
            for n in moved:
                shutil.move(os.path.join(aside, n), os.path.join(F.wal, n))

    def test_03_unreadable_directory_fails_the_backup(self):
        if os.geteuid() == 0:
            self.skipTest("root reads every directory")
        d = os.path.join(F.src, "pgarca_unreadable")
        os.makedirs(os.path.join(d, "sub"))
        os.chmod(d, 0)
        try:
            with self.assertRaises(EngineError) as e:
                run_backup(F.ctx, "full")
            self.assertEqual(e.exception.code, "PGA-GEN-044")
        finally:
            os.chmod(d, 0o700)
            shutil.rmtree(d)

    def test_04_checksums_changed_promotes_to_full(self):
        run_backup(F.ctx, "full")
        q("tpl", "UPDATE t SET pad = pad WHERE id < 100")
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", F.src, "-w", "-m", "fast", "stop")
        self.assertEqual(r.returncode, 0, r.stderr)
        try:
            r = sh(os.path.join(BIN, "pg_checksums"), "-D", F.src, "--disable")
            self.assertEqual(r.returncode, 0, r.stderr)
        finally:
            r = sh(os.path.join(BIN, "pg_ctl"), "-D", F.src, "-l", os.path.join(F.base, "src.log"), "-w", "start")
            self.assertEqual(r.returncode, 0, r.stderr)
        meta = run_backup(F.ctx, "incr")
        self.assertEqual(meta["type"], "full", "the chain's full has checksums, the server has none now")
        self.assertFalse(meta.get("data_checksums"))


if __name__ == "__main__":
    unittest.main()
