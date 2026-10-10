import os
import tempfile
import unittest

from pg_arca.runtime import LogShipper


class _Rt(object):
    instance = {}
    patroni_info = {}


class LogShipperModes(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.f = os.path.join(self.d, "postgresql.log")
        open(self.f, "w").close()
        self.s = LogShipper({"log_files": [self.f]}, _Rt())
        self.s.collect()                      # first sight

    def _append(self, *lines):
        with open(self.f, "a") as h:
            for l in lines:
                h.write(l + "\n")

    def test_alerts_mode_ships_only_warn_and_above(self):
        self._append("LOG: checkpoint starting", "WARNING: something odd", "ERROR: boom", "LOG: checkpoint complete")
        out = self.s.collect()
        self.assertEqual([e["level"] for e in out], ["WARN", "ERROR"])
        self.assertEqual(len(self.s.backlog), 2)

    def test_switching_to_full_backfills_in_order_and_follows(self):
        self._append("LOG: one", "ERROR: two", "LOG: three")
        first = self.s.collect()
        self.assertEqual([e["message"] for e in first], ["ERROR: two"])
        self.s.set_mode("full")
        back = self.s.collect()
        self.assertEqual([e["message"] for e in back], ["LOG: one", "LOG: three"])      # the alert was already shipped: no duplicate
        self._append("LOG: four")
        self.assertEqual([e["message"] for e in self.s.collect()], ["LOG: four"])
        self.s.set_mode("alerts")
        self._append("LOG: five")
        self.assertEqual(self.s.collect(), [])

    def test_no_line_is_lost_beyond_the_batch_limit(self):
        self.s.set_mode("full")
        self._append(*["LOG: line %d" % i for i in range(450)])
        got = []
        for _ in range(5):
            got += self.s.collect(limit=200)
        self.assertEqual(len(got), 450)
        self.assertEqual(got[-1]["message"], "LOG: line 449")

    def test_unknown_mode_is_ignored(self):
        self.s.set_mode("bogus")
        self.assertEqual(self.s.mode, "alerts")


if __name__ == "__main__":
    unittest.main()
