"""Old primary site back on the SAME timeline number as the new primary with a different history: detected from the history files; credentials for
pg_rewind read from the DBA's patroni.yml."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca import geo_rewind as g


class GeoRewind(unittest.TestCase):
    H_NEW = "1\t0/3000000\tno recovery target specified\n2\t0/5000060\tno recovery target specified\n"
    H_OLD = "1\t0/3000000\tno recovery target specified\n2\t0/50000A0\tno recovery target specified\n"

    def test_history(self):
        self.assertEqual(g.parse_history(self.H_NEW), [(1, 0x3000000), (2, 0x5000060)])
        self.assertTrue(g.diverged_same_timeline({"timeline": 3, "history": self.H_OLD}, {"timeline": 3, "history": self.H_NEW}))
        self.assertFalse(g.diverged_same_timeline({"timeline": 3, "history": self.H_NEW}, {"timeline": 3, "history": self.H_NEW.replace("no recovery", "x")}))
        self.assertFalse(g.diverged_same_timeline({"timeline": 4, "history": self.H_OLD}, {"timeline": 3, "history": self.H_NEW}))
        self.assertFalse(g.diverged_same_timeline({"timeline": 3, "history": None}, {"timeline": 3, "history": self.H_NEW}))

    def test_read_history_and_auth(self):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "pg_wal"))
        with open(os.path.join(d, "pg_wal", "0000000A.history"), "w") as f:
            f.write(self.H_NEW)
        self.assertEqual(g.read_history(d, 10), self.H_NEW)
        self.assertIsNone(g.read_history(d, 11))
        self.assertEqual(g.read_history(d, 1), "")
        y = os.path.join(d, "patroni.yml")
        with open(y, "w") as f:
            f.write("scope: x\npostgresql:\n  authentication:\n    superuser: {username: postgres, password: \"su\"}\n    rewind: {username: rewinder, password: \"rw\"}\n")
        self.assertEqual(g.patroni_auth(y), ("rewinder", "rw"))
        with open(y, "w") as f:
            f.write("postgresql:\n  authentication:\n    superuser:\n      username: postgres\n      password: su\n")
        self.assertEqual(g.patroni_auth(y), ("postgres", "su"))

    def test_inline_maps_without_pyyaml(self):
        """patroni.yml writes credentials as inline maps; a host without PyYAML (RHEL 8 platform-python, slim images) must read them too
        (found by the multi-OS matrix on python 3.6: the geo rewind crashed)."""
        import builtins
        from pg_arca.discovery import parse_simple_yaml
        real = builtins.__import__

        def no_yaml(name, *a, **k):
            if name == "yaml":
                raise ImportError(name)
            return real(name, *a, **k)
        builtins.__import__ = no_yaml
        try:
            y = parse_simple_yaml('postgresql:\n  authentication:\n    rewind: {username: rewinder, password: "r,w"}\n  list: [a, "b,c", {x: 1}]\n')
        finally:
            builtins.__import__ = real
        self.assertEqual(y["postgresql"]["authentication"]["rewind"], {"username": "rewinder", "password": "r,w"})
        self.assertEqual(y["postgresql"]["list"], ["a", "b,c", {"x": 1}])


class ClonePreconditions(unittest.TestCase):
    """force_rebuild clones NEXT to the data directory and renames it into place: refused up front (before PostgreSQL is stopped) when that cannot work."""

    def _pgdata(self):
        d = os.path.join(tempfile.mkdtemp(), "data")
        os.makedirs(os.path.join(d, "pg_tblspc"))
        open(os.path.join(d, "PG_VERSION"), "w").write("16\n")
        return d

    def test_plain_directory_passes(self):
        g._clone_preconditions(self._pgdata())

    def test_mount_point_refused(self):
        from pg_arca.engine.util import EngineError
        with self.assertRaises(EngineError) as e:
            g._clone_preconditions("/")
        self.assertEqual(e.exception.code, "PGA-GEO-025")

    def test_tablespaces_refused(self):
        from pg_arca.engine.util import EngineError
        d = self._pgdata()
        os.symlink("/tmp", os.path.join(d, "pg_tblspc", "16384"))
        with self.assertRaises(EngineError) as e:
            g._clone_preconditions(d)
        self.assertEqual(e.exception.code, "PGA-GEO-026")

    def test_space_refused(self):
        from pg_arca.engine.util import EngineError
        d = self._pgdata()
        real = os.statvfs
        class S(object):
            f_bavail, f_frsize = 10, 4096
        g.os.statvfs = lambda p: S()
        try:
            with self.assertRaises(EngineError) as e:
                g._clone_preconditions(d)
        finally:
            g.os.statvfs = real
        self.assertEqual(e.exception.code, "PGA-GEO-027")


if __name__ == "__main__":
    unittest.main()
