import os, sys, tempfile, unittest, hashlib
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.wal_manager import WalManager, WalArchiveError

MB = 1 << 20

def seg(tl, log, s): return "%08X%08X%08X" % (tl, log, s)

class WalTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.wm = WalManager(os.path.join(self.t, "wal"), compression="zstd", segment_size=MB)
        self.src = os.path.join(self.t, "src"); os.makedirs(self.src)

    def mk(self, name, fill=b"a"):
        p = os.path.join(self.src, name)
        with open(p, "wb") as f: f.write(fill * MB)
        return p

    def test_archive_roundtrip_and_idempotent(self):
        n = seg(1, 0, 1); p = self.mk(n)
        ok, dest, sha, _ = self.wm.archive_segment(p, n); self.assertTrue(ok)
        ok2, dest2, sha2, msg = self.wm.archive_segment(p, n)       # PostgreSQL retry after crash
        self.assertTrue(ok2); self.assertEqual(dest, dest2); self.assertIn("identical", msg)
        out = os.path.join(self.t, "restored"); code, _ = self.wm.retrieve_segment(n, out)
        self.assertEqual(code, 0); self.assertEqual(open(out, "rb").read(), b"a" * MB)

    def mkdb(self, name, sysid, fill=b"b"):
        """A segment that starts with a real long page header (XLP_LONG_HEADER) of database `sysid`."""
        import struct
        hdr = struct.pack("<HHIQI", 0xD116, 0x0002 | 0x0004, 1, 0, 0) + b"\0" * 4 + struct.pack("<QII", sysid, MB, 8192)
        p = os.path.join(self.src, name)
        with open(p, "wb") as f: f.write(hdr + fill * (MB - len(hdr)))
        return p

    def test_one_database_per_archive(self):
        from pg_arca.wal_manager import segment_sysid
        a = self.mkdb(seg(1, 0, 1), 7001)
        self.assertEqual(segment_sysid(a), "7001")
        self.wm.archive_segment(a, seg(1, 0, 1))
        self.assertEqual(self.wm.owner(), "7001")
        self.assertEqual(self.wm._read_meta(seg(1, 0, 1)).get("sysid"), "7001")
        self.wm.archive_segment(self.mkdb(seg(2, 0, 2), 7001), seg(2, 0, 2))        # the other site of the same database (new timeline): fine
        with self.assertRaises(WalArchiveError) as c:                               # another cluster pointed at the same directory: refused, clearly
            self.wm.archive_segment(self.mkdb(seg(1, 0, 5), 9999), seg(1, 0, 5))
        self.assertIn("PGA-WAL-032", str(c.exception))
        self.assertIsNone(self.wm._find(seg(1, 0, 5))[0])
        self.wm.archive_segment(self.mk(seg(1, 0, 7)), seg(1, 0, 7))                 # no readable header (tests, odd tools): no owner check, still archived

    def test_promotion_partial_segment_is_not_a_gap(self):
        for i in (1, 2, 3):
            n = seg(1, 0, i); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, seg(1, 0, 3) + ".partial.zst"), "wb").write(b"x")     # what a promotion leaves behind
        open(os.path.join(self.wm.wal_dir, seg(1, 0, 3) + ".partial"), "wb").write(b"x")
        rep = self.wm.verify_continuity(max_age=0)
        self.assertTrue(rep["continuous"], rep)
        self.assertEqual(self.wm.list_segments(), [seg(1, 0, i) for i in (1, 2, 3)])

    def test_restore_command_errors_abort_recovery_not_end_it(self):
        from pg_arca import wal_archive
        env = dict(os.environ); os.environ["WAL_ARCHIVE_DIR"] = self.wm.wal_dir; os.environ["PG_ARCA_KEY_FILE"] = os.path.join(self.t, "missing.key")
        try:
            self.assertEqual(wal_archive.main(["x", "get", seg(1, 0, 9), os.path.join(self.t, "o")]), 126)       # exit 1 would mean 'end of archive'
            self.assertEqual(wal_archive.main(["x", "archive", self.mk(seg(1, 0, 9)), seg(1, 0, 9)]), 1)
        finally:
            os.environ.clear(); os.environ.update(env)
        os.environ["WAL_ARCHIVE_DIR"] = self.wm.wal_dir
        try:
            self.assertEqual(wal_archive.main(["x", "get", seg(1, 0, 77), os.path.join(self.t, "o")]) , 1)       # genuinely absent -> 1
        finally:
            os.environ.pop("WAL_ARCHIVE_DIR", None)

    def test_divergent_copy_of_a_branch_this_server_left_is_acknowledged(self):
        """Geo failover on a shared archive (seen on the lab): the new primary (timeline 12) still has timeline 10's segment 0x11 marked
        .ready, and the archive already holds the OLD primary's copy of it. This server's history left timeline 10 inside segment 0x11, so
        recovery along it reads timeline 11's copy of that segment, never this one: acknowledge it (quarantined for review) instead of
        blocking PostgreSQL's archiver forever. A divergence BEFORE the switch point (shared history) stays an error."""
        n = seg(10, 0, 0x11)
        self.wm.archive_segment(self.mk(n, b"a"), n)                                    # the old primary's copy
        self.mk(seg(12, 0, 0x30), b"c")                                                 # this server writes timeline 12
        def hist(tl10_end):
            with open(os.path.join(self.src, "0000000C.history"), "w") as f:
                f.write("9\t0/9000000\tno recovery target specified\n10\t%s\tno recovery target specified\n11\t0/1A000000\tno recovery target specified\n" % tl10_end)
        hist("0/110A000")                                                              # left timeline 10 inside segment 0x11 (1 MB segments)
        ok, _, _, msg = self.wm.archive_segment(self.mk(n, b"b"), n)
        self.assertTrue(ok); self.assertIn("not needed by this server's timeline history", msg); self.assertIn("timeline 11", msg)
        out = os.path.join(self.t, "r"); self.wm.retrieve_segment(n, out)
        self.assertEqual(open(out, "rb").read(), b"a" * MB, "the stored copy is never replaced")
        self.assertEqual(len(self.wm.conflicts()), 1, "the incoming copy is kept for review (with its sidecar)")
        hist("0/1200000")                                                              # segment 0x11 entirely BEFORE the switch: shared history
        with self.assertRaises(WalArchiveError) as cm: self.wm.archive_segment(self.mk(n, b"b"), n)
        self.assertEqual(cm.exception.code, "PGA-WAL-031")
        os.remove(os.path.join(self.src, "0000000C.history"))                           # no history of our own timeline: no decision, error
        with self.assertRaises(WalArchiveError): self.wm.archive_segment(self.mk(n, b"b"), n)
        hist("0/110A000")
        with open(os.path.join(self.src, "0000000C.history"), "w") as f:                # timeline 10 not an ancestor of ours: a human decides
            f.write("9\t0/9000000\tx\n11\t0/1A000000\tx\n")
        with self.assertRaises(WalArchiveError): self.wm.archive_segment(self.mk(n, b"b"), n)

    def test_abandoned_timeline_is_set_aside(self):
        """A site that promoted itself while cut off (timeline 13) and was rebuilt from the primary (timeline 12): its history file in the
        archive made the rebuilt members try to follow timeline 13 at start (lab). retire_abandoned sets every object of it aside; refused
        for the primary's own timeline or an older one."""
        for n in (seg(13, 0, 0x18), seg(13, 0, 0x19)):
            self.wm.archive_segment(self.mk(n), n)
        hp = os.path.join(self.src, "0000000D.history")
        with open(hp, "w") as f: f.write("12\t0/17000000\tno recovery target specified\n")
        self.wm.archive_segment(hp, "0000000D.history")
        keep = seg(12, 0, 0x18); self.wm.archive_segment(self.mk(keep, b"k"), keep)
        with self.assertRaises(WalArchiveError) as cm: self.wm.retire_abandoned(12, 12)
        self.assertEqual(cm.exception.code, "PGA-WAL-035")
        dry = self.wm.retire_abandoned(13, 12, dry_run=True)
        self.assertIn("0000000D.history", dry["retired"]); self.assertTrue(os.path.exists(os.path.join(self.wm.wal_dir, "0000000D.history")))
        rep = self.wm.retire_abandoned(13, 12)
        self.assertFalse(any(f.startswith("0000000D") for f in os.listdir(self.wm.wal_dir)), os.listdir(self.wm.wal_dir))
        self.assertIn("0000000D.history", os.listdir(rep["dead_branch_dir"]))
        out = os.path.join(self.t, "k"); self.assertEqual(self.wm.retrieve_segment(keep, out)[0], 0, "the primary's timeline is untouched")
        self.assertEqual(self.wm.retire_abandoned(13, 12)["retired"], [], "idempotent")

    def test_divergent_copy_is_refused_and_quarantined(self):
        n = seg(1, 0, 2); self.wm.archive_segment(self.mk(n, b"a"), n)
        with self.assertRaises(WalArchiveError) as cm: self.wm.archive_segment(self.mk(n, b"b"), n)
        self.assertEqual(cm.exception.code, "PGA-WAL-031")
        self.assertEqual(len(self.wm.conflicts()), 1)
        self.assertEqual(sorted(f.endswith(".json") for f in os.listdir(os.path.join(self.wm.wal_dir, "conflicts"))), [False, True], "the copy and its sidecar")
        out = os.path.join(self.t, "r"); self.wm.retrieve_segment(n, out)
        self.assertEqual(open(out, "rb").read(), b"a" * MB)           # original untouched

    def test_retire_dead_branch(self):
        """Two servers used timeline 7: the dead one archived first. Retiring the branch sets its copies aside and promotes the survivor's
        quarantined copies; shared (pre-fork) objects of the same timeline stay; nothing is deleted; the alarm goes away."""
        shared = seg(7, 0, 1); dead_seg = seg(7, 0, 2); hist = "00000007.history"
        self.wm.archive_segment(self.mk(shared, b"s"), shared)                       # both branches have it: no conflict
        self.wm.archive_segment(self.mk(dead_seg, b"d"), dead_seg)                   # dead branch's content
        hp = os.path.join(self.src, hist); open(hp, "w").write("6\t0/1000000\tdead\n"); self.wm.archive_segment(hp, hist)
        for name, fill in ((dead_seg, b"a"), (dead_seg, b"b")):                      # the survivor retried with two different contents over time
            with self.assertRaises(WalArchiveError): self.wm.archive_segment(self.mk(name, fill), name)
        open(hp, "w").write("6\t0/2000000\tsurvivor\n")
        with self.assertRaises(WalArchiveError): self.wm.archive_segment(hp, hist)
        self.assertEqual(len(self.wm.conflicts()), 3)
        # the survivor's pg_wal still holds the segment with content "b": only THAT quarantined copy may be promoted
        pgdata = os.path.join(self.t, "pgdata"); os.makedirs(os.path.join(pgdata, "pg_wal"))
        open(os.path.join(pgdata, "pg_wal", dead_seg), "wb").write(b"b" * MB)
        dry = self.wm.retire_branch(7, survivor_pgdata=pgdata, dry_run=True)
        self.assertEqual(sorted(dry["retired"]), sorted([dead_seg, hist])); self.assertTrue(dry["dry_run"])
        self.assertEqual(len(self.wm.conflicts()), 3, "dry run changes nothing")
        rep = self.wm.retire_branch(7, survivor_pgdata=pgdata)
        self.assertEqual(sorted(rep["retired"]), sorted([dead_seg, hist])); self.assertEqual(sorted(rep["promoted"]), sorted([dead_seg, hist]))
        out = os.path.join(self.t, "r"); self.wm.retrieve_segment(dead_seg, out)
        self.assertEqual(open(out, "rb").read(), b"b" * MB, "the survivor's copy is in the archive now")
        self.wm.retrieve_segment(shared, out); self.assertEqual(open(out, "rb").read(), b"s" * MB, "shared object untouched")
        self.assertIn("survivor", open(os.path.join(self.wm.wal_dir, hist)).read())
        dd = os.path.join(self.wm.wal_dir, "conflicts", "dead-branch-00000007")
        self.assertTrue(any(f.startswith(dead_seg) for f in os.listdir(dd)) and hist in os.listdir(dd), "dead copies kept aside, not deleted")
        self.assertEqual(self.wm.conflicts(), [], "no alarm left")
        ok, _, _, msg = self.wm.archive_segment(self.mk(dead_seg, b"b"), dead_seg)   # the primary's archiver retries: accepted
        self.assertTrue(ok); self.assertIn("identical", msg)
        self.assertEqual(self.wm.retire_branch(7, survivor_pgdata=pgdata)["retired"], [], "second run: nothing left to do")

    def test_corruption_aborts_recovery_not_end_of_archive(self):
        n = seg(1, 0, 3); _, dest, _, _ = self.wm.archive_segment(self.mk(n), n)
        data = bytearray(open(dest, "rb").read()); data[len(data) // 2] ^= 0xFF; open(dest, "wb").write(bytes(data))
        code, msg = self.wm.retrieve_segment(n, os.path.join(self.t, "x"))
        self.assertEqual(code, 126, msg)
        self.assertFalse(os.path.exists(os.path.join(self.t, "x")))
        self.assertEqual(self.wm.retrieve_segment(seg(1, 0, 9), os.path.join(self.t, "y"))[0], 1)   # missing => 1

    def test_rejects_partial_copy_and_bad_names(self):
        n = seg(1, 0, 4); p = os.path.join(self.src, n)
        with open(p, "wb") as f: f.write(b"x" * 1000)
        with self.assertRaises(WalArchiveError): self.wm.archive_segment(p, n)
        with self.assertRaises(WalArchiveError): self.wm.archive_segment(p, "../../etc/passwd")

    def test_continuity_rollover_and_gaps(self):
        per_id = 0x100000000 // MB
        for log, s in [(0, per_id - 2), (0, per_id - 1), (1, 0), (1, 1)]:   # crosses the logid boundary: NOT a gap
            n = seg(1, log, s); self.wm.archive_segment(self.mk(n), n)
        self.assertTrue(self.wm.verify_continuity(max_age=0)["continuous"])
        n = seg(1, 1, 5); self.wm.archive_segment(self.mk(n), n)          # real gap (2..4 missing)
        rep = self.wm.verify_continuity(max_age=0)
        self.assertFalse(rep["continuous"]); self.assertEqual(rep["gaps"][0]["count"], 3)
        self.assertEqual(rep["gaps"][0]["missing_from"], seg(1, 1, 2))

    def test_backup_label_and_partial_files_are_not_segments(self):
        n = seg(2, 0, 1); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, n + ".00000028.backup"), "w").write("x")
        open(os.path.join(self.wm.wal_dir, seg(2, 0, 7) + ".partial"), "w").write("x")
        rep = self.wm.verify_continuity(max_age=0)
        self.assertEqual(rep["total_segments"], 1); self.assertTrue(rep["continuous"])

    def test_per_timeline_contiguity(self):
        for tl, s in [(1, 1), (1, 2), (2, 2), (2, 3)]:                     # timeline 2 forks at segment 2: no gap across timelines
            n = seg(tl, 0, s); self.wm.archive_segment(self.mk(n), n)
        self.assertTrue(self.wm.verify_continuity(max_age=0)["continuous"])

    def test_failover_hole_between_timelines_is_a_gap(self):
        """the old primary died before archiving its last segment and the promoted standby never archives what it only received: nothing covers segment 3"""
        for tl, s in [(1, 1), (1, 2), (2, 4), (2, 5)]:                      # timeline 1 forked exactly at the start of segment 4 (0/400000 with 1 MB segments)
            n = seg(tl, 0, s); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, "00000002.history"), "w").write("1\t0/400000\tno recovery target specified\n")
        rep = self.wm.verify_continuity(max_age=0)
        self.assertFalse(rep["continuous"], rep)
        g = rep["gaps"][0]
        self.assertEqual((g["timeline"], g["missing_from"], g["count"]), (1, seg(1, 0, 3), 1), rep)
        n = seg(1, 0, 3); self.wm.archive_segment(self.mk(n), n)            # the segment is rescued: hole closed
        self.assertTrue(self.wm.verify_continuity(max_age=0)["continuous"])

    def test_fork_inside_a_segment_is_covered_by_the_new_timeline(self):
        for tl, s in [(1, 1), (2, 2), (2, 3)]:                              # fork mid-segment 2: only the NEW timeline has a complete copy of segment 2
            n = seg(tl, 0, s); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, "00000002.history"), "w").write("1\t0/280000\tno recovery target specified\n")
        self.assertTrue(self.wm.verify_continuity(max_age=0)["continuous"])

    def test_three_timelines_chain(self):
        for tl, s in [(1, 1), (1, 2), (2, 2), (2, 3), (3, 3), (3, 4)]:
            n = seg(tl, 0, s); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, "00000003.history"), "w").write("1\t0/200000\tx\n2\t0/380000\ty\n")
        self.assertTrue(self.wm.verify_continuity(max_age=0)["continuous"])


    def test_fork_exactly_at_a_segment_start_needs_nothing_of_it_on_the_old_timeline(self):
        """lab geo: timeline 6 ended at 0/23000000 (a segment boundary); segment 23 of timeline 6 does not exist and is not a hole"""
        for tl, s in [(1, 1), (1, 2), (1, 3), (2, 4), (2, 5)]:
            n = seg(tl, 0, s); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, "00000002.history"), "w").write("1\t0/400000\tno recovery target specified\n")
        self.assertTrue(self.wm.verify_continuity(max_age=0)["continuous"], self.wm.verify_continuity(max_age=0))

    def test_what_the_retention_removed_is_not_a_hole(self):
        """lab geo: the retention removed old WAL; leftovers re-archived below its floor made the console report 'holes' and ask for a new full backup"""
        for tl, s in [(1, 1), (1, 2), (2, 3), (2, 8), (2, 9)]:              # 4..7 removed by the retention (floor 8); 1..3 are leftovers below it
            n = seg(tl, 0, s); self.wm.archive_segment(self.mk(n), n)
        open(os.path.join(self.wm.wal_dir, "00000002.history"), "w").write("1\t0/300000\tno recovery target specified\n")
        self.assertFalse(self.wm.verify_continuity(max_age=0)["continuous"])
        self.wm.set_retention_floor(8)
        rep = self.wm.verify_continuity(max_age=0)
        self.assertTrue(rep["continuous"], rep); self.assertEqual(rep["below_retention_floor"], 3)
        self.assertNotIn(".retention_floor.json", self.wm.list_segments())

    def test_rescue_never_republishes_below_the_retention_floor(self):
        from pg_arca.wal_rescue import WalRescue
        pgwal = os.path.join(self.t, "pg_wal"); os.makedirs(pgwal)
        for s_ in (2, 3, 9):
            with open(os.path.join(pgwal, seg(1, 0, s_)), "wb") as f: f.write(b"z" * MB)
            os.utime(os.path.join(pgwal, seg(1, 0, s_)), (1, 1))
        self.wm.set_retention_floor(8)
        r = WalRescue(None, self.wm, {"state_dir": os.path.join(self.t, "st")}, min_age=0)
        out = r.pass_once(pgwal, in_recovery=False, cur_tli=2, cur_segno=10)
        self.assertEqual(out["published"], 1)                               # only segment 9: 2 and 3 were removed on purpose
        self.assertFalse(self.wm.has_segment(seg(1, 0, 2)))
        self.assertTrue(self.wm.has_segment(seg(1, 0, 9)))

    def test_two_writers_same_name_different_content_only_one_wins(self):
        """Two servers archive the same segment name with different content at the same moment (split-brain): exactly one succeeds, the other
        gets PGA-WAL-031, and the stored object's meta always describes the stored object (an independent review found the loser could
        overwrite the winner's meta when the meta was written before the object: both succeeded, every later retrieve failed)."""
        import threading
        n = seg(1, 0, 9)
        srcs = [self.mk(n, b"a"), None]
        d2 = os.path.join(self.t, "src2"); os.makedirs(d2); srcs[1] = os.path.join(d2, n)
        with open(srcs[1], "wb") as f: f.write(b"b" * MB)
        for _ in range(8):                                                       # repeated: the race window is small
            results = [None, None]
            def go(i):
                try: results[i] = ("ok",) + tuple(self.wm.archive_segment(srcs[i], n))
                except WalArchiveError as e: results[i] = ("err", e.code)
                except Exception as e:
                    import traceback; results[i] = ("exc", traceback.format_exc())
            ts = [threading.Thread(target=go, args=(i,)) for i in (0, 1)]
            for t in ts: t.start()
            for t in ts: t.join()
            oks = [r for r in results if r[0] == "ok"]; errs = [r for r in results if r[0] == "err"]
            self.assertEqual(len(oks), 1, results); self.assertEqual(len(errs), 1, results); self.assertEqual(errs[0][1], "PGA-WAL-031")
            out = os.path.join(self.t, "r9"); code, _ = self.wm.retrieve_segment(n, out)
            self.assertEqual(code, 0, "the stored segment verifies against its meta")
            self.assertEqual(open(out, "rb").read(), (b"a" if oks[0][3] == hashlib.sha256(b"a" * MB).hexdigest() else b"b") * MB)
            # reset for the next round
            for x in os.listdir(self.wm.wal_dir):
                px = os.path.join(self.wm.wal_dir, x)
                if x.startswith(n): os.unlink(px)
            for x in os.listdir(os.path.join(self.wm.wal_dir, "conflicts")): os.unlink(os.path.join(self.wm.wal_dir, "conflicts", x))


