"""PostgreSQL 14-18 differences (independent version review, 17/10): pg_restore 17+ against a server of 16 or older, tools that refuse another
major, PostgreSQL 16 regular-expression tokens and PostgreSQL 18 oauth in pg_hba, domain NOT NULL constraints catalogued from 17. No PostgreSQL."""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca import pgcompat
from pg_arca.engine import pgsession
from pg_arca.engine.util import EngineError


class Tools(unittest.TestCase):
    def test_tool_problems(self):
        srv = pgcompat.Profile.from_text("16.4")
        probs = pgcompat.tool_problems(srv, {"pg_dump": pgcompat.Profile.from_text("15.8"), "pg_restore": pgcompat.Profile.from_text("17.2"),
                                             "pg_rewind": pgcompat.Profile.from_text("15.8"), "psql": pgcompat.Profile.from_text("15.8")})
        sev = dict((p[2].split()[0], p[0]) for p in probs)
        self.assertEqual(sev["pg_dump"], "critical", probs)
        self.assertEqual(sev["pg_rewind"], "critical")
        self.assertEqual(sev["pg_restore"], "warning")
        self.assertEqual(sev["psql"], "warning")

    def test_pg_restore_of_the_destination_major(self):
        d = tempfile.mkdtemp()
        real = (pgcompat.binary_profile, pgsession._server_major)
        from pg_arca import pgaccess
        from pg_arca.engine import ephcfg
        real_globs = (pgaccess.VENDOR_GLOBS, ephcfg.SYSTEM_GLOBS)
        try:
            b16 = os.path.join(d, "16", "bin")                     # a client-only package: pg_restore, no postgres / pg_ctl
            os.makedirs(b16)
            open(os.path.join(b16, "pg_restore"), "w").close()
            pgcompat.binary_profile = lambda p: pgcompat.Profile.from_text("16.4" if "/16/" in str(p) else "18.0")
            pgsession._server_major = lambda conn: 16
            pgaccess.VENDOR_GLOBS, ephcfg.SYSTEM_GLOBS = (os.path.join(d, "*", "bin"),), ()
            self.assertEqual(pgsession._restore_exe(object(), "/usr/lib/postgresql/18/bin/pg_restore"), os.path.join(b16, "pg_restore"))
            pgaccess.VENDOR_GLOBS = ()
            with self.assertRaises(EngineError) as e:
                pgsession._restore_exe(object(), "/usr/lib/postgresql/18/bin/pg_restore")
            self.assertEqual(e.exception.code, "PGA-VER-010")
            pgsession._server_major = lambda conn: 17
            self.assertEqual(pgsession._restore_exe(object(), "/x/18/pg_restore"), "/x/18/pg_restore", "17+ destinations know transaction_timeout")
        finally:
            pgcompat.binary_profile, pgsession._server_major = real
            pgaccess.VENDOR_GLOBS, ephcfg.SYSTEM_GLOBS = real_globs
            shutil.rmtree(d)


class Hba(unittest.TestCase):
    def test_regex_tokens_and_oauth(self):
        from pg_arca import hba
        self.assertIn("oauth", hba.METHODS)
        self.assertTrue(hba._list_match("/^pgarca", "pgarca_agent"))
        self.assertFalse(hba._list_match("/^app_", "pgarca_agent"))
        self.assertFalse(hba._list_match('"/^pgarca"', "pgarca_agent"), "quoted: a literal name")
        self.assertIsNone(hba._list_match("/(", "x"), "an expression that cannot be evaluated is uncertain")


class DomainChecks(unittest.TestCase):
    def test_only_check_constraints_are_read(self):
        src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pg_arca", "engine", "objects.py")).read()
        self.assertIn("k.contypid = t.oid AND k.contype = 'c'", src, "PostgreSQL 17 catalogues domain NOT NULL as contype 'n'")


if __name__ == "__main__":
    unittest.main()
