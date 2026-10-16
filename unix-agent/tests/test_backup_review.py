"""Backup engine review (independent, 16/10 night), without PostgreSQL: holes in the WAL since a chain's full, a changed checksum setting, orphan
incrementals left by an interrupted expire, tablespaces that cannot be seen, segments of a truncated relation in the WAL summaries, pack ids of two
hosts with the same short name, an index cache paired with another writer's list, zero chunks in an incremental."""
import errno
import os
import shutil
import struct
import tempfile
import time
import unittest

from pg_arca.engine import packs as P
from pg_arca.engine import walsummary as ws
from pg_arca.engine.backup import _base_differs, _chain_wal_holes, backup_file
from pg_arca.engine.maintenance import expire
from pg_arca.engine.pgdata import _walk_error, walk_pgdata
from pg_arca.engine.repo import Repo
from pg_arca.engine.util import BLCKSZ, CHUNK_SIZE, EngineError, wal_name, write_json

SEG = 16 * 1024 * 1024


class W(object):
    def __init__(self, names):
        self.names = names

    def list_segments(self, anywhere=False):
        return sorted(self.names)


class C(object):
    pass


class WalHoles(unittest.TestCase):
    def test_hole_after_the_full_is_found(self):
        ctx = C()
        ctx.wal = W([wal_name(1, n, SEG) for n in (2, 3, 4, 6, 7)])
        chain = [{"start_lsn": "0/2000028", "stop_lsn": "0/3000100", "timeline": 1, "wal_segment_size": SEG}]
        self.assertEqual(_chain_wal_holes(ctx, chain), [wal_name(1, 5, SEG)])
        self.assertEqual(_chain_wal_holes(ctx, chain, upto=4), [], "up to the set's own end")
        ctx.wal = W([])
        self.assertEqual(_chain_wal_holes(ctx, chain), [], "an archive that lists nothing is not a proof of a hole")
        ctx.wal = W([wal_name(1, n, SEG) for n in range(2, 9)] + [wal_name(2, 5, SEG)])
        self.assertEqual(_chain_wal_holes(ctx, chain), [])


class BaseDiffers(unittest.TestCase):
    def test_checksums_and_segment_size(self):
        d = tempfile.mkdtemp()
        try:
            repo = Repo(os.path.join(d, "r"), "main", algo="zlib")
            repo.init()
            os.makedirs(repo.own_path("backup", "F1"))
            write_json(os.path.join(repo.own_path("backup", "F1"), "meta.json"), {"id": "F1", "type": "full", "parent": None, "status": "COMPLETE", "data_checksums": True, "wal_segment_size": SEG})
            cand = repo.set_meta("F1")
            self.assertFalse(_base_differs(repo, cand, True, SEG))
            self.assertTrue(_base_differs(repo, cand, False, SEG), "pg_checksums --disable since the full")
            self.assertTrue(_base_differs(repo, cand, True, 64 * 1024 * 1024))
            cand.pop("data_checksums")
            repo.write_meta(cand)
            self.assertFalse(_base_differs(repo, repo.set_meta("F1"), False, SEG), "an old set that did not record it: not a reason")
        finally:
            shutil.rmtree(d)


class OrphanIncrementals(unittest.TestCase):
    def test_an_interrupted_expire_does_not_pin_the_wal_forever(self):
        d = tempfile.mkdtemp()
        try:
            repo = Repo(os.path.join(d, "r"), "main", algo="zlib")
            repo.init()

            def put(sid, typ, status, lsn, parent=None, age=0):
                os.makedirs(repo.own_path("backup", sid))
                ts = time.time() - age
                write_json(os.path.join(repo.own_path("backup", sid), "meta.json"), {"id": sid, "type": typ, "parent": parent, "status": status, "started_ts": ts,
                                                                                    "start_lsn": lsn, "stop_lsn": lsn, "timeline": 1, "wal_segment_size": SEG})
            put("20251001-000000F", "full", "EXPIRING", "0/9000000", age=8 * 86400)          # the crash came after this mark
            put("20251001-000000F_20251002-000000I", "incr", "COMPLETE", "0/A000000", parent="20251001-000000F", age=7 * 86400)
            put("20251008-000000F", "full", "COMPLETE", "1/0", age=3600)
            ctx = C()
            ctx.repo, ctx.retention_full, ctx.retention_days, ctx.seg_size, ctx.wal = repo, 1, 0, SEG, None
            plan = expire(ctx, dry_run=True)
            self.assertIn("20251001-000000F_20251002-000000I", plan["delete_sets"])
            self.assertEqual(plan["keep_sets"], ["20251008-000000F"])
            self.assertEqual(plan["wal_keep_from_lsn"], "1/00000000", "the orphan no longer holds the floor")
        finally:
            shutil.rmtree(d)


