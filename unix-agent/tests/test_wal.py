import os, sys, tempfile, unittest, hashlib
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.wal_manager import WalManager, WalArchiveError

MB = 1 << 20

def seg(tl, log, s): return "%08X%08X%08X" % (tl, log, s)

class WalTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.wm = WalManager(os.path.join(self.t, "wal"), compression="zstd", segment_size=MB)
        self.src = os.path.join(self.t, "src"); os.makedirs(self.src)

    def mk(self, name, fill=b"a"):
        p = os.path.join(self.src, name)
        with open(p, "wb") as f: f.write(fill * MB)
        return p

    def test_archive_roundtrip_and_idempotent(self):
        n = seg(1, 0, 1); p = self.mk(n)
        ok, dest, sha, _ = self.wm.archive_segment(p, n); self.assertTrue(ok)
        ok2, dest2, sha2, msg = self.wm.archive_segment(p, n)       # PostgreSQL retry after crash
        self.assertTrue(ok2); self.assertEqual(dest, dest2); self.assertIn("identical", msg)
        out = os.path.join(self.t, "restored"); code, _ = self.wm.retrieve_segment(n, out)
        self.assertEqual(code, 0); self.assertEqual(open(out, "rb").read(), b"a" * MB)

    def test_promotion_partial_segment_is_not_a_gap(self):
        for i in (1, 2, 3):
            n = seg(1, 0, i); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, seg(1, 0, 3) + ".partial.zst"), "wb").write(b"x")     # what a promotion leaves behind
        open(os.path.join(self.wm.wal_dir, seg(1, 0, 3) + ".partial"), "wb").write(b"x")
        rep = self.wm.verify_continuity(max_age=0)
        self.assertTrue(rep["continuous"], rep)
        self.assertEqual(self.wm.list_segments(), [seg(1, 0, i) for i in (1, 2, 3)])

    def test_restore_command_errors_abort_recovery_not_end_it(self):
        from pg_arca import wal_archive
        env = dict(os.environ); os.environ["WAL_ARCHIVE_DIR"] = self.wm.wal_dir; os.environ["PG_ARCA_KEY_FILE"] = os.path.join(self.t, "missing.key")
        try:
            self.assertEqual(wal_archive.main(["x", "get", seg(1, 0, 9), os.path.join(self.t, "o")]), 126)       # exit 1 would mean 'end of archive'
            self.assertEqual(wal_archive.main(["x", "archive", self.mk(seg(1, 0, 9)), seg(1, 0, 9)]), 1)
        finally:
            os.environ.clear(); os.environ.update(env)
        self.assertEqual(wal_archive.main(["x", "get", seg(1, 0, 77), os.path.join(self.t, "o")]) , 1)           # genuinely absent -> 1

    def test_divergent_copy_is_refused_and_quarantined(self):
        n = seg(1, 0, 2); self.wm.archive_segment(self.mk(n, b"a"), n)
        with self.assertRaises(WalArchiveError) as cm: self.wm.archive_segment(self.mk(n, b"b"), n)
        self.assertEqual(cm.exception.code, "PGA-WAL-031")
        self.assertEqual(len(os.listdir(os.path.join(self.wm.wal_dir, "conflicts"))), 1)
        out = os.path.join(self.t, "r"); self.wm.retrieve_segment(n, out)
        self.assertEqual(open(out, "rb").read(), b"a" * MB)           # original untouched

    def test_corruption_aborts_recovery_not_end_of_archive(self):
        n = seg(1, 0, 3); _, dest, _, _ = self.wm.archive_segment(self.mk(n), n)
        data = bytearray(open(dest, "rb").read()); data[len(data) // 2] ^= 0xFF; open(dest, "wb").write(bytes(data))
        code, msg = self.wm.retrieve_segment(n, os.path.join(self.t, "x"))
        self.assertEqual(code, 126, msg)
        self.assertFalse(os.path.exists(os.path.join(self.t, "x")))
        self.assertEqual(self.wm.retrieve_segment(seg(1, 0, 9), os.path.join(self.t, "y"))[0], 1)   # missing => 1

    def test_rejects_partial_copy_and_bad_names(self):
        n = seg(1, 0, 4); p = os.path.join(self.src, n)
        with open(p, "wb") as f: f.write(b"x" * 1000)
        with self.assertRaises(WalArchiveError): self.wm.archive_segment(p, n)
        with self.assertRaises(WalArchiveError): self.wm.archive_segment(p, "../../etc/passwd")

    def test_continuity_rollover_and_gaps(self):
        per_id = 0x100000000 // MB
        for log, s in [(0, per_id - 2), (0, per_id - 1), (1, 0), (1, 1)]:   # crosses the logid boundary: NOT a gap
            n = seg(1, log, s); self.wm.archive_segment(self.mk(n), n)
        self.assertTrue(self.wm.verify_continuity(max_age=0)["continuous"])
        n = seg(1, 1, 5); self.wm.archive_segment(self.mk(n), n)          # real gap (2..4 missing)
        rep = self.wm.verify_continuity(max_age=0)
        self.assertFalse(rep["continuous"]); self.assertEqual(rep["gaps"][0]["count"], 3)
        self.assertEqual(rep["gaps"][0]["missing_from"], seg(1, 1, 2))

    def test_backup_label_and_partial_files_are_not_segments(self):
        n = seg(2, 0, 1); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, n + ".00000028.backup"), "w").write("x")
        open(os.path.join(self.wm.wal_dir, seg(2, 0, 7) + ".partial"), "w").write("x")
        rep = self.wm.verify_continuity(max_age=0)
        self.assertEqual(rep["total_segments"], 1); self.assertTrue(rep["continuous"])

    def test_per_timeline_contiguity(self):
        for tl, s in [(1, 1), (1, 2), (2, 2), (2, 3)]:                     # timeline 2 forks at segment 2: no gap across timelines
            n = seg(tl, 0, s); self.wm.archive_segment(self.mk(n), n)
        self.assertTrue(self.wm.verify_continuity(max_age=0)["continuous"])

    def test_failover_hole_between_timelines_is_a_gap(self):
        """the old primary died before archiving its last segment and the promoted standby never archives what it only received: nothing covers segment 3"""
        for tl, s in [(1, 1), (1, 2), (2, 4), (2, 5)]:                      # timeline 1 forked exactly at the start of segment 4 (0/400000 with 1 MB segments)
            n = seg(tl, 0, s); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, "00000002.history"), "w").write("1\t0/400000\tno recovery target specified\n")
        rep = self.wm.verify_continuity(max_age=0)
        self.assertFalse(rep["continuous"], rep)
        g = rep["gaps"][0]
        self.assertEqual((g["timeline"], g["missing_from"], g["count"]), (1, seg(1, 0, 3), 1), rep)
        n = seg(1, 0, 3); self.wm.archive_segment(self.mk(n), n)            # the segment is rescued: hole closed
        self.assertTrue(self.wm.verify_continuity(max_age=0)["continuous"])

    def test_fork_inside_a_segment_is_covered_by_the_new_timeline(self):
        for tl, s in [(1, 1), (2, 2), (2, 3)]:                              # fork mid-segment 2: only the NEW timeline has a complete copy of segment 2
            n = seg(tl, 0, s); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, "00000002.history"), "w").write("1\t0/280000\tno recovery target specified\n")
        self.assertTrue(self.wm.verify_continuity(max_age=0)["continuous"])

    def test_three_timelines_chain(self):
        for tl, s in [(1, 1), (1, 2), (2, 2), (2, 3), (3, 3), (3, 4)]:
            n = seg(tl, 0, s); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, "00000003.history"), "w").write("1\t0/200000\tx\n2\t0/380000\ty\n")
        self.assertTrue(self.wm.verify_continuity(max_age=0)["continuous"])


if __name__ == "__main__": unittest.main()
