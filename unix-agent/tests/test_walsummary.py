"""WAL-summary planning of incremental backups (PostgreSQL 17+), with a fake session: coverage of the LSN range, mapping of summary rows to
relation files and chunks, the unread / partial / full split, the sparse file read. The real thing runs in tests/test_wal_summary_pg.py on a
PostgreSQL 17+ (lab matrix)."""
import os
import shutil
import struct
import tempfile
import unittest

from pg_arca.engine import walsummary as ws
from pg_arca.engine.backup import backup_file_sparse, unread_entry
from pg_arca.engine.repo import Repo
from pg_arca.engine.util import BLCKSZ, CHUNK_SIZE


class FakeSession(object):
    def __init__(self, version_num=170000, summarize="on", ranges=(), contents=None):
        self.version_num = version_num
        self.version = "17.2"
        self.summarize = summarize
        self.ranges = list(ranges)
        self.contents = contents or {}
        self.calls = []

    def scalar(self, sql):
        self.calls.append(sql)
        if "summarize_wal" in sql:
            return self.summarize
        if "segment_size" in sql:
            return "131072"
        raise AssertionError(sql)

    def query(self, sql):
        self.calls.append(sql)
        if "pg_available_wal_summaries" in sql:
            return [["%X/%08X" % (s >> 32, s & 0xFFFFFFFF), "%X/%08X" % (e >> 32, e & 0xFFFFFFFF)] for s, e in self.ranges]
        if "pg_wal_summary_contents" in sql:
            key = sql.split("(")[1].split(")")[0].replace("'", "")
            return self.contents.get(key, [])
        raise AssertionError(sql)


def L(n):
    return "%X/%08X" % (n >> 32, n & 0xFFFFFFFF)


class Coverage(unittest.TestCase):
    def test_available(self):
        self.assertEqual(ws.available(FakeSession(160000))[0], False)
        self.assertEqual(ws.available(FakeSession(summarize="off"))[0], False)
        self.assertEqual(ws.available(FakeSession()), (True, ""))
        os.environ["PG_ARCA_WAL_SUMMARIES"] = "0"
        try:
            self.assertEqual(ws.available(FakeSession())[0], False)
        finally:
            del os.environ["PG_ARCA_WAL_SUMMARIES"]

    def test_contiguous_chain_covers_the_range(self):
        rows = [(0, 100), (100, 250), (250, 400), (400, 500)]
        self.assertEqual(ws._covering_chain(rows, 120, 300), [(100, 250), (250, 400)])
        self.assertIsNotNone(ws._covering_chain(rows, 100, 100), "empty range: any summary touching it")
        self.assertEqual(ws._covering_chain(rows, 0, 500), rows)
        self.assertIsNone(ws._covering_chain(rows, 120, 600), "summarizer behind")
        self.assertIsNone(ws._covering_chain([(100, 250), (300, 400)], 120, 350), "hole")
        self.assertIsNone(ws._covering_chain([(150, 250), (250, 400)], 120, 300), "range starts before the first summary (expired)")
        self.assertEqual(ws._covering_chain([(0, 100), (100, 250), (100, 250), (250, 400)], 50, 300), [(0, 100), (100, 250), (250, 400)], "duplicates ignored")

    def test_summaries_for_waits_then_gives_up(self):
        s = FakeSession(ranges=[(0, 100)])
        logs = []
        self.assertIsNone(ws.summaries_for(s, 1, L(50), L(200), wait=0, log=lambda lv, m: logs.append(m)))
        self.assertTrue(any("PGA-INC-011" in m for m in logs))
        s = FakeSession(ranges=[(0, 100), (100, 300)])
        self.assertEqual(ws.summaries_for(s, 1, L(50), L(200), wait=0), [(0, 100), (100, 300)])
        s = FakeSession(ranges=[(120, 300)])
        logs = []
        self.assertIsNone(ws.summaries_for(s, 1, L(50), L(200), wait=0, log=lambda lv, m: logs.append(m)))
        self.assertTrue(any("PGA-INC-012" in m for m in logs))


