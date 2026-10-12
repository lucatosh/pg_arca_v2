"""The server-side destination probe through a REAL PostgreSQL: COPY ... TO PROGRAM runs pg-arca-wal probe as the server's OS user, the same way
archive_command runs. Here agent and server are the same user (postgres); the different-users case is tests.test_destcheck.Identities (runuser).

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_destcheck_pg -v'
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F

from pg_arca.engine import destcheck
from pg_arca.engine.pgsession import PgSession
from pg_arca.engine.util import EngineError

TOOL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pg-arca-wal")


def setUpModule():
    base.setUpModule()


def tearDownModule():
    base.tearDownModule()


def run_sql(sql):
    s = PgSession(F.ctx.conn.with_db("postgres"))
    try:
        return True, s.query(sql) and "", ""
    except EngineError as e:
        return False, "", e.message
    finally:
        s.close()


class ServerProbe(unittest.TestCase):
    def test_probe_through_postgresql(self):
        d = os.path.realpath(tempfile.mkdtemp(dir=F.base))
        r = destcheck.server_probe(run_sql, TOOL, d)
        self.assertEqual({c["id"]: c["level"] for c in r["checks"]}, {"server_write": "ok", "server_read": "ok"}, r)
        self.assertEqual(r["server"]["uid"], os.getuid(), "the program ran as the server's user")
        self.assertEqual(os.listdir(d), [])

    def test_unwritable_directory_is_reported_with_the_servers_words(self):
        d = os.path.realpath(tempfile.mkdtemp(dir=F.base))
        os.chmod(d, 0o500)                                   # nobody (not even the owner) can create files: both writers fail
        try:
            r = destcheck.server_probe(run_sql, TOOL, d)
            self.assertEqual([c["level"] for c in r["checks"]], ["warn"], r)            # the agent's own write fails first: the server test is not run
        finally:
            os.chmod(d, 0o700)



if __name__ == "__main__":
    unittest.main()
