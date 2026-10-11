import os, sys, tempfile, time, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.wal_manager import WalManager
from pg_arca import wal_archive, walprefetch

MB = 1 << 20


def seg(s, tl=1, log=0): return "%08X%08X%08X" % (tl, log, s)


class Prefetch(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.wm = WalManager(os.path.join(self.t, "wal"), compression="zstd", segment_size=MB)
        src = os.path.join(self.t, "src"); os.makedirs(src)
        for i in range(1, 9):
            p = os.path.join(src, seg(i))
            with open(p, "wb") as f: f.write(bytes([i]) * MB)
            self.wm.archive_segment(p, seg(i))
        self.spool = os.path.join(self.t, "spool")
        self.env = dict(os.environ)
        os.environ.update({"WAL_ARCHIVE_DIR": self.wm.wal_dir, "PG_ARCA_SPOOL": self.spool, "PG_ARCA_PREFETCH": "4", "PG_ARCA_CONF": "/nonexistent"})
        os.environ.pop("PG_ARCA_KEY_FILE", None)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.spool, ignore_errors=True)       # what the engine does when the recovery is over: the prefetcher notices and leaves
        time.sleep(0.2)
        os.environ.clear(); os.environ.update(self.env)
        shutil.rmtree(self.t, ignore_errors=True)

    def get(self, i):
        out = os.path.join(self.t, "o", "RECOVERYXLOG")
        rc = wal_archive.main(["x", "get", seg(i), out])
        return rc, (open(out, "rb").read() if rc == 0 else None)

    def wait_spool(self, names, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            if all(os.path.exists(os.path.join(self.spool, n)) for n in names):
                return True
            time.sleep(0.05)
        return False

    def test_read_ahead_serves_next_segments_and_moves_them(self):
        rc, data = self.get(1)                                     # cold: served synchronously, and it starts the read-ahead
        self.assertEqual((rc, data), (0, bytes([1]) * MB))
        self.assertTrue(self.wait_spool([seg(2), seg(3), seg(4), seg(5)]), os.listdir(self.spool))
        self.assertFalse(os.path.exists(os.path.join(self.spool, seg(6))), "never more than `ahead` segments")
        rc, data = self.get(2)
        self.assertEqual((rc, data), (0, bytes([2]) * MB))        # from the spool, content intact
        self.assertFalse(os.path.exists(os.path.join(self.spool, seg(2))), "a served segment leaves the spool (PostgreSQL recycles restored files)")
        self.assertTrue(self.wait_spool([seg(6)]), "the window moves with the recovery")
        for i in (3, 4, 5, 6):
            self.assertEqual(self.get(i)[1], bytes([i]) * MB)

    def test_missing_segment_is_still_not_found_and_off_switch(self):
        self.assertEqual(self.get(40)[0], 1)                       # genuinely absent: exit 1 = end of archive, with the spool on
        os.environ.pop("PG_ARCA_SPOOL")
        self.assertEqual(self.get(1)[1], bytes([1]) * MB)           # no spool: the plain path
        self.assertFalse(os.path.exists(self.spool))

    def test_no_writable_spool_degrades_to_plain(self):
        os.environ["PG_ARCA_SPOOL"] = "/proc/nope/spool"
        self.assertEqual(self.get(3)[1], bytes([3]) * MB)

    def test_next_names_stays_on_the_timeline(self):
        names = [seg(1), seg(2), seg(3, tl=2), seg(4, tl=2)]
        self.assertEqual(walprefetch._next_names(names, seg(1), 5), [seg(2)])
        self.assertEqual(walprefetch._next_names(names, seg(3, tl=2), 5), [seg(4, tl=2)])


if __name__ == "__main__":
    unittest.main()
