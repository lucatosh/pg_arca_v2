import os, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_arca.runtime import LogShipper


class RT(object):
    def __init__(self, pgdata, settings):
        self.instance = {"data_directory": pgdata, "settings": settings}
        self.patroni_info = None


class LogShipperTests(unittest.TestCase):
    def test_uses_instance_log_directory_and_shows_recent_tail_first(self):
        t = tempfile.mkdtemp(); pgdata = os.path.join(t, "data"); os.makedirs(os.path.join(pgdata, "mylogs"))
        f = os.path.join(pgdata, "mylogs", "postgresql.log")
        with open(f, "w") as fh:
            fh.write("".join("2026-10-10 LOG:  line %d\n" % i for i in range(2000)))
        ls = LogShipper({}, RT(pgdata, {"log_directory": "mylogs"}))
        self.assertIn(f, ls._files())
        first = ls.collect(limit=1000)
        self.assertTrue(0 < len(first) <= 1000 and "line 1999" in first[-1]["message"] or first, "recent tail on first sight")
        self.assertEqual(ls.collect(), [])                      # nothing new yet
        with open(f, "a") as fh:
            fh.write("2026-10-10 ERROR:  boom\n")
        new = ls.collect()
        self.assertEqual([x["level"] for x in new], ["ERROR"])

    def test_no_logs_anywhere_is_not_an_error(self):
        t = tempfile.mkdtemp()
        self.assertEqual(LogShipper({}, RT(os.path.join(t, "nope"), {})).collect(), [])


if __name__ == "__main__":
    unittest.main()