class Mapping(unittest.TestCase):
    def test_rows_become_files_and_chunk_indexes(self):
        key = "1, %s, %s" % (L(0), L(100))
        rows = [
            ["16384", "1663", "5", "0", "3", "f"],            # base/5/16384 block 3 -> chunk 0
            ["16384", "1663", "5", "0", "9", "f"],            # block 9 -> chunk 1
            ["16384", "1663", "5", "0", "131080", "f"],       # second segment, block 8 -> base/5/16384.1 chunk 1
            ["16384", "1663", "5", "1", "0", "f"],            # fsm fork: ignored (whole files)
            ["2601", "1664", "0", "0", "1", "f"],             # global/2601
            ["20000", "16500", "5", "0", "17", "f"],          # tablespace 16500 -> pg_tblspc/16500/PG_17_x/5/20000 chunk 2
            ["30000", "1663", "5", "0", "40", "t"],           # truncated relation -> ALL
            ["30000", "1663", "5", "0", "2", "f"],
            ["40000", "99999", "5", "0", "2", "f"],           # tablespace not in the walk (dropped): ignored
        ]
        s = FakeSession(contents={key: rows})
        files = ["base/5/16384", "base/5/16384.1", "pg_tblspc/16500/PG_17_202406281/5/20000", "base/5/30000", "base/5/30000.1", "global/2601"]
        ch = ws.changed_chunks(s, 1, [(0, 100)], files, 131072)
        self.assertEqual(ch["base/5/16384"], {0, 1})
        self.assertEqual(ch["base/5/16384.1"], {1})
        self.assertEqual(ch["global/2601"], {0})
        self.assertEqual(ch["pg_tblspc/16500/PG_17_202406281/5/20000"], {2})
        self.assertIs(ch["base/5/30000"], ws.ALL)
        self.assertNotIn("base/5/40000", ch)
        self.assertEqual(len(ch), 5)

    def test_plan_files(self):
        class St(object):
            def __init__(self, size):
                self.st_size = size
        files = [("base/5/1", "/x/1", St(100)), ("base/5/2", "/x/2", St(200)), ("base/5/3", "/x/3", St(300)), ("base/5/4", "/x/4", St(400)), ("base/5/5", "/x/5", St(500))]
        changes = {"base/5/2": {1}, "base/5/3": ws.ALL, "base/5/5": {0}}
        parent = {"base/5/1": {"size": 100}, "base/5/2": {"size": 200}, "base/5/3": {"size": 300}, "base/5/5": {"size": 123}}
        skip, partial, full = ws.plan_files(files, changes, parent)
        self.assertEqual(skip, ["base/5/1"])                             # unchanged, same size
        self.assertEqual(partial, {"base/5/2": {1}})
        self.assertEqual(sorted(full), ["base/5/3", "base/5/4", "base/5/5"])   # truncated, new, resized
        self.assertEqual(ws.sample([]), [])
        self.assertEqual(len(ws.sample(["a", "b"])), 2)
        self.assertEqual(len(ws.sample(["f%d" % i for i in range(10000)])), 50)


class Limiter(unittest.TestCase):
    def test_token_bucket_paces_reads_and_never_bursts_more_than_a_second(self):
        import time
        from pg_arca.engine.backup import ReadLimiter
        l = ReadLimiter(20)                                              # 20 MB/s
        t = time.time()
        for _ in range(40):
            l.take(1048576)                                              # 40 MB: one second of credit, then 1 s for the remaining 20 MB
        dt = time.time() - t
        self.assertTrue(0.8 <= dt <= 1.8, dt)
        self.assertEqual(l.total, 40 * 1048576)
        t = time.time()
        ReadLimiter(0).take(10 ** 9)
        self.assertLess(time.time() - t, 0.05, "0 = unlimited")


class SparseRead(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="pgarca-ws-")
        self.repo = Repo(os.path.join(self.d, "repo"), "main", algo="zlib")
        self.repo.init()

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _page(self, lsn):
        return struct.pack("<II", lsn >> 32, lsn & 0xFFFFFFFF) + b"\x00" * (BLCKSZ - 8)

    def test_only_flagged_chunks_are_read_and_the_lsn_test_still_applies(self):
        # 4 chunks (32 pages): chunk 1 has a page newer than prev_lsn, chunk 2 is flagged but older, chunk 3 is torn
        path = os.path.join(self.d, "rel")
        pages = []
        for i in range(32):
            lsn = 5000 if i == 12 else 100
            pages.append(self._page(lsn))
        data = b"".join(pages) + b"\x01" * 100                        # torn tail in chunk 4 (index 4)
        with open(path, "wb") as f:
            f.write(data)
        st = os.stat(path)
        entry, stats = backup_file_sparse(self.repo, "base/5/1", path, st, prev_lsn=1000, chunk_idx={1, 2, 4, 9})
        self.assertEqual([c[0] for c in entry["chunks"]], [CHUNK_SIZE, 4 * CHUNK_SIZE], "chunk 1 (newer page) and the torn tail")
        self.assertEqual(entry["size"], len(data))
        self.assertEqual(stats["pages_read"], 8 + 8 + 1)
        self.assertEqual(stats["bytes_not_read"], len(data) - 17 * BLCKSZ)
        self.repo.flush()
        self.assertEqual(self.repo.get_chunk(entry["chunks"][0][2]), data[CHUNK_SIZE:2 * CHUNK_SIZE])
        e2, s2 = unread_entry(st)
        self.assertEqual((e2["chunks"], e2["size"], e2["kind"], s2["bytes_not_read"]), ([], len(data), "pages", len(data)))

    def test_contradiction_only_inside_the_summarized_range(self):
        path = os.path.join(self.d, "rel2")
        with open(path, "wb") as f:
            f.write(self._page(100) + b"\x00" * BLCKSZ + self._page(9000) + self._page(500))
        self.assertIsNone(ws.contradiction(path, 1000, 5000), "LSN 9000 is after the backup start: not a contradiction; zero page ignored")
        with open(path, "ab") as f:
            f.write(self._page(3000))
        self.assertEqual(ws.contradiction(path, 1000, 5000), 4, "page 4 changed inside [1000, 5000)")
        self.assertIsNone(ws.contradiction(os.path.join(self.d, "nope"), 0, 1))

    def test_vanished_file_is_skipped(self):
        class St(object):
            st_size, st_mode, st_mtime = 0, 0o100600, 0
        entry, stats = backup_file_sparse(self.repo, "base/5/9", os.path.join(self.d, "nope"), St(), 0, {0})
        self.assertIsNone(entry)
        self.assertEqual(stats["skipped"], 1)


if __name__ == "__main__":
    unittest.main()
