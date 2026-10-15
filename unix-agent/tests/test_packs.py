"""Pack files (repository format 2): writing, sealing, indexing, dedup across processes, crash leftovers, garbage collection and
repacking, format-1 files still readable. No PostgreSQL needed."""
import os
import shutil
import tempfile
import time
import unittest

from pg_arca.engine import packs
from pg_arca.engine.repo import GC_GRACE, Repo
from pg_arca.engine.util import EngineError, chunk_hash, compress


def _age(path, seconds):
    t = time.time() - seconds
    os.utime(path, (t, t))


class PackTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="pgarca-packs-")
        self.root = os.path.join(self.d, "repo")
        self.repo = Repo(self.root, "main", algo="zlib")
        self.repo.init()

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _data(self, i, size=3000):
        return (b"%08d" % i) * (size // 8 + 1)

    # ---- basics
    def test_roundtrip_dedup_and_index_survive_a_new_process(self):
        r = self.repo
        hs = []
        for i in range(500):
            h, w, dedup = r.put_chunk(self._data(i))
            self.assertFalse(dedup)
            self.assertGreater(w, 0)
            hs.append(h)
        self.assertTrue(r.put_chunk(self._data(7))[2], "same content again: deduplicated before the pack is sealed")
        self.assertEqual(r.get_chunk(hs[3]), self._data(3), "readable while the pack is still open")
        self.assertFalse(os.path.exists(os.path.join(self.root, "cas", "packs", "x")), "no per-chunk files")
        self.assertFalse(any(len(n) == 2 for n in os.listdir(os.path.join(self.root, "cas"))), "format 2 writes no aa/bb directories")
        r.flush()
        files = os.listdir(os.path.join(self.root, "cas", "packs"))
        self.assertEqual(sorted(f.rsplit(".", 1)[1] for f in files), ["idx", "pack"], files)
        # another process (a fresh Repo): everything is found through the index, nothing is rewritten
        r2 = Repo(self.root, "main", algo="zlib")
        r2.init()
        for i, h in enumerate(hs):
            self.assertEqual(r2.get_chunk(h), self._data(i))
        self.assertTrue(r2.put_chunk(self._data(42))[2])
        self.assertEqual(r2.cas_stats()["chunks"], 500)
        self.assertEqual(r2.cas_stats()["packs"], 1)
        self.assertEqual(r2.index().find(bytes.fromhex(hs[0]))[1] % 1, 0)
        import json
        self.assertEqual(json.load(open(os.path.join(self.root, "repo.json")))["format"], 2)

    def test_pack_rolls_over_at_pack_max(self):
        old = packs.PACK_MAX
        packs.PACK_MAX = 20000
        try:
            for i in range(40):
                self.repo.put_chunk(os.urandom(2000))             # incompressible: ~2 KB per record, a new pack every ~10 chunks
            self.repo.flush()
            n = len([f for f in os.listdir(os.path.join(self.root, "cas", "packs")) if f.endswith(".pack")])
            self.assertGreaterEqual(n, 3, n)
            self.assertEqual(self.repo.cas_stats()["chunks"], 40)
        finally:
            packs.PACK_MAX = old

    def test_threads_write_their_own_packs_and_everything_is_found(self):
        import threading
        hs = {}
        lock = threading.Lock()

        def work(k):
            for i in range(200):
                data = self._data(k * 1000 + i)
                h = self.repo.put_chunk(data)[0]
                with lock:
                    hs[h] = data
        ts = [threading.Thread(target=work, args=(k,)) for k in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.repo.flush()
        self.assertEqual(len([f for f in os.listdir(os.path.join(self.root, "cas", "packs")) if f.endswith(".pack")]), 4)
        r2 = Repo(self.root, "main", algo="zlib")
        for h, data in hs.items():
            self.assertEqual(r2.get_chunk(h), data)

    def test_fold_keeps_lookups_right(self):
        old = packs.FOLD_AT
        packs.FOLD_AT = 50
        try:
            hs = [self.repo.put_chunk(self._data(i))[0] for i in range(170)]
            self.assertLess(len(self.repo.index().recent), 50)
            for i, h in enumerate(hs):
                self.assertTrue(self.repo.put_chunk(self._data(i))[2], "chunk %d found after the fold" % i)
            self.repo.flush()
            self.assertEqual(self.repo.get_chunk(hs[160]), self._data(160))
        finally:
            packs.FOLD_AT = old

    # ---- durability / crash
    def test_unsealed_pack_of_a_crashed_process_is_invisible_and_collected(self):
        self.repo.put_chunk(self._data(1))
        w = self.repo._tl.writer
        w.f.flush()                                                  # the process "dies": the .pack.open stays, no index
        openp = w.open_path
        self.assertTrue(os.path.exists(openp))
        r2 = Repo(self.root, "main", algo="zlib")
        self.assertEqual(r2.cas_stats()["chunks"], 0)
        self.assertFalse(r2.put_chunk(self._data(1))[2], "not deduplicated against an unsealed pack")
        r2.flush()
        from pg_arca.engine.maintenance import _gc_cas
        _gc_cas(r2)
        self.assertTrue(os.path.exists(openp), "younger than the grace period: kept")
        _age(openp, GC_GRACE + 10)
        _gc_cas(r2)
        self.assertFalse(os.path.exists(openp), "orphan removed after the grace period")

    def test_sealed_pack_without_index_is_reindexed_by_gc(self):
        hs = [self.repo.put_chunk(self._data(i))[0] for i in range(20)]
        self.repo.flush()
        pack = [f for f in os.listdir(os.path.join(self.root, "cas", "packs")) if f.endswith(".pack")][0]
        os.remove(os.path.join(self.root, "cas", "packs", pack[:-5] + ".idx"))
        r2 = Repo(self.root, "main", algo="zlib")
        self.assertIsNone(r2.locate(hs[0]))
        _age(os.path.join(self.root, "cas", "packs", pack), GC_GRACE + 10)
        from pg_arca.engine.maintenance import _gc_cas
        _gc_cas(r2)
        r2.reload_index()
        self.assertEqual(r2.get_chunk(hs[5]), self._data(5))

    def test_broken_writer_is_aborted_and_forgotten(self):
        h1 = self.repo.put_chunk(self._data(1))[0]
        w = self.repo._tl.writer
        w.f.close()                                                  # the next write fails (as a full disk would)
        with self.assertRaises(ValueError):
            self.repo.put_chunk(self._data(2))
        self.assertTrue(w.broken)
        self.repo.flush()
        self.assertFalse(os.path.exists(w.open_path))
        self.assertFalse(os.path.exists(w.final))
        self.assertIsNone(self.repo.locate(h1), "chunks of the aborted pack are not offered for dedup")
        h1b, _, dedup = self.repo.put_chunk(self._data(1))
        self.assertEqual(h1b, h1)
        self.assertFalse(dedup, "written again into a new pack")
        self.repo.flush()
        self.assertEqual(self.repo.get_chunk(h1), self._data(1))

    # ---- garbage collection
    def _manifest_set(self, hashes, sid="20260101-000000F"):
        """A COMPLETE set whose manifest references `hashes`."""
        sd = self.repo.own_path("backup", sid)
        os.makedirs(sd, exist_ok=True)
        man = {"set": sid, "files": {"base/1/%d" % i: {"size": 1, "chunks": [[0, 1, h]]} for i, h in enumerate(hashes)}}
        self.repo.write_zjson(os.path.join(sd, "manifest.json.z"), man, sid + "/manifest")
        self.repo.write_meta({"id": sid, "status": "COMPLETE", "type": "full", "start_time": "2026-01-01T00:00:00Z"})

    def test_gc_deletes_dead_packs_and_repacks_mostly_dead_ones(self):
        from pg_arca.engine.maintenance import _gc_cas
        old = packs.PACK_MAX
        packs.PACK_MAX = 40000
        try:
            live, dead = [], []
            for i in range(60):
                h = self.repo.put_chunk(self._data(i))[0]
                (live if i % 3 == 0 else dead).append(h)       # one live chunk out of three: every pack is mostly dead
            self.repo.flush()
            gone = [self.repo.put_chunk(self._data(1000 + i))[0] for i in range(10)]   # a pack referenced by nobody
            self.repo.flush()
            self._manifest_set(live)
            pd = os.path.join(self.root, "cas", "packs")
            before = sorted(f for f in os.listdir(pd) if f.endswith(".pack"))
            freed, removed = _gc_cas(self.repo)
            self.assertEqual((freed, removed), (0, 0), "every pack is younger than the grace period: untouched")
            for f in before:
                _age(os.path.join(pd, f), GC_GRACE + 10)
            freed, removed = _gc_cas(self.repo)
            self.assertGreater(freed, 0)
            self.assertEqual(removed, len(dead) + len(gone))
            after = sorted(f for f in os.listdir(pd) if f.endswith(".pack"))
            self.assertTrue(all(f not in before for f in after), "mostly-dead packs were rewritten into new ones")
            self.assertEqual(self.repo.cas_stats()["chunks"], len(live))
            for i, h in enumerate(live):
                self.assertEqual(self.repo.get_chunk(h), self._data(i * 3))
            for h in dead + gone:
                self.assertIsNone(self.repo.locate(h))
            self.assertEqual(_gc_cas(self.repo), (0, 0), "nothing left to collect")
        finally:
            packs.PACK_MAX = old

    def test_gc_keeps_a_pack_whose_dead_share_is_small(self):
        from pg_arca.engine.maintenance import _gc_cas, REPACK_FRACTION
        hs = [self.repo.put_chunk(self._data(i))[0] for i in range(100)]
        self.repo.flush()
        self._manifest_set(hs[:-2])                                 # 2 % dead: not worth a rewrite
        pd = os.path.join(self.root, "cas", "packs")
        for f in os.listdir(pd):
            _age(os.path.join(pd, f), GC_GRACE + 10)
        self.assertLess(0.02, REPACK_FRACTION)
        self.assertEqual(_gc_cas(self.repo), (0, 0))
        self.assertEqual(self.repo.get_chunk(hs[-1]), self._data(99))

    def test_dedup_against_an_old_pack_refreshes_its_mtime(self):
        h = self.repo.put_chunk(self._data(1))[0]
        self.repo.flush()
        p = self.repo.locate(h)[0]
        _age(p, GC_GRACE + 10)
        r2 = Repo(self.root, "main", algo="zlib")
        self.assertTrue(r2.put_chunk(self._data(1))[2])
        self.assertLess(time.time() - os.stat(p).st_mtime, 60, "a running backup reuses it: the GC grace must cover the pack again")

    def test_reader_with_a_stale_index_recovers_after_a_repack(self):
        from pg_arca.engine.maintenance import _gc_cas
        hs = [self.repo.put_chunk(self._data(i))[0] for i in range(40)]
        self.repo.flush()
        self._manifest_set(hs[:10])
        pd = os.path.join(self.root, "cas", "packs")
        for f in os.listdir(pd):
            _age(os.path.join(pd, f), GC_GRACE + 10)
        reader = Repo(self.root, "main", algo="zlib")
        self.assertEqual(reader.get_chunk(hs[1]), self._data(1))     # index loaded, pack file open
        _gc_cas(self.repo)                                           # another process rewrote the pack
        self.assertEqual(reader.get_chunk(hs[2]), self._data(2), "the open file descriptor still reads the unlinked (immutable) pack")
        reader._reader().close()                                     # no descriptor any more: the old path is gone
        self.assertEqual(reader.get_chunk(hs[3]), self._data(3), "ENOENT on the old pack -> index reloaded -> found in the new one")
        with self.assertRaises(EngineError) as cm:
            reader.get_chunk(hs[30])
        self.assertEqual(cm.exception.code, "PGA-REPO-014")

    # ---- format 1 compatibility
    def test_format1_files_are_read_deduplicated_and_collected(self):
        from pg_arca.engine.maintenance import _gc_cas
        import json
        data = self._data(1)
        h = chunk_hash(data)
        p = self.repo.cas_path(h)
        os.makedirs(os.path.dirname(p))
        with open(p, "wb") as f:
            f.write(compress(data, "zlib", 3))
        rj = os.path.join(self.root, "repo.json")
        meta = json.load(open(rj))
        meta["format"] = 1
        json.dump(meta, open(rj, "w"))
        r = Repo(self.root, "main", algo="zlib")
        r.init()
        self.assertEqual(json.load(open(rj))["format"], 2, "upgraded in place")
        self.assertTrue(r.has_legacy_chunks())
        self.assertEqual(r.get_chunk(h), data)
        self.assertTrue(r.put_chunk(data)[2], "deduplicated against the file")
        self.assertEqual(r.locate(h), (p, 0, os.path.getsize(p)))
        h2 = r.put_chunk(self._data(2))[0]
        r.flush()
        self.assertTrue(r.locate(h2)[0].endswith(".pack"), "new chunks go to packs")
        self.assertEqual(r.cas_stats(), {"chunks": 2, "stored_bytes": os.path.getsize(p) + os.path.getsize(r.locate(h2)[0]), "packs": 1, "files": 1})
        self._manifest_set([h2])
        _age(p, GC_GRACE + 10)
        _gc_cas(r)
        self.assertFalse(os.path.exists(p), "unreferenced format-1 file removed after the grace period")

    def test_index_from_a_previous_location(self):
        h = self.repo.put_chunk(self._data(1))[0]
        self.repo.flush()
        new = os.path.join(self.d, "new")
        r = Repo(new, "main", algo="zlib", previous=[self.root])
        r.init()
        self.assertEqual(r.get_chunk(h), self._data(1))
        self.assertTrue(r.locate(h)[0].startswith(self.root))
        self.assertFalse(r.put_chunk(self._data(1))[2], "a previous location is read-only: never a dedup target (the new location gets its own copy)")

    def test_get_chunks_reads_adjacent_chunks_in_one_call(self):
        datas = [self._data(i) for i in range(300)]
        hs = [self.repo.put_chunk(x)[0] for x in datas]
        self.repo.flush()
        r2 = Repo(self.root, "main", algo="zlib")
        calls = []
        rd = r2._reader()
        orig = rd.read
        rd.read = lambda p, o, l: (calls.append(l), orig(p, o, l))[1]
        got = r2.get_chunks(hs)
        self.assertTrue(all(got[h] == x for h, x in zip(hs, datas)))
        self.assertEqual(len(calls), 1, "one read for a run of adjacent chunks")
        calls[:] = []
        got = r2.get_chunks([hs[5], hs[6], hs[100], hs[7]])              # two runs and a lone chunk
        self.assertEqual([got[h] for h in (hs[5], hs[6], hs[100], hs[7])], [datas[5], datas[6], datas[100], datas[7]])
        self.assertEqual(len(calls), 3)
        with self.assertRaises(EngineError):
            r2.get_chunks([hs[1], "00" * 32])

    def test_index_cache_is_used_and_rebuilt_when_packs_change(self):
        old = packs.PACK_MAX
        packs.PACK_MAX = 20000
        try:
            hs = [self.repo.put_chunk(os.urandom(2000))[0] for i in range(60)]
            self.repo.flush()
            pd = os.path.join(self.root, "cas", "packs")
            self.assertFalse(os.path.exists(os.path.join(pd, packs.CACHE_NAME)))
            r2 = Repo(self.root, "main", algo="zlib")
            self.assertIsNotNone(r2.locate(hs[0]))
            import json
            meta = json.load(open(os.path.join(pd, packs.CACHE_NAME + ".json")))
            self.assertEqual(len(meta["packs"]), len([f for f in os.listdir(pd) if f.endswith(".idx")]), "cache covers every pack")
            self.assertEqual(meta["count"], 60)
            r3 = Repo(self.root, "main", algo="zlib")                   # loads from the cache
            for h in hs:
                self.assertIsNotNone(r3.locate(h))
            # a pack disappears (GC): the cache is stale and ignored, the index is rebuilt and the cache rewritten without that pack
            victim = r3.locate(hs[0])[0]
            os.remove(victim)
            os.remove(victim[:-5] + ".idx")
            r4 = Repo(self.root, "main", algo="zlib")
            self.assertIsNone(r4.locate(hs[0]))
            self.assertTrue(all(r4.locate(h) is not None for h in hs if r3.locate(h)[0] != victim))
            meta = json.load(open(os.path.join(pd, packs.CACHE_NAME + ".json")))
            self.assertNotIn(os.path.basename(victim)[:-5] + ".idx", meta["packs"])
            # new packs after the cache: merged in and the cache refreshed
            h_new = r4.put_chunk(os.urandom(2000))[0]
            r4.flush()
            r5 = Repo(self.root, "main", algo="zlib")
            self.assertIsNotNone(r5.locate(h_new))
            self.assertIn(os.path.basename(r5.locate(h_new)[0])[:-5] + ".idx", json.load(open(os.path.join(pd, packs.CACHE_NAME + ".json")))["packs"])
        finally:
            packs.PACK_MAX = old

    # ---- low level
    def test_scan_pack_matches_the_index_and_stops_at_a_torn_record(self):
        hs = [self.repo.put_chunk(self._data(i))[0] for i in range(10)]
        self.repo.flush()
        p, _, _ = self.repo.locate(hs[0])
        idx = packs.read_idx(p[:-5] + ".idx")
        scanned = sorted(packs.scan_pack(p))
        self.assertEqual(scanned, sorted(idx))
        with open(p, "ab") as f:
            f.write(packs.REC_HDR.pack(b"\x01" * 32, 5000) + b"short")     # a record cut by a crash
        self.assertEqual(sorted(packs.scan_pack(p)), sorted(idx))
        with self.assertRaises(EngineError):
            packs.read_idx(p)                                            # not an index


if __name__ == "__main__":
    unittest.main()
