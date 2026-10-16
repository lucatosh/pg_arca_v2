"""Fixes from the independent restore-engine review (16/10): delta cleanup, chains across a timeline fork, time targets at an incremental's end,
data directories that cannot be swapped."""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.engine import replace
from pg_arca.engine import restore as R
from pg_arca.engine.util import EngineError


class _Wal:
    def __init__(self, hist):
        self.hist = hist                                      # {tli: {ancestor tli: end lsn int}}

    def list_histories(self):
        return ["%08X.history" % t for t in self.hist]

    def _history_forks(self, tli, directory=None):
        return self.hist.get(tli)


class _Ctx:
    def __init__(self, hist):
        self.wal = _Wal(hist)

    def log(self, *a):
        pass


def _lsn(v):
    return "%X/%X" % (v >> 32, v & 0xFFFFFFFF)


class DeltaCleanup(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def test_pg_wal_and_tablespace_map_of_the_previous_copy_go(self):
        d = os.path.join(self.t, "d")
        os.makedirs(os.path.join(d, "pg_wal", "archive_status"))
        os.makedirs(os.path.join(d, "base", "1"))
        for f in ("pg_wal/000000020000000000000005", "pg_wal/00000002.history", "pg_wal/archive_status/x.done", "tablespace_map", "base/1/999", "base/1/1"):
            open(os.path.join(d, f), "w").write("x")
        R.remove_stale(d, {"base/1/1": {}})
        self.assertEqual(os.listdir(os.path.join(d, "pg_wal")), ["archive_status"])
        self.assertEqual(os.listdir(os.path.join(d, "pg_wal", "archive_status")), [])
        self.assertFalse(os.path.exists(os.path.join(d, "tablespace_map")))
        self.assertEqual(os.listdir(os.path.join(d, "base", "1")), ["1"])

    def test_a_linked_pg_wal_is_unlinked_never_emptied(self):
        d, elsewhere = os.path.join(self.t, "d"), os.path.join(self.t, "walvol")
        os.makedirs(d)
        os.makedirs(elsewhere)
        open(os.path.join(elsewhere, "000000010000000000000001"), "w").write("x")
        os.symlink(elsewhere, os.path.join(d, "pg_wal"))
        R.remove_stale(d, {})
        self.assertFalse(os.path.islink(os.path.join(d, "pg_wal")))
        self.assertTrue(os.path.exists(os.path.join(elsewhere, "000000010000000000000001")), "what the link pointed to is never touched")

    def test_tablespace_contents_cleaned_only_in_our_version_directory(self):
        d, loc = os.path.join(self.t, "d"), os.path.join(self.t, "ts")
        os.makedirs(os.path.join(d, "pg_tblspc"))
        os.makedirs(os.path.join(loc, "PG_16_202307071", "16384"))
        os.makedirs(os.path.join(loc, "PG_17_202406281", "16384"))
        for f in ("PG_16_202307071/16384/1", "PG_16_202307071/16384/2", "PG_17_202406281/16384/2"):
            open(os.path.join(loc, f), "w").write("x")
        os.symlink(loc, os.path.join(d, "pg_tblspc", "16500"))
        n = R.remove_stale_tablespaces(d, {"pg_tblspc/16500/PG_16_202307071/16384/1": {}})
        self.assertEqual(n, 1)
        self.assertEqual(sorted(os.listdir(os.path.join(loc, "PG_16_202307071", "16384"))), ["1"])
        self.assertTrue(os.path.exists(os.path.join(loc, "PG_17_202406281", "16384", "2")), "another major's directory is not ours")


class ChainAcrossFork(unittest.TestCase):
    def test_incremental_past_the_fork_is_dropped(self):
        seg = 16 << 20
        chain = [{"id": "F", "timeline": 1, "stop_lsn": _lsn(2 * seg)}, {"id": "I1", "timeline": 1, "stop_lsn": _lsn(5 * seg)},
                 {"id": "I2", "timeline": 1, "stop_lsn": _lsn(9 * seg)}]
        ctx = _Ctx({2: {1: 6 * seg}})                       # a standby promoted at 6: timeline 1 after it is an abandoned branch
        kept, note = R.fit_chain_to_timeline(ctx, chain, "latest")
        self.assertEqual([m["id"] for m in kept], ["F", "I1"])
        self.assertIn("I2", note)
        kept, note = R.fit_chain_to_timeline(ctx, chain, "current")
        self.assertEqual(len(kept), 3, "staying on timeline 1, the whole chain is valid")
        self.assertIsNone(note)

    def test_base_full_past_the_fork_refused(self):
        seg = 16 << 20
        with self.assertRaises(EngineError) as cm:
            R.fit_chain_to_timeline(_Ctx({2: {1: 3 * seg}}), [{"id": "F", "timeline": 1, "stop_lsn": _lsn(4 * seg)}], "latest")
        self.assertEqual(cm.exception.code, "PGA-PITR-020")

    def test_no_history_leaves_the_chain(self):
        chain = [{"id": "F", "timeline": 1, "stop_lsn": "0/3000000"}]
        self.assertEqual(R.fit_chain_to_timeline(_Ctx({}), chain)[0], chain)


class TimeTargetMargin(unittest.TestCase):
    def test_incremental_ending_at_the_target_second_is_not_the_base(self):
        sets = [{"id": "F", "type": "full", "stop_time": "2026-10-16T10:00:00+00:00", "stop_lsn": "0/3000000"},
                {"id": "I", "type": "incr", "stop_time": "2026-10-16T10:05:00+00:00", "stop_lsn": "0/5000000"}]

        class Repo:
            def complete_sets(self):
                return sets
        self.assertEqual(R.choose_set(Repo(), target_time="2026-10-16 10:05:00+00")["id"], "F")
        self.assertEqual(R.choose_set(Repo(), target_time="2026-10-16 10:05:03+00")["id"], "I")
        self.assertEqual(R.choose_set(Repo(), target_time="2026-10-16 10:00:00+00")["id"], "F", "a full needs no margin")
        # chosen explicitly: the same margin (independent review)
        sets[1].update(id="I", status="COMPLETE")
        Repo.resolve_set = lambda self, spec: [x for x in sets if x["id"] == spec][0]
        with self.assertRaises(R.EngineError) as e:
            R.choose_set(Repo(), spec="I", target_time="2026-10-16 10:05:01+00")
        self.assertIn("within 2 seconds", e.exception.message)
        self.assertEqual(R.choose_set(Repo(), spec="I", target_time="2026-10-16 10:05:02+00")["id"], "I")
        self.assertEqual(R.choose_set(Repo(), spec="F", target_time="2026-10-16 10:00:00+00")["id"], "F")


class Swap(unittest.TestCase):
    def test_mount_point_refused_before_anything_stops(self):
        e = replace.swap_blocker("/")
        self.assertIsNotNone(e)
        self.assertEqual(e.code, "PGA-RST-089")
        t = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(t, "main"))
            self.assertIsNone(replace.swap_blocker(os.path.join(t, "main")))
        finally:
            shutil.rmtree(t)


