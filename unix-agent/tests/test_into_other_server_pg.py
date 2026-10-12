"""Delivery to ANOTHER PostgreSQL server (central recovery host -> the cluster that receives the result, `into`): the destination does not have
the tablespaces or the roles of the source. The restore must still work, keep what it can and say what it could not.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_into_other_server_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import BIN, F, q, sh

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_database, restore_object
from pg_arca.engine.pgsession import PgConn, PgSession

B = {}


def qb(db, sql):
    s = PgSession(B["conn"].with_db(db))
    try:
        return s.query(sql)
    finally:
        s.close()


def setUpModule():
    base.setUpModule()
    B["dir"] = os.path.join(F.base, "other")
    B["port"] = F.port + 1
    r = sh(os.path.join(BIN, "initdb"), "-D", B["dir"], "-U", "postgres", "--auth=trust")
    assert r.returncode == 0, r.stderr
    with open(os.path.join(B["dir"], "postgresql.conf"), "a") as f:
        f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\nshared_buffers=32MB\n" % (B["port"], F.sock))
    r = sh(os.path.join(BIN, "pg_ctl"), "-D", B["dir"], "-l", os.path.join(F.base, "other.log"), "-w", "start")
    assert r.returncode == 0, r.stderr
    B["conn"] = PgConn(host=F.sock, port=B["port"], user="postgres", bindir=BIN)
    B["into"] = {"host": F.sock, "port": B["port"], "user": "postgres"}
    d = os.path.join(F.base, "ts_src_only")
    os.makedirs(d, exist_ok=True)
    q("postgres", "CREATE TABLESPACE ts_src_only LOCATION '%s'" % d)
    q("postgres", "CREATE ROLE src_only_role NOLOGIN")
    q("postgres", "CREATE DATABASE far_db")
    q("far_db", "CREATE TABLE t (id int PRIMARY KEY, v text) TABLESPACE ts_src_only; INSERT INTO t SELECT g, 'v' || g FROM generate_series(1, 300) g;"
                "GRANT SELECT ON t TO src_only_role; CREATE TABLE u AS SELECT generate_series(1, 50) AS id")
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(2)


def tearDownModule():
    sh(os.path.join(BIN, "pg_ctl"), "-D", B["dir"], "-m", "immediate", "stop")
    base.tearDownModule()


class Into(unittest.TestCase):
    def test_01_database_to_a_server_without_the_tablespace_and_role(self):
        r = restore_database(F.ctx, "far_db", new_name="far_copy", into=B["into"])
        self.assertEqual(qb("far_copy", "SELECT count(*) FROM t")[0][0], "300")
        w = " ".join(r.get("warnings") or [])
        self.assertIn("ts_src_only", w)
        self.assertIn("src_only_role", w)
        self.assertFalse(r.get("owners_and_privileges"))

    def test_02_object_to_a_server_without_the_tablespace_and_role(self):
        qb("postgres", "CREATE DATABASE far_db")                      # the receiving side has the database (empty): the table is delivered there
        r = restore_object(F.ctx, "far_db.public.t", into=B["into"], stage_db="pgarca_stage_far")
        self.assertTrue(any("ts_src_only" in w for w in r.get("warnings") or []), r.get("warnings"))
        p = promote_object(F.ctx, "pgarca_stage_far", "far_db", mode="missing_only", drop_stage=True, into=B["into"])
        self.assertEqual(qb("far_db", "SELECT count(*) FROM t")[0][0], "300")
        self.assertTrue(p)


if __name__ == "__main__":
    unittest.main()
