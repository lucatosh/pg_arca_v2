"""Production replacement, the parts that need no PostgreSQL: which systemd unit runs a data directory that is DOWN (RHEL / Debian layouts),
the options production was started with, which directories count as kept by a replacement."""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pg_arca.engine import replace
from pg_arca.engine.util import EngineError


class FindUnit(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_rhel_unit_found_by_pgdata(self):
        pgdata = os.path.join(self.d, "16", "data")
        os.makedirs(pgdata)

        def run(cmd, timeout=30):
            if cmd[1] == "list-units":
                return 0, "postgresql-15.service loaded inactive dead x\npostgresql-16.service loaded failed failed y\n", ""
            if cmd[1] == "list-unit-files":
                return 0, "postgresql-15.service disabled\npostgresql-16.service enabled\npostgresql@.service static\n", ""
            if cmd[1] == "show" and cmd[-1] == "postgresql-16.service":
                return 0, "Environment=PGDATA=%s/ PG_OOM_ADJUST_FILE=/proc/self/oom_score_adj\nExecStart={ path=/usr/pgsql-16/bin/postgres ; argv[]=/usr/pgsql-16/bin/postgres -D ${PGDATA} }\n" % pgdata, ""
            return 0, "Environment=PGDATA=/var/lib/pgsql/15/data\n", ""
        self.assertEqual(replace.find_unit(pgdata, run), "postgresql-16.service")
        self.assertIsNone(replace.find_unit(os.path.join(self.d, "other"), run))

    def test_no_systemd(self):
        self.assertIsNone(replace.find_unit("/x", lambda cmd, timeout=30: (127, "", "systemctl: not found")))

    def test_start_options_keep_everything_but_the_data_directory(self):
        self.assertEqual(replace._start_opts(["/usr/lib/postgresql/16/bin/postgres", "-D", "/var/lib/postgresql/16/main", "-c", "config_file=/etc/postgresql/16/main/postgresql.conf"]),
                         ["-c", "config_file=/etc/postgresql/16/main/postgresql.conf"])
        self.assertEqual(replace._start_opts(["postgres", "-D/data", "-p", "5433"]), ["-p", "5433"])
        self.assertEqual(replace._start_opts(None), [])

    def test_kept_and_drop_only_own_directories(self):
        pgdata = os.path.join(self.d, "main")
        os.makedirs(pgdata)
        for x in ("main.pgarca-before-20261014101010", "main.pgarca-failed-20261014101011", "main.pgarca-new-20261014101012", "main.bak", "other.pgarca-before-20261014101010"):
            os.makedirs(os.path.join(self.d, x))
        kinds = sorted(k["kind"] for k in replace.kept(pgdata))
        self.assertEqual(kinds, ["before", "failed", "partial"])
        for bad in (os.path.join(self.d, "main.bak"), os.path.join(self.d, "other.pgarca-before-20261014101010"), pgdata, "/"):
            with self.assertRaises(EngineError):
                replace.drop_kept(pgdata, bad)
        replace.drop_kept(pgdata, os.path.join(self.d, "main.pgarca-new-20261014101012"))
        self.assertEqual(len(replace.kept(pgdata)), 2)


if __name__ == "__main__":
    unittest.main()
