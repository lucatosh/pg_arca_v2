"""Asynchronous WAL archiving: the spool accepts only while the pusher is alive and not full; the pusher archives through WalManager (every
check applies), removes what it archived, reports and retries what the archive refused; archive_command spools or goes synchronous."""
import json
import os
import shutil
import tempfile
import time
import unittest

from pg_arca import wal_spool
from pg_arca.wal_manager import WalManager

MB = 1 << 20


def seg(tli, hi, lo):
    return "%08X%08X%08X" % (tli, hi, lo)


class SpoolTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(prefix="pgarca-spool-")
        self.src = os.path.join(self.t, "pg_wal")
        self.wal = os.path.join(self.t, "wal")
        self.state = os.path.join(self.t, "state")
        os.makedirs(self.src)
        os.makedirs(self.wal)
        self.spool = wal_spool.spool_dir(self.state)
        self.wm = WalManager(self.wal, "zlib", 3, MB)
        self.errors = []

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def mk(self, name, fill=b"a"):
        p = os.path.join(self.src, name)
        with open(p, "wb") as f:
            f.write(fill * MB)
        return p

    def test_accept_only_with_a_live_pusher_and_room(self):
        p = self.mk(seg(1, 0, 1))
        self.assertFalse(wal_spool.accept(self.spool, p, seg(1, 0, 1)), "no pusher heartbeat: synchronous")
        pu = wal_spool.Pusher(self.wm, self.spool)
        pu.heartbeat()
        self.assertTrue(wal_spool.accept(self.spool, p, seg(1, 0, 1)))
        self.assertEqual(wal_spool.pending(self.spool), [seg(1, 0, 1)])
        self.assertFalse(wal_spool.accept(self.spool, self.mk(seg(1, 0, 2)), seg(1, 0, 2), max_segments=1), "full: synchronous")
        old = time.time() - wal_spool.PUSHER_STALE_SEC - 5
        os.utime(os.path.join(self.spool, wal_spool.HEARTBEAT), (old, old))
        self.assertFalse(wal_spool.accept(self.spool, self.mk(seg(1, 0, 3)), seg(1, 0, 3)), "stale heartbeat: synchronous")
        st = wal_spool.status(self.spool)
        self.assertEqual((st["pending"], st["alive"]), (1, False))

    def test_pusher_archives_in_order_and_retries_what_is_refused(self):
        pu = wal_spool.Pusher(self.wm, self.spool, workers=3, on_error=lambda n, m: self.errors.append((n, m)))
        pu.heartbeat()
        names = [seg(1, 0, i) for i in range(1, 8)]
        for n in names:
            self.assertTrue(wal_spool.accept(self.spool, self.mk(n), n))
        self.assertEqual(pu.cycle(), 7)
        self.assertEqual(wal_spool.pending(self.spool), [])
        for n in names:
            self.assertTrue(self.wm.has_segment(n))
        self.assertEqual(pu.pushed, 7)
        # a segment whose content differs from what the archive holds: refused (quarantined by WalManager), kept in the spool, reported, retried later
        bad = seg(1, 0, 3)
        self.assertTrue(wal_spool.accept(self.spool, self.mk(bad, b"z"), bad))
        self.assertEqual(pu.cycle(), 0)
        self.assertEqual(wal_spool.pending(self.spool), [bad])
        self.assertIn("PGA-WAL-031", pu.last_error["error"])
        self.assertEqual(self.errors[-1][0], bad)
        self.assertEqual(pu.cycle(), 0, "not retried before RETRY_SEC")
        pu._retry_at[bad] = 0
        self.assertEqual(pu.cycle(), 0, "still divergent")
        # a later segment of the SAME timeline is held back by the refused one (publishing it would put this server's segment after
        # another server's in one chain: architecture review B1); another timeline's is not
        good = seg(1, 0, 9)
        wal_spool.accept(self.spool, self.mk(good), good)
        other = seg(2, 0, 9)
        wal_spool.accept(self.spool, self.mk(other), other)
        pu._retry_at[bad] = time.time() + 100
        self.assertEqual(pu.cycle(), 1)
        self.assertFalse(self.wm.has_segment(good))
        self.assertTrue(self.wm.has_segment(other))
        st = wal_spool.status(self.spool)
        self.assertEqual((st["pending"], st["pushed"], st["failed"] >= 2), (2, 8, True))
        self.assertIsNotNone(st["oldest_age_sec"])
        # the refused copy is removed by the operator: what waited behind it goes on
        os.unlink(os.path.join(self.spool, bad))
        self.assertEqual(pu.cycle(), 1)
        self.assertTrue(self.wm.has_segment(good))
        self.assertEqual(wal_spool.status(self.spool)["pending"], 0)

    def test_archive_command_spools_or_goes_synchronous(self):
        from pg_arca import wal_archive
        conf = os.path.join(self.t, "agent.conf")
        with open(conf, "w") as f:
            json.dump({"wal_archive_dir": self.wal, "compression": "zlib", "wal_segment_size": MB, "state_dir": self.state, "wal_archive_async": True}, f)
        os.environ["PG_ARCA_CONF"] = conf
        os.environ["WAL_ARCHIVE_DIR"] = self.wal
        try:
            n1 = seg(2, 0, 1)
            self.assertEqual(wal_archive.main(["x", "archive", self.mk(n1), n1]), 0)
            self.assertTrue(self.wm.has_segment(n1), "no pusher alive: archived synchronously")
            self.assertEqual(wal_spool.pending(self.spool), [])
            pu = wal_spool.Pusher(self.wm, self.spool)
            pu.heartbeat()
            n2 = seg(2, 0, 2)
            self.assertEqual(wal_archive.main(["x", "archive", self.mk(n2), n2]), 0)
            self.assertEqual(wal_spool.pending(self.spool), [n2], "pusher alive: spooled, PostgreSQL got its 0 at once")
            self.assertFalse(self.wm.has_segment(n2))
            self.assertEqual(pu.cycle(), 1)
            self.assertTrue(self.wm.has_segment(n2))
            os.environ["PG_ARCA_WAL_SYNC"] = "1"
            n3 = seg(2, 0, 3)
            self.assertEqual(wal_archive.main(["x", "archive", self.mk(n3), n3]), 0)
            self.assertTrue(self.wm.has_segment(n3), "PG_ARCA_WAL_SYNC forces the synchronous path")
        finally:
            for k in ("PG_ARCA_CONF", "WAL_ARCHIVE_DIR", "PG_ARCA_WAL_SYNC"):
                os.environ.pop(k, None)

    def test_overrides_bool(self):
        from pg_arca import overrides
        self.assertIs(overrides.validate("wal_archive_async", "on"), True)
        self.assertIs(overrides.validate("wal_archive_async", False), False)
        with self.assertRaises(overrides.OverrideError):
            overrides.validate("wal_archive_async", "maybe")


if __name__ == "__main__":
    unittest.main()
