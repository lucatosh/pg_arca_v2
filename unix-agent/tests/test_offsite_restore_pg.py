"""The site is lost, only the offsite copy (S3) survives: the backup repository and the WAL archive come back from the bucket ("download what
is missing" into empty directories) and the restores work from them alone - a point in time of a database in the backup, and a database
created AFTER the last backup and dropped since (it needs the oid->name registry that travels with the archive).

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_offsite_restore_pg -v'
"""
import os
import shutil
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q
from tests.fake_s3 import FakeS3

from pg_arca import offsite
from pg_arca.engine.backup import run_backup
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.granular import restore_database
from pg_arca.wal_manager import WalManager

S = {}


def now_txt():
    return q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]


def note_dbs():
    """What the agent's snapshot does on the primary: the oid->name registry next to the archive."""
    F.ctx.wal.note_databases([{"oid": int(r[0]), "name": r[1]} for r in q("postgres", "SELECT oid, datname FROM pg_database WHERE NOT datistemplate")])


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE shop")
    q("shop", "CREATE TABLE orders AS SELECT g AS id, md5(g::text) AS v FROM generate_series(1, 10000) g")
    run_backup(F.ctx, "full")
    q("shop", "INSERT INTO orders SELECT g, 'after' FROM generate_series(10001, 10500) g")
    q("postgres", "CREATE DATABASE scratch_today")                       # created after the last backup...
    q("scratch_today", "CREATE TABLE notes AS SELECT g AS id FROM generate_series(1, 321) g")
    S["late_oid"] = q("postgres", "SELECT oid FROM pg_database WHERE datname = 'scratch_today'")[0][0]
    note_dbs()
    time.sleep(1.2)
    S["t_ok"] = now_txt()
    time.sleep(1.2)
    q("shop", "DELETE FROM orders WHERE id > 5000")                       # the damage
    q("postgres", "DROP DATABASE scratch_today")                         # ...and dropped since
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)
    S["srv"] = FakeS3()
    S["state"] = os.path.join(F.base, "offsite-state")
    cfg = {"repo_path": F.repo, "wal_archive_dir": F.wal, "state_dir": S["state"],
           "offsite": {"type": "s3", "endpoint": S["srv"].endpoint, "bucket": "bk", "prefix": "site1", "access_key": "AKTEST", "secret_key": "s", "region": "us-east-1"}}
    S["mirror"] = offsite.Mirror(cfg, S["state"])
    st = S["mirror"].sync()
    assert st["ok"], st


def tearDownModule():
    try:
        S["srv"].close()
    finally:
        base.tearDownModule()


def fresh_ctx():
    return Ctx(F.conn, F.src, F.repo, "main", F.wal, F.scratch, process_max=4, compression="zlib", level=3, start_fast=True, seg_size=F.seg,
               agent_path=F.ctx.agent_path, key_file=F.key or None)


class SiteLost(unittest.TestCase):
    def test_01_everything_comes_back_from_the_bucket(self):
        for d in (F.repo, F.wal):
            shutil.move(d, d + ".lost")
            os.makedirs(d, mode=0o750)
        r = S["mirror"].rehydrate()
        self.assertGreater(r["downloaded"], 5, r)
        self.assertEqual(r["refused_count"], 0, r)
        self.assertEqual(r["retained_skipped"], 0, "nothing was removed on purpose: everything comes back")
        self.assertEqual(WalManager(F.wal, crypto=fresh_ctx().crypto).database_names().get(str(S["late_oid"])), "scratch_today",
                         "the oid->name registry came back with the archive")

    def test_02_point_in_time_from_the_offsite_copy_alone(self):
        r = restore_database(fresh_ctx(), "shop", target_time=S["t_ok"], new_name="shop_back")
        self.assertEqual(r["result_database"], "shop_back")
        self.assertEqual(q("shop_back", "SELECT count(*), count(*) FILTER (WHERE v = 'after') FROM orders")[0], ["10500", "500"])

    def test_03_database_created_after_the_backup_and_dropped(self):
        r = restore_database(fresh_ctx(), "scratch_today", target_time=S["t_ok"], new_name="scratch_back")
        self.assertEqual(r["result_database"], "scratch_back")
        self.assertEqual(q("scratch_back", "SELECT count(*) FROM notes")[0][0], "321")


if __name__ == "__main__":
    unittest.main()
