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


if __name__ == "__main__":
    unittest.main()
