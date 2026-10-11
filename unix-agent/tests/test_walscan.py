"""walscan without PostgreSQL: line parsing, window planning, cache."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.engine import walscan

SEG = 16 * 1024 * 1024


def nm(tli, n):
    return "%08X%08X%08X" % (tli, n // 256, n % 256)


class T(unittest.TestCase):
    def test_commit_with_rels_is_a_drop(self):
        l = b"rmgr: Transaction len (rec/tot):    114/   114, tx:        745, lsn: 0/0300A1B8, prev 0/0300A180, desc: COMMIT 2026-10-11 01:36:04.742818 UTC; rels: base/5/16401 base/5/16404; inval msgs: catcache 51"
        e = walscan.parse_line(l)
        self.assertEqual((e["kind"], e["xid"], e["lsn"], e["time"]), ("DROP", "745", "0/0300A1B8", "2026-10-11 01:36:04.742818 UTC"))
        self.assertEqual(e["rels"], [["5", "16401"], ["5", "16404"]])

    def test_commit_without_rels_and_abort_are_ignored(self):
        self.assertIsNone(walscan.parse_line(b"rmgr: Transaction len (rec/tot): 34/34, tx: 7, lsn: 0/3000028, prev 0/3000000, desc: COMMIT 2026-10-11 01:36:04.1 UTC"))
        self.assertIsNone(walscan.parse_line(b"rmgr: Transaction len (rec/tot): 34/34, tx: 7, lsn: 0/3000028, prev 0/3000000, desc: ABORT 2026-10-11 01:36:04.1 UTC; rels: base/5/1"))

    def test_temp_relations_do_not_match(self):
        self.assertIsNone(walscan.parse_line(b"rmgr: Transaction len (rec/tot): 34/34, tx: 7, lsn: 0/3000028, prev 0/3000000, desc: COMMIT 2026-10-11 01:36:04.1 UTC; rels: base/5/t3_16384"))

    def test_tablespace_relations(self):
        e = walscan.parse_line(b"rmgr: Transaction len (rec/tot): 34/34, tx: 7, lsn: 0/3000028, prev 0/3000000, desc: COMMIT 2026-10-11 01:36:04 UTC; rels: pg_tblspc/16500/PG_16_202307071/5/16384")
        self.assertEqual(e["rels"], [["5", "16384"]])

    def test_truncate_only_to_zero(self):
        # in-place truncation (same-transaction table) and VACUUM trimming are never the loss of committed data (PG18 VACUUM even has an xid)
        self.assertIsNone(walscan.parse_line(b"rmgr: Storage len (rec/tot): 20/20, tx: 0, lsn: 0/3000100, prev 0/3000000, desc: TRUNCATE base/5/16384 to 0 flags 7"))
        self.assertIsNone(walscan.parse_line(b"rmgr: Storage len (rec/tot): 46/46, tx: 756, lsn: 0/017D23B0, prev 0/017D2380, desc: TRUNCATE base/5/16392 to 0 blocks flags 7"))
        self.assertIsNone(walscan.parse_line(b"rmgr: Storage len (rec/tot): 20/20, tx: 0, lsn: 0/3000100, prev 0/3000000, desc: TRUNCATE base/5/16384 to 12 flags 7"))

    def test_drop_database(self):
        e = walscan.parse_line(b"rmgr: Database len (rec/tot): 42/42, tx: 812, lsn: 0/4000028, prev 0/4000000, desc: DROP dir 1663/16456")
        self.assertEqual((e["kind"], e["xid"], e["rels"]), ("DROP DATABASE", "812", [["16456", ""]]))
        self.assertIsNone(walscan.parse_line(b"rmgr: Database len (rec/tot): 42/42, tx: 812, lsn: 0/4000028, prev 0/4000000, desc: CREATE copy dir 1663/1 to 1663/16456"))

    def test_other_rmgrs(self):
        self.assertIsNone(walscan.parse_line(b"rmgr: Heap len (rec/tot): 59/59, tx: 7, lsn: 0/3000028, prev 0/3000000, desc: INSERT off: 1 rels: base/5/1"))

    def test_plan_splits_gaps_chunks_and_timelines(self):
        names = [nm(1, n) for n in (1, 2, 3, 4, 5, 6, 8, 9)] + [nm(2, 6), nm(2, 7)]
        plan = walscan._plan(names, SEG, 3)
        got = [(t, n[0][-2:], n[-1][-2:], x[-2:] if x else None) for t, n, x in plan]
        self.assertIn((1, "01", "03", "04"), got)          # the window carries the next segment, to read a record that straddles the boundary
        self.assertIn((1, "04", "06", None), got)         # 07 is missing: nothing to read past 06
        self.assertIn((1, "08", "09", None), got)
        self.assertIn((2, "06", "07", None), got)
        self.assertEqual(sum(len(n) for _, n, _ in plan), len(names))
        self.assertEqual(plan[0][1][-1], nm(2, 7))        # newest first

    def test_cache_roundtrip_and_invalidation(self):
        d = tempfile.mkdtemp()
        c = walscan.Cache(os.path.join(d, "c.json"), SEG)
        c.put("A", "10:1", "D", [{"lsn": "0/1"}])
        c.put("B", "10:1", "E", [])
        c.save(keep={"A", "B"})
        c2 = walscan.Cache(os.path.join(d, "c.json"), SEG)
        self.assertEqual(c2.get("A", "10:1", "D"), [{"lsn": "0/1"}])
        self.assertIsNone(c2.get("A", "10:1", "E"), "a Database-only scan cannot answer a full question")
        self.assertEqual(c2.get("B", "10:1", "D"), [], "a full scan answers the Database-only question")
        self.assertIsNone(c2.get("A", "11:1", "D"), "size/mtime changed: rescan")
        self.assertIsNone(walscan.Cache(os.path.join(d, "c.json"), 64 * 1024 * 1024).get("A", "10:1", "D"), "another segment size: cache ignored")
        c2.save(keep={"B"})
        self.assertIsNone(walscan.Cache(os.path.join(d, "c.json"), SEG).get("A", "10:1", "D"), "segments that left the archive leave the cache")


class FoldCreates(unittest.TestCase):
    def test_truncate_is_a_commit_dropping_files_plus_new_files_same_xid(self):
        c = walscan.parse_line(b"rmgr: Storage     len (rec/tot): 42/42, tx: 900, lsn: 0/5000100, prev 0/5000000, desc: CREATE base/5/17001")
        self.assertEqual(c["kind"], "CREATE")
        drop = {"kind": "DROP", "xid": "900", "lsn": "0/5000200", "rels": [["5", "16384"]], "nrels": 1, "time": "t"}
        other = {"kind": "DROP", "xid": "901", "lsn": "0/5000300", "rels": [["5", "16390"]], "nrels": 1, "time": "t"}
        out = walscan.fold_creates([c, drop, other])
        self.assertEqual([e["kind"] for e in out], ["TRUNCATE", "DROP"])
        self.assertEqual(out[0]["rels"], [["5", "17001"]])            # named after the NEW file: the one the catalog knows
        self.assertTrue(out[0]["rewrite_possible"])

    def test_drop_and_truncate_in_one_transaction_keeps_both(self):
        c = {"kind": "CREATE", "xid": "7", "lsn": "0/1", "rels": [["5", "200"]], "nrels": 1}
        d = {"kind": "DROP", "xid": "7", "lsn": "0/2", "rels": [["5", "100"], ["5", "101"], ["5", "102"]], "nrels": 3}
        out = walscan.fold_creates([c, d])
        self.assertEqual(sorted(e["kind"] for e in out), ["DROP", "TRUNCATE"])
        self.assertEqual(next(e for e in out if e["kind"] == "DROP")["nrels"], 2)


if __name__ == "__main__":
    unittest.main()
