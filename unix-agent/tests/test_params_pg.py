"""Parameter validation and role/psql independence against a REAL PostgreSQL whose superuser is NOT called postgres.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_params_pg'"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.test_engine_pg import BIN, SKIP, sh
from pg_arca import pgaccess
from pg_arca.db_client import PostgresClient


@unittest.skipIf(SKIP, "PostgreSQL binaries not available")
class Params(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.b = tempfile.mkdtemp(prefix="arca_pp_")
        cls.data, cls.sock, cls.port = cls.b + "/data", cls.b + "/s", 56500 + os.getpid() % 200
        os.makedirs(cls.sock)
        assert sh(os.path.join(BIN, "initdb"), "-D", cls.data, "-U", "dba_root", "--auth=trust").returncode == 0          # superuser with an unusual name
        with open(cls.data + "/postgresql.conf", "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\n" % (cls.port, cls.sock))
        assert sh(os.path.join(BIN, "pg_ctl"), "-D", cls.data, "-l", cls.b + "/l", "-w", "start").returncode == 0
        # psql NOT on the PATH of this test process: found through the configured binaries directory
        cls.db = PostgresClient(user="dba_root", port=cls.port, socket_dir=cls.sock, psql_path=pgaccess.find_tool("psql", {"pg_bin_dir": BIN}))

    @classmethod
    def tearDownClass(cls):
        sh(os.path.join(BIN, "pg_ctl"), "-D", cls.data, "-m", "fast", "-w", "stop")
        shutil.rmtree(cls.b, ignore_errors=True)

    def ok(self, name, value):
        info, why = self.db.validate_param(name, value)
        self.assertIsNone(why, "%s=%r: %s" % (name, value, why))

    def bad(self, name, value, frag):
        info, why = self.db.validate_param(name, value)
        self.assertIsNotNone(why, "%s=%r should be refused" % (name, value))
        self.assertIn(frag, why)

    def test_the_client_uses_the_given_psql_and_role(self):
        self.assertTrue(os.path.isabs(self.db.psql))
        self.assertTrue(self.db.ping())
        self.db.user = "postgres"
        self.assertFalse(self.db.ping())                                   # the role "postgres" does not exist here: the old hard-coded default would have failed
        self.db.user = "dba_root"

    def test_role_resolution_finds_the_working_one(self):
        owner = pgaccess.data_dir_owner(self.data)
        c = PostgresClient(user="postgres", port=self.port, socket_dir=self.sock, psql_path=self.db.psql)
        got = pgaccess.resolve_user(c, {"pg_user": "dba_root"}, {"data_directory": self.data})
        self.assertEqual(got, "dba_root")                                  # explicit setting is taken as is
        got = pgaccess.resolve_user(c, {}, {"data_directory": self.data})
        self.assertIn(got, pgaccess.candidate_users({}, {"data_directory": self.data}))   # none connects: it stays on a sensible candidate
        self.assertEqual(pgaccess.candidate_users({}, {"data_directory": self.data})[0], owner if owner != "root" else "postgres")

    def test_valid_values_with_units(self):
        self.ok("shared_buffers", "512MB")
        self.ok("shared_buffers", "1GB")
        self.ok("work_mem", "64MB")
        self.ok("max_wal_size", "8GB")
        self.ok("checkpoint_timeout", "15min")
        self.ok("statement_timeout", "5s")
        self.ok("statement_timeout", "0")
        self.ok("autovacuum", "off")
        self.ok("wal_level", "replica")
        self.ok("checkpoint_completion_target", "0.9")
        self.ok("max_connections", "300")
        self.ok("log_min_duration_statement", "-1")
        self.ok("work_mem", None)                                          # RESET

    def test_refusals_have_a_reason(self):
        self.bad("shared_bufers", "1GB", "unknown parameter")
        self.bad("autovacuum", "maybe", "not a boolean")
        self.bad("wal_level", "turbo", "allowed values")
        self.bad("max_connections", "0", "below the minimum")
        self.bad("max_connections", "999999999", "above the maximum")
        self.bad("work_mem", "12 parsecs", "unit")
        self.bad("work_mem", "lots", "not a number")
        self.bad("max_connections", "1.5", "whole number")
        self.bad("max_connections", "10MB", "no unit")
        self.bad("checkpoint_completion_target", "1.5", "above the maximum")
        self.bad("work_mem", "1GB\n; DROP", "control characters")

    def test_amcheck_looks_next_to_its_psql(self):
        st, msg = self.db.verify_amcheck("postgres")
        self.assertIn(st, (True, False, None))                              # either it ran or it said why it could not: never an exception from a missing PATH entry


if __name__ == "__main__":
    unittest.main()