if __name__ == "__main__": unittest.main()


class DatabaseNamesTests(unittest.TestCase):
    """The oid->name registry kept next to the archive: written only on news, sealed when encrypted, read across previous locations,
    adopted when the archive moves."""

    def test_registry(self):
        root = tempfile.mkdtemp()
        old, new = os.path.join(root, "old"), os.path.join(root, "new")
        a = WalManager(old)
        self.assertTrue(a.note_databases([{"oid": 16384, "name": "shop"}, {"oid": 5, "name": "postgres"}]))
        self.assertFalse(a.note_databases([{"oid": 16384, "name": "shop"}]), "nothing new: no write")
        b = WalManager(new, previous=[old])
        self.assertEqual(b.database_names().get("16384"), "shop", "the previous location is read")
        b.note_databases([{"oid": 16384, "name": "shop2"}])
        self.assertEqual(b.database_names()["16384"], "shop2", "this location wins")
        self.assertEqual(WalManager(new).database_names(), {"16384": "shop2", "5": "postgres"}, "a write here carries what was read")
        other = os.path.join(root, "other")
        c = WalManager(other)
        c.note_databases([{"oid": 16384, "name": "shop3"}])
        self.assertEqual(c.adopt_database_names(old), 1, "only what is missing here is adopted")
        self.assertEqual(WalManager(other).database_names(), {"16384": "shop3", "5": "postgres"})
        self.assertFalse([n for n in os.listdir(new) if ".tmp." in n])