class PartitionRoots(unittest.TestCase):
    def test_detached_partition_is_not_mapped_to_its_old_root(self):
        from pg_arca.engine import walscan
        old = {"databases": {"app": {"oid": 5, "relations": [{"oid": 10, "schema": "public", "name": "sales", "kind": "p", "relfilenode": 0, "parent": 0},
                                                            {"oid": 11, "schema": "public", "name": "sales_2024", "kind": "r", "relfilenode": 111, "parent": 10},
                                                            {"oid": 12, "schema": "public", "name": "sales_2025", "kind": "r", "relfilenode": 112, "parent": 10}]}}}
        new = {"databases": {"app": {"oid": 5, "relations": [{"oid": 10, "schema": "public", "name": "sales", "kind": "p", "relfilenode": 0, "parent": 0},
                                                            {"oid": 11, "schema": "public", "name": "sales_2024", "kind": "r", "relfilenode": 111, "parent": 0},   # detached
                                                            {"oid": 12, "schema": "public", "name": "sales_2025", "kind": "r", "relfilenode": 112, "parent": 10}]}}}

        class Repo:
            def complete_sets(self):
                return [{"id": "A"}, {"id": "B"}]

            def load_catalog(self, st):
                return old if st["id"] == "A" else new

        class C:
            repo = Repo()
        roots = walscan._partition_roots(C())
        self.assertEqual(roots.get(("5", "112")), "app.public.sales")
        self.assertNotIn(("5", "111"), roots, "detached in the newer catalog: not a partition of sales any more")


if __name__ == "__main__":
    unittest.main()
