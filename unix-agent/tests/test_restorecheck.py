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
        plan = {"extract_bytes": 10}
        c = restorecheck.check(FakeCtx(self.d, self.d), plan, None, need_dest=1 << 60)
        self.assertEqual([x for x in c if x["id"] == "space"][0]["level"], "bad")
        self.assertEqual(sorted(plan["space"][0]["roles"]), ["data", "scratch"])          # same filesystem: ONE volume, the needs add up
        c = restorecheck.check(FakeCtx(self.d, self.d), {"extract_bytes": 10}, None, need_dest=1 << 60, into={"host": "other"})
        self.assertEqual([x for x in c if x["id"] == "dest_space"][0]["level"], "warn")       # another cluster: cannot be measured from here

    def test_taken_name_keeps_its_code(self):
        c = restorecheck.check(FakeCtx(self.d, self.d), {"extract_bytes": 10}, None, name_taken="x_restored")
        with self.assertRaises(EngineError) as cm:
            restorecheck.enforce(c)
        self.assertEqual(cm.exception.code, "PGA-SEC-030")
        self.assertFalse(restorecheck.summarize(c)["ok"])


class Volumes(unittest.TestCase):
    """scratch and live data on the same filesystem: each need alone fits, together they do not -> blocker (two separate checks would have said ok twice)."""
    def test_needs_add_up_on_a_shared_volume(self):
        d = tempfile.mkdtemp()
        st = os.statvfs(d); free = st.f_bavail * st.f_frsize; total = st.f_blocks * st.f_frsize
        each = int(free * 0.6)
        vols = restorecheck.volumes([("scratch", os.path.join(d, "s"), each), ("data", os.path.join(d, "pg"), each)])
        self.assertEqual(len(vols), 1)
        out = []
        restorecheck.space_checks(vols, lambda cid, level, text, fix=None, **kw: out.append((cid, level)))
        self.assertEqual(out, [("space", "bad")])
        vols = restorecheck.volumes([("scratch", d, 1 << 20), ("data", d, 1 << 20)])
        out = []
        restorecheck.space_checks(vols, lambda cid, level, text, fix=None, **kw: out.append((cid, level)))
        self.assertEqual(out[0][0], "space")
        self.assertIn(out[0][1], ("ok", "warn") if free - (2 << 20) > max(0.05 * total, 1 << 30) else ("bad",))


if __name__ == "__main__":
    unittest.main()
