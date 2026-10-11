import os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.engine import restorecheck
from pg_arca.engine.util import EngineError


class FakeRepo(object):
    def __init__(self, d): self.d, self.path = d, d
    def cas_path(self, h): return os.path.join(self.d, h)


class FakeCtx(object):
    seg_size = 16 << 20
    eph = {}
    def __init__(self, d, pgdata):
        self.repo, self.pgdata, self.scratch_dir, self.wal_dir, self.conn = FakeRepo(d), pgdata, d, d, None
    def log(self, *a): pass


class T(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        for h in ("aa" * 8, "bb" * 8):
            open(os.path.join(self.d, h), "wb").write(b"x")
        self.merged = {"base/1/1": {"size": 3, "chunks": {0: (1, "aa" * 8), 1: (1, "bb" * 8)}}, "base/1/2": {"size": 1, "chunks": {0: (1, "cc" * 8)}}}

    def test_missing_chunk_is_a_blocker(self):
        checked, miss, ex, sampled = restorecheck.missing_chunks(FakeRepo(self.d), self.merged)
        self.assertEqual((checked, miss, ex, sampled), (3, 1, ["cc" * 8], False))
        c = restorecheck.check(FakeCtx(self.d, self.d), {"extract_bytes": 10}, self.merged)
        ch = [x for x in c if x["id"] == "chunks"][0]
        self.assertEqual(ch["level"], "bad")
        with self.assertRaises(EngineError) as cm:
            restorecheck.enforce(c)
        self.assertEqual(cm.exception.code, "PGA-RST-031")

    def test_complete_chain_passes(self):
        open(os.path.join(self.d, "cc" * 8), "wb").write(b"x")
        c = restorecheck.check(FakeCtx(self.d, self.d), {"extract_bytes": 10}, self.merged)
        self.assertEqual([x for x in c if x["id"] == "chunks"][0]["level"], "ok")

    def test_destination_volume_too_small(self):
        c = restorecheck.check(FakeCtx(self.d, self.d), {"extract_bytes": 10}, None, need_dest=1 << 60)
        self.assertEqual([x for x in c if x["id"] == "dest_space"][0]["level"], "bad")
        c = restorecheck.check(FakeCtx(self.d, self.d), {"extract_bytes": 10}, None, need_dest=1 << 60, into={"host": "other"})
        self.assertEqual([x for x in c if x["id"] == "dest_space"][0]["level"], "warn")       # another cluster: cannot be measured from here

    def test_taken_name_keeps_its_code(self):
        c = restorecheck.check(FakeCtx(self.d, self.d), {"extract_bytes": 10}, None, name_taken="x_restored")
        with self.assertRaises(EngineError) as cm:
            restorecheck.enforce(c)
        self.assertEqual(cm.exception.code, "PGA-SEC-030")
        self.assertFalse(restorecheck.summarize(c)["ok"])


if __name__ == "__main__":
    unittest.main()
