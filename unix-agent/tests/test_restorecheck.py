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
        G = 1 << 30                                                                             # ... unless the console sends what its agent reports
        c = restorecheck.check(FakeCtx(self.d, self.d), {"extract_bytes": 10}, None, need_dest=10 * G, into={"host": "other", "disk": {"free_bytes": 8 * G, "total_bytes": 100 * G}})
        self.assertEqual([x for x in c if x["id"] == "dest_space"][0]["level"], "bad")
        c = restorecheck.check(FakeCtx(self.d, self.d), {"extract_bytes": 10}, None, need_dest=10 * G, into={"host": "other", "disk": {"free_bytes": 80 * G, "total_bytes": 100 * G}})
        self.assertEqual([x for x in c if x["id"] == "dest_space"][0]["level"], "ok")

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


    def test_overlay_and_volume_of_the_same_disk_count_as_one(self):
        """Containers: the scratch (overlay) and the data (a volume) have different st_dev but the same disk below: needs must still add up."""
        from unittest import mock
        class St(object):
            f_frsize = 4096; f_blocks = 25 * 2 ** 18; f_bavail = 10 * 2 ** 18          # 100 GiB disk, 40 GiB free
        devs = {"/scr": 1, "/data": 2}
        real_stat = os.stat
        with mock.patch.object(restorecheck, "_existing", lambda p: p), mock.patch("os.statvfs", lambda p: St()), \
                mock.patch("os.stat", lambda p, *a, **k: type("S", (), {"st_dev": devs[p]})() if p in devs else real_stat(p, *a, **k)):
            vols = restorecheck.volumes([("scratch", "/scr", 25 << 30), ("data", "/data", 20 << 30)])
        self.assertEqual(len(vols), 1)
        self.assertEqual(vols[0]["need"], 45 << 30)



class Access(unittest.TestCase):
    """The lab case: restore_instance to /srv/restore_big failed with a bare 'internal error: [Errno 13]' halfway in; now a blocker with the fix, before anything."""
    def test_destination_not_creatable_is_a_blocker_with_the_command(self):
        from unittest import mock
        d = tempfile.mkdtemp()
        with mock.patch("os.access", lambda p, m: False):
            c = restorecheck.access_check(os.path.join(d, "restore_big"))
        self.assertEqual((c["level"], c["code"]), ("bad", "PGA-RST-033"))
        self.assertIn("mkdir -p %s" % os.path.join(d, "restore_big"), c["fix"])
        with self.assertRaises(Exception) as cm:
            restorecheck.enforce([c])
        self.assertIn("PGA-RST-033", str(getattr(cm.exception, "code", "")) + str(cm.exception))

    def test_writable_is_fine(self):
        self.assertIsNone(restorecheck.access_check(os.path.join(tempfile.mkdtemp(), "x", "y")))


if __name__ == "__main__":
    unittest.main()
