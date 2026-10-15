"""Quarantined WAL copies classified against the current timeline history: only the ones on the shared history are a split-brain alarm,
the leftovers of a failover (tail of a timeline the history left, partial segments, sibling timelines) are informational."""
import os
import shutil
import tempfile
import unittest

from pg_arca.wal_manager import WalManager

MB16 = 16 * 1024 * 1024


class ConflictKindTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="walkind-")
        self.wm = WalManager(self.d)
        # current timeline 3: timeline 1 ended exactly at the start of segment 3, timeline 2 inside segment 5
        with open(os.path.join(self.d, "00000003.history"), "w") as f:
            f.write("1\t0/3000000\tno recovery target specified\n2\t0/50000A0\tno recovery target specified\n")
        for name in ("000000020000000000000004", "000000020000000000000005", "000000020000000000000006", "000000010000000000000002",
                     "000000010000000000000003", "000000040000000000000009", "000000030000000000000007"):
            self._q(name + ".aaaaaaaaaaaa.1700000000")
        self._q("000000020000000000000005.partial.bbbbbbbbbbbb.1700000001")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _q(self, f):
        with open(os.path.join(self.d, "conflicts", f), "wb") as fh:
            fh.write(b"x")

    def kinds(self, tl):
        return {c["file"].split(".aaaa")[0].split(".bbbb")[0]: c["kind"] for c in self.wm.classify_conflicts(tl)}

    def test_against_current_history(self):
        k = self.kinds(3)
        self.assertEqual(k["000000020000000000000004"], "divergent")        # before timeline 2's end: read by recovery
        self.assertEqual(k["000000020000000000000005"], "off_history")      # holds the switch point: recovery reads timeline 3's copy
        self.assertEqual(k["000000020000000000000006"], "off_history")      # after it
        self.assertEqual(k["000000010000000000000002"], "divergent")        # ends exactly where timeline 1 ended: read
        self.assertEqual(k["000000010000000000000003"], "off_history")
        self.assertEqual(k["000000020000000000000005.partial"], "off_history")
        self.assertEqual(k["000000030000000000000007"], "divergent")        # the current timeline itself: a real split-brain signal
        self.assertEqual(k["000000040000000000000009"], "divergent")        # newer than the reporter: never hidden

    def test_undecidable_is_divergent(self):
        self.assertTrue(all(v == "divergent" for v in self.kinds(None).values()))
        os.unlink(os.path.join(self.d, "00000003.history"))                  # history unreadable: no proof, no relief
        self.assertTrue(all(v == "divergent" for n, v in self.kinds(3).items() if not n.endswith(".partial")))

    def test_sibling_timeline(self):
        with open(os.path.join(self.d, "00000004.history"), "w") as f:      # 4 descends from 1 and 3: timeline 2 is a sibling branch
            f.write("1\t0/3000000\tx\n3\t0/8000000\tx\n")
        self.assertEqual(self.kinds(4)["000000020000000000000004"], "off_history")

    def test_counts_in_continuity(self):
        rep = self.wm.verify_continuity(max_age=0, current_timeline=3)
        self.assertEqual((rep["conflicts"], rep["conflicts_off_history"]), (4, 4))
        rep = self.wm.verify_continuity(max_age=0)
        self.assertEqual((rep["conflicts"], rep["conflicts_off_history"]), (8, 0))
        self.wm.conflicts_reviewed([c["file"] for c in self.wm.classify_conflicts(3) if c["kind"] == "off_history"])
        rep = self.wm.verify_continuity(max_age=0, current_timeline=3)
        self.assertEqual((rep["conflicts"], rep["conflicts_off_history"]), (4, 0))


if __name__ == "__main__":
    unittest.main()
