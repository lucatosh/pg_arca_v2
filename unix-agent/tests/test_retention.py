"""Retention in days of recoverability (policy retentionDays): every point of the last N days stays restorable, so the newest full that
STARTED BEFORE the cutoff is kept as well (found by an independent review: only the fulls younger than the cutoff were kept, and with weekly
fulls the window silently lost up to a week, WAL included). No PostgreSQL needed."""
import os
import shutil
import tempfile
import time
import unittest

from pg_arca.engine.maintenance import expire
from pg_arca.engine.repo import Repo
from pg_arca.engine.util import write_json


class Ctx(object):
    def __init__(self, repo):
        self.repo = repo
        self.retention_full = 1
        self.retention_days = 30
        self.seg_size = 16 * 1024 * 1024
        self.wal = None


class RetentionDaysTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="pgarca-ret-")
        self.repo = Repo(os.path.join(self.d, "repo"), "main", algo="zlib")
        self.repo.init()

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _set(self, sid, days_ago, lsn, duration=0):
        ts = time.time() - days_ago * 86400
        d = self.repo.own_path("backup", sid)
        os.makedirs(d)
        write_json(os.path.join(d, "meta.json"), {"id": sid, "type": "full", "parent": None, "status": "COMPLETE", "started_ts": ts, "duration_sec": duration,
                                                 "start_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)), "start_lsn": lsn, "stop_lsn": lsn, "timeline": 1})

    def test_a_running_restore_pins_what_it_reads(self):
        self._set("20250825-000000F", 42, "0/8000000")
        self._set("20251006-000000F", 0, "3/0")
        c = Ctx(self.repo); c.retention_days = 0
        self.assertEqual(expire(c, dry_run=True)["delete_sets"], ["20250825-000000F"])
        with self.repo.pinned(["20250825-000000F"], "0/8000000"):
            plan = expire(c, dry_run=True)
            self.assertEqual(plan["delete_sets"], [], "a restore reads it right now")
            self.assertEqual(plan["wal_keep_from_lsn"], "0/08000000")
        self.assertEqual(expire(c, dry_run=True)["delete_sets"], ["20250825-000000F"], "the pin is gone with the restore")
        self.repo.pin("dead", ["20250825-000000F"], "0/8000000", ttl=-1)
        self.assertEqual(expire(c, dry_run=True)["delete_sets"], ["20250825-000000F"], "a pin nobody refreshes dies by itself")

    def test_a_full_running_across_the_cutoff_does_not_carry_it(self):
        # points just after the cutoff come before that full ENDS: the previous full must stay (independent review)
        self._set("20250901-000000F", 37, "1/0")
        self._set("20250908-000000F", 30.05, "2/0", duration=4 * 3600)            # started 30 days + 72 min ago, ran 4 h: ends inside the window
        self._set("20251006-000000F", 0, "3/0")
        self._set("20251007-000000F", 0, "4/0")
        c = Ctx(self.repo); c.retention_full = 1
        plan = expire(c, dry_run=True)
        self.assertNotIn("20250901-000000F", plan["delete_sets"], plan)

    def test_window_of_30_days_with_weekly_fulls(self):
        self._set("20250901-000000F", 35, "1/0")
        self._set("20250908-000000F", 28, "2/0")
        self._set("20251006-000000F", 0, "3/0")
        plan = expire(Ctx(self.repo), dry_run=True)
        # a point in time 29 days ago needs the full started 35 days ago (the newest full that precedes it)
        self.assertNotIn("20250901-000000F", plan["delete_sets"],
                         "retention_days=30 deleted the only chain that can reach a point 29 days ago: plan=%r" % plan)
        self.assertEqual(plan["delete_sets"], []); self.assertEqual(plan["wal_keep_from_lsn"], "1/00000000")
        # a fourth full, older still: only the one that no point of the window can need goes
        self._set("20250825-000000F", 42, "0/8000000")
        plan = expire(Ctx(self.repo), dry_run=True)
        self.assertEqual(plan["delete_sets"], ["20250825-000000F"]); self.assertEqual(plan["wal_keep_from_lsn"], "1/00000000")
        # count only (days = 0): the usual "keep the newest N fulls"
        c = Ctx(self.repo); c.retention_days = 0
        self.assertEqual(expire(c, dry_run=True)["delete_sets"], ["20250825-000000F", "20250901-000000F", "20250908-000000F"])


if __name__ == "__main__":
    unittest.main()


class PreviousLocationFloorTest(RetentionDaysTest):
    """After a destination change the sets still only in the previous location are restorable from here, and the WAL they need after the
    switch is in THIS archive: expire must not cut it (found by an independent review: the floor came from this location's sets only, so
    the first expire deleted the WAL between the switch and the first new full)."""
    def test_wal_floor_covers_sets_of_the_previous_location(self):
        old_root = os.path.join(self.d, "old")
        old = Repo(old_root, "main", algo="zlib"); old.init()
        ts = time.time() - 3 * 86400
        d = old.own_path("backup", "20251003-000000F"); os.makedirs(d)
        write_json(os.path.join(d, "meta.json"), {"id": "20251003-000000F", "type": "full", "parent": None, "status": "COMPLETE", "started_ts": ts,
                                                 "start_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)), "start_lsn": "1/0", "stop_lsn": "1/0", "timeline": 1})
        self._set("20251006-000000F", 0, "5/0")                                 # first full in the new location
        here = Repo(os.path.join(self.d, "repo"), "main", algo="zlib", previous=[old_root])
        c = Ctx(here); c.retention_days = 0
        plan = expire(c, dry_run=True)
        self.assertEqual(plan["delete_sets"], []); self.assertEqual(plan["wal_keep_from_lsn"], "1/00000000", plan)
        c2 = Ctx(self.repo); c2.retention_days = 0                               # previous location dropped: the floor is this location's
        self.assertEqual(expire(c2, dry_run=True)["wal_keep_from_lsn"], "5/00000000")