class Tablespaces(unittest.TestCase):
    def test_missing_or_unmounted_tablespace_fails(self):
        d = tempfile.mkdtemp()
        try:
            pgdata = os.path.join(d, "data")
            os.makedirs(os.path.join(pgdata, "pg_tblspc"))
            open(os.path.join(pgdata, "PG_VERSION"), "w").write("16\n")
            os.symlink(os.path.join(d, "nowhere"), os.path.join(pgdata, "pg_tblspc", "16500"))
            with self.assertRaises(EngineError) as e:
                list(walk_pgdata(pgdata))
            self.assertEqual(e.exception.code, "PGA-GEN-045")
            os.makedirs(os.path.join(d, "nowhere"))                    # the mount point without its filesystem
            with self.assertRaises(EngineError):
                list(walk_pgdata(pgdata))
            os.makedirs(os.path.join(d, "nowhere", "PG_16_202307071", "5"))
            open(os.path.join(d, "nowhere", "PG_16_202307071", "5", "20000"), "wb").write(b"\0" * 8192)
            rels = [r for r, _f, _s in walk_pgdata(pgdata)]
            self.assertIn("pg_tblspc/16500/PG_16_202307071/5/20000", rels)
        finally:
            shutil.rmtree(d)

    def test_walk_errors(self):
        self.assertIsNone(_walk_error(OSError(errno.ENOENT, "gone", "/x")), "a directory that vanished (dropped database)")
        for code in (errno.EACCES, errno.EIO, errno.ESTALE):
            with self.assertRaises(EngineError) as e:
                _walk_error(OSError(code, os.strerror(code), "/data/base/16384"))
            self.assertEqual(e.exception.code, "PGA-GEN-044")


class TruncatedRelation(unittest.TestCase):
    def test_segments_after_the_limit_block_are_read_whole(self):
        class S(object):
            version_num = 170000

            def scalar(self, sql):
                return "170000"

            def query(self, sql):
                return [["30000", "1663", "5", "0", "40", "t"],           # truncated at block 40
                        ["30000", "1663", "5", "0", "131080", "f"],       # then written in .1 and .2
                        ["30000", "1663", "5", "0", "262150", "f"]]
        ch = ws.changed_chunks(S(), 1, [(0, 100)], ["base/5/30000", "base/5/30000.1", "base/5/30000.2"], 131072)
        self.assertIs(ch["base/5/30000"], ws.ALL)
        self.assertIs(ch["base/5/30000.1"], ws.ALL)
        self.assertIs(ch["base/5/30000.2"], ws.ALL)

        class St(object):
            st_size = 1 << 30
        skip, _partial, full = ws.plan_files([(k, "/x", St()) for k in ch], ch, dict((k, {"size": 1 << 30}) for k in ch))
        self.assertEqual(skip, [])
        self.assertEqual(len(full), 3)


class Packs(unittest.TestCase):
    def test_pack_ids_differ_between_hosts_with_the_same_short_name(self):
        ids = set(P.new_pack_id() for _ in range(200))
        self.assertEqual(len(ids), 200)
        import re
        self.assertTrue(all(re.match(r"^\d{8}T\d{6}-[A-Za-z0-9_]+-\d+-\d+-[0-9a-f]{8}$", i) for i in ids), list(ids)[:2])

    def test_index_cache_of_another_writer_is_not_used(self):
        d = tempfile.mkdtemp()
        old = P.PACK_MAX
        P.PACK_MAX = 20000
        try:
            root = os.path.join(d, "r")
            repo = Repo(root, "main", algo="zlib")
            repo.init()
            hs = [repo.put_chunk(os.urandom(2000))[0] for i in range(40)]
            repo.flush()
            Repo(root, "main", algo="zlib").locate(hs[0])                # writes index.cache + .json
            pd = os.path.join(root, "cas", "packs")
            cache = os.path.join(pd, P.CACHE_NAME)
            self.assertTrue(os.path.exists(cache))
            blob = open(cache, "rb").read()
            # another writer's blob next to this .json: same length, other token -> never paired (it used to be accepted forever)
            open(cache, "wb").write(blob[:-32] + b"f" * 32)
            calls = []
            orig = P.read_idx
            P.read_idx = lambda path: (calls.append(path), orig(path))[1]
            try:
                r3 = Repo(root, "main", algo="zlib")
                for h in hs:
                    self.assertIsNotNone(r3.locate(h))
                self.assertTrue(calls, "the .idx files were read instead of the unpaired cache")
            finally:
                P.read_idx = orig
            for h in hs[:5]:
                self.assertEqual(r3.get_chunk(h), repo.get_chunk(h))
        finally:
            P.PACK_MAX = old
            shutil.rmtree(d)


class ZeroChunks(unittest.TestCase):
    def test_a_zeroed_range_is_kept_by_an_incremental(self):
        d = tempfile.mkdtemp()
        try:
            repo = Repo(os.path.join(d, "r"), "main", algo="zlib")
            repo.init()
            f = os.path.join(d, "16384")
            with open(f, "wb") as fh:
                fh.write(b"\0" * CHUNK_SIZE)
            e, _st = backup_file(repo, "base/5/16384", f, os.stat(f), 0x1000, True)
            self.assertEqual([c[0] for c in e["chunks"]], [0])
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
