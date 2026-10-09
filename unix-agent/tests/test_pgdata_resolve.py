import os, tempfile, unittest
from pg_arca.engine.ctx import _resolve_pgdata


class PgdataResolve(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.parent = self.t                                   # like /var/lib/postgresql/data (no PG_VERSION)
        self.real = os.path.join(self.t, "pgdata"); os.mkdir(self.real)
        open(os.path.join(self.real, "PG_VERSION"), "w").write("16\n")

    def test_env_hint_pointing_at_parent_is_ignored(self):
        self.assertEqual(_resolve_pgdata({"pg_data_hint": self.parent}, {"data_directory": self.real}), self.real)

    def test_hint_used_only_when_nothing_detected(self):
        self.assertEqual(_resolve_pgdata({"pg_data_hint": self.real}, {}), self.real)

    def test_valid_explicit_wins(self):
        other = os.path.join(self.t, "other"); os.mkdir(other); open(os.path.join(other, "PG_VERSION"), "w").write("16\n")
        self.assertEqual(_resolve_pgdata({"pg_data": other}, {"data_directory": self.real}), other)

    def test_invalid_explicit_falls_back_and_warns(self):
        msgs = []
        self.assertEqual(_resolve_pgdata({"pg_data": self.parent}, {"data_directory": self.real}, lambda l, m: msgs.append(m)), self.real)
        self.assertTrue(msgs)


if __name__ == "__main__":
    unittest.main()
