"""WAL archive hardening against two writers on one archive (architecture review, scenarios S1..S8 of its simulation):
  S1  the old primary keeps archiving its timeline after another server promoted: the tail is detected (branch_tails)
  S2  the asynchronous spool never publishes a later segment of a timeline once an earlier one was refused (no mixed chain)
  S3  a dead pusher's provable dead-branch leftover does not block archive_command; anything else still does
  S4  a history file of ANOTHER database is refused like its segments (owner from pg_control / pg_wal)
  S5  an encrypted archive keeps its quarantined copies sealed; the executor retires a branch with the archive's key
  S6  a dead branch retired before a backup started is not a doubt for that backup (timeline number reused)
  S8  retire_branch never promotes one of several distinct unproven copies, and says per segment what it verified
  G12 every stored copy and every quarantined copy says which host / data directory / path wrote it."""
import hashlib
import json
import os
import shutil
import struct
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca import wal_spool, wal_archive
from pg_arca.wal_manager import WalManager, WalArchiveError

SEG = 1 << 20
SYSID = 7300000000000000001


def seg_bytes(tag, sysid=SYSID, tli=1):
    """A 1 MB segment that starts with a long page header of database `sysid`; its content is determined by `tag`."""
    hdr = struct.pack("<HHIQI", 0xD116, 0x0002, tli, 0, 0) + b"\0" * 4 + struct.pack("<QII", sysid, SEG, 8192)
    body = hashlib.sha256(tag.encode()).digest() * ((SEG - len(hdr)) // 32 + 1)
    return (hdr + body)[:SEG]


def sha(b):
    return hashlib.sha256(b).hexdigest()


def name(tli, n):
    return "%08X%08X%08X" % (tli, 0, n)


def put(d, nm, data):
    if not os.path.isdir(d):
        os.makedirs(d)
    p = os.path.join(d, nm)
    with open(p, "wb") as f:
        f.write(data)
    return p


class Env(object):
    def __init__(self, **kv):
        self.kv = kv

    def __enter__(self):
        self.old = dict((k, os.environ.get(k)) for k in self.kv)
        for k, v in self.kv.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def __exit__(self, *a):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(prefix="pgarca-branches-")
        self.cwd = os.getcwd()

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.t, ignore_errors=True)

    def wm(self, crypto=None, sub="arch"):
        return WalManager(os.path.join(self.t, sub), "none", segment_size=SEG, crypto=crypto)

    def arch(self, wm, src_dir, nm, data, **kw):
        p = put(src_dir, nm, data)
        return wm.archive_segment(p, nm, **kw)

    def stored_sha(self, wm, nm):
        return (wm._read_meta(nm) or {}).get("sha256")


class S1BranchTail(Base):
    def test_timeline_continued_after_its_promotion_point_is_reported(self):
        wm = self.wm()
        A, B = os.path.join(self.t, "A"), os.path.join(self.t, "B")
        for n in (1, 2):
            self.arch(wm, A, name(1, n), seg_bytes("shared%d" % n))
        self.arch(wm, B, "00000002.history", b"1\t0/350000\tno recovery target specified\n")        # B promoted inside segment 3
        self.arch(wm, B, name(1, 3) + ".partial", seg_bytes("B-partial3"))
        for n in (3, 4):
            self.arch(wm, B, name(2, n), seg_bytes("B%d" % n, tli=2))
        rep = wm.verify_continuity(max_age=0, current_timeline=2)
        self.assertEqual(rep["branch_tails"], [], "a normal failover leaves no tail")
        self.arch(wm, A, name(1, 3), seg_bytes("A-dead3"))          # the segment holding the fork point: normal, not counted
        self.assertEqual(wm.verify_continuity(max_age=0, current_timeline=2)["branch_tails"], [])
        for n in (4, 5):                                            # A never saw the promotion and goes on writing timeline 1
            self.arch(wm, A, name(1, n), seg_bytes("A-dead%d" % n))
        rep = wm.verify_continuity(max_age=0, current_timeline=2)
        self.assertEqual(rep["branch_tails"], [{"timeline": 1, "successor": 2, "fork_lsn": "0/350000", "count": 2, "first": name(1, 4), "last": name(1, 5)}])
        self.assertTrue(rep["continuous"], "detection only: the chain itself has no gap")
        # filed away from the console (wal_retire_branch tail=true): out of the archive's namespace, kept, the finding clears
        r = wm.retire_tail(1)
        self.assertEqual(sorted(x[:24] for x in r["retired"] if not x.endswith(".meta")), [name(1, 4), name(1, 5)])
        self.assertTrue(os.path.isfile(os.path.join(wm.wal_dir, "conflicts", "branch-tail-00000001", "RETIRED.json")))
        self.assertEqual(wm.verify_continuity(max_age=0, current_timeline=2)["branch_tails"], [])
        self.assertEqual([c for c in wm.conflicts() if c["name"].startswith(name(1, 4))], [], "not a divergent copy either")
        self.assertTrue(wm.has_segment(name(1, 3)), "the fork segment stays")

    def test_point_in_time_branch_from_an_earlier_point_is_not_a_tail(self):
        """Timeline 2 left timeline 1 at segment 6; a restore later branched timeline 3 from timeline 1 at segment 3. Timeline 1's segments
        up to 6 were written before any fork (timeline 2's history says so): only what follows the LATEST end of timeline 1 is a tail."""
        wm = self.wm()
        A = os.path.join(self.t, "A")
        for n in range(1, 7):
            self.arch(wm, A, name(1, n), seg_bytes("a%d" % n))
        self.arch(wm, A, "00000002.history", b"1\t0/650000\tno recovery target specified\n")
        self.arch(wm, A, "00000003.history", b"1\t0/350000\tbefore 2000-01-01\n")
        self.assertEqual(wm.verify_continuity(max_age=0)["branch_tails"], [])
        self.arch(wm, A, name(1, 7), seg_bytes("a7"))
        self.assertEqual([(x["timeline"], x["count"], x["first"]) for x in wm.verify_continuity(max_age=0)["branch_tails"]], [(1, 1, name(1, 7))])


class S2SpoolOrder(Base):
    def _setup(self, workers):
        wm = self.wm()
        A, B = os.path.join(self.t, "A_pg_wal"), os.path.join(self.t, "B_pg_wal")
        hist = b"1\t0/250000\tno recovery target specified\n"            # both promoted at the same point: identical history files
        self.arch(wm, B, "00000002.history", hist)
        self.arch(wm, B, name(2, 3), seg_bytes("B3", tli=2))
        spool = os.path.join(self.t, "A_spool")
        os.makedirs(spool)
        put(A, "00000002.history", hist)
        for n in (3, 4, 5):
            put(spool, name(2, n), seg_bytes("A%d" % n, tli=2))
        put(spool, name(3, 9), seg_bytes("A-t3", tli=3))                 # another timeline's queue is independent
        wm.pg_wal_dir = A
        return wm, A, B, spool, wal_spool.Pusher(wm, spool, workers=workers)

    def test_a_refused_segment_holds_back_the_rest_of_its_timeline(self):
        for workers in (1, 3):
            shutil.rmtree(self.t)
            os.makedirs(self.t)
            wm, A, B, spool, p = self._setup(workers)
            p.cycle()
            self.assertEqual(wal_spool.pending(spool), [name(2, n) for n in (3, 4, 5)], "workers=%d" % workers)
            self.assertFalse(wm.has_segment(name(2, 4)) or wm.has_segment(name(2, 5)), "nothing of A published after its refused segment 3")
            self.assertTrue(wm.has_segment(name(3, 9)), "timeline 3 is not held back by timeline 2")
            self.assertEqual((p.pushed, p.failed), (1, 1))
            self.arch(wm, B, name(2, 4), seg_bytes("B4", tli=2))            # the real primary goes on: its chain stays whole
            self.assertEqual(self.stored_sha(wm, name(2, 4)), sha(seg_bytes("B4", tli=2)))
            p._retry_at.clear()
            p.cycle()                                                     # still refused: and 5 still waits behind it
            self.assertFalse(wm.has_segment(name(2, 5)))
            p._retry_at[name(2, 3)] = time.time() + 100
            p.cycle()                                                     # while 3 waits for its retry, 4 and 5 are not even tried
            self.assertFalse(wm.has_segment(name(2, 5)))
            self.assertEqual(wal_spool.pending(spool), [name(2, n) for n in (3, 4, 5)])

    def test_parallel_workers_still_publish_in_order(self):
        wm = self.wm()
        spool = os.path.join(self.t, "spool")
        os.makedirs(spool)
        for n in range(1, 13):
            put(spool, name(1, n), seg_bytes("p%d" % n))
        p = wal_spool.Pusher(wm, spool, workers=4)
        self.assertEqual(p.cycle(), 12)
        self.assertEqual(wal_spool.pending(spool), [])
        at = [os.stat(os.path.join(wm.wal_dir, name(1, n))).st_ctime for n in range(1, 13)]        # ctime: set by the publishing link(2)
        self.assertEqual(wm.list_segments(), [name(1, n) for n in range(1, 13)])
        self.assertEqual(at, sorted(at), "published in name order")

    def test_spool_accepts_plain_segments_only(self):
        spool = os.path.join(self.t, "spool")
        p = wal_spool.Pusher(self.wm(), spool)
        p.heartbeat()
        src = os.path.join(self.t, "src")
        for nm in ("00000002.history", name(1, 3) + ".partial", name(1, 3) + ".00000028.backup"):
            self.assertFalse(wal_spool.accept(spool, put(src, nm, b"x"), nm), nm)
        self.assertTrue(wal_spool.accept(spool, put(src, name(1, 3), seg_bytes("x")), name(1, 3)))
        self.assertEqual(wal_spool.pending(spool), [name(1, 3)])


class S3DeadPusherDrain(Base):
    def _conf(self):
        state = os.path.join(self.t, "state")
        archdir = os.path.join(self.t, "arch")
        conf = os.path.join(self.t, "agent.conf")
        with open(conf, "w") as f:
            json.dump({"wal_archive_dir": archdir, "compression": "none", "wal_archive_async": True, "state_dir": state, "wal_segment_size": SEG}, f)
        sp = wal_spool.spool_dir(state)
        os.makedirs(sp)
        return conf, sp

    def test_leftover_on_the_current_timeline_still_blocks(self):
        conf, sp = self._conf()
        wm = self.wm()
        self.arch(wm, os.path.join(self.t, "other"), name(1, 7), seg_bytes("X7"))
        put(sp, name(1, 7), seg_bytes("Y7"))                               # a divergent leftover of THIS timeline: a person decides
        pg_wal = os.path.join(self.t, "pg_wal")
        with Env(PG_ARCA_CONF=conf, PG_ARCA_WAL_SEGSIZE=str(SEG), WAL_ARCHIVE_DIR=None, PG_ARCA_KEY_FILE=None, PG_ARCA_WAL_SYNC=None):
            self.assertEqual(wal_archive.main(["x", "archive", put(pg_wal, name(1, 8), seg_bytes("Y8")), name(1, 8)]), 1)
        self.assertEqual(wal_spool.pending(sp), [name(1, 7)])
        self.assertFalse(wm.has_segment(name(1, 8)))

    def test_provable_dead_branch_leftover_is_set_aside(self):
        conf, sp = self._conf()
        wm = self.wm()
        pg_wal = os.path.join(self.t, "pg_wal")
        for n in (1, 2, 3):
            self.arch(wm, pg_wal, name(1, n), seg_bytes("s%d" % n))
        put(pg_wal, "00000002.history", b"1\t0/450000\tno recovery target specified\n")    # this server left timeline 1 inside segment 4
        self.arch(wm, os.path.join(self.t, "other"), name(1, 6), seg_bytes("X6"))
        put(sp, name(1, 5), seg_bytes("Y5")[:SEG // 2 + 1])               # refused for another reason than a collision (not a WAL segment size)
        put(sp, name(1, 6), seg_bytes("Y6"))                              # collides: acknowledged by the archive itself (past this server's fork)
        put(sp, name(1, 3), seg_bytes("Z3")[:1000])                       # BEFORE the fork: on this server's history, never set aside
        with Env(PG_ARCA_CONF=conf, PG_ARCA_WAL_SEGSIZE=str(SEG), WAL_ARCHIVE_DIR=None, PG_ARCA_KEY_FILE=None, PG_ARCA_WAL_SYNC=None):
            rc = wal_archive.main(["x", "archive", put(pg_wal, name(2, 4), seg_bytes("T4", tli=2)), name(2, 4)])
            self.assertEqual(rc, 1, "the leftover on the shared history still blocks")
            os.unlink(os.path.join(sp, name(1, 3)))
            rc = wal_archive.main(["x", "archive", put(pg_wal, name(2, 4), seg_bytes("T4", tli=2)), name(2, 4)])
        self.assertEqual(rc, 0)
        self.assertEqual(wal_spool.pending(sp), [], "aside/ is not pending work")
        self.assertTrue(wm.has_segment(name(2, 4)))
        aside = os.path.join(sp, "aside")
        self.assertIn(name(1, 5), os.listdir(aside))
        with open(os.path.join(aside, name(1, 5) + ".json")) as f:
            why = json.load(f)
        self.assertEqual(why["name"], name(1, 5))
        self.assertIn("PGA-WAL-012", why["error"])
        self.assertIn("timeline 1 ended at 0/450000", why["reason"])
        self.assertEqual(self.stored_sha(wm, name(1, 6)), sha(seg_bytes("X6")), "the stored copy is never replaced")

    def test_pusher_sets_aside_the_same_leftovers(self):
        wm = self.wm()
        pg_wal = os.path.join(self.t, "pg_wal")
        put(pg_wal, name(2, 4), seg_bytes("T4", tli=2))
        put(pg_wal, "00000002.history", b"1\t0/450000\tno recovery target specified\n")
        spool = os.path.join(self.t, "spool")
        self.arch(wm, os.path.join(self.t, "other"), name(1, 6), seg_bytes("X6"))
        put(spool, name(1, 5), seg_bytes("Y5")[:SEG // 2 + 1])
        put(spool, name(1, 6), seg_bytes("Y6"))
        put(spool, name(2, 5), seg_bytes("T5", tli=2))
        wm.pg_wal_dir = pg_wal
        p = wal_spool.Pusher(wm, spool)
        p.cycle()
        self.assertEqual(wal_spool.pending(spool), [], "after the set-aside leftover, the next one of that timeline is judged too (acknowledged)")
        self.assertEqual(p.failed, 0)
        self.assertIsNone(p.last_error)
        self.assertTrue(wm.has_segment(name(2, 5)))
        self.assertEqual(self.stored_sha(wm, name(1, 6)), sha(seg_bytes("X6")))
        self.assertIn(name(1, 5), os.listdir(os.path.join(spool, "aside")))


class S4ForeignHistory(Base):
    def test_history_of_another_database_is_refused(self):
        wm = self.wm()
        self.arch(wm, os.path.join(self.t, "ours"), name(1, 1), seg_bytes("o1"))
        foreign_pgdata = os.path.join(self.t, "foreign")
        put(os.path.join(foreign_pgdata, "global"), "pg_control", struct.pack("=Q", 999) + b"\0" * 100)
        hp = put(os.path.join(foreign_pgdata, "pg_wal"), "00000002.history", b"1\t0/150000\tno recovery target specified\n")
        os.chdir(foreign_pgdata)                                         # PostgreSQL runs archive_command in its data directory
        with self.assertRaises(WalArchiveError) as cm:
            wm.archive_segment(hp, "00000002.history")
        self.assertEqual(cm.exception.code, "PGA-WAL-032")
        lp = put(os.path.join(foreign_pgdata, "pg_wal"), name(1, 1) + ".00000028.backup", b"START WAL LOCATION: 0/1000028\n")
        with self.assertRaises(WalArchiveError):
            wm.archive_segment(lp, name(1, 1) + ".00000028.backup")
        os.chdir(self.cwd)
        self.assertEqual(wm.list_histories(), [])
        # not run from a data directory: a segment next to the history file says which database wrote it
        fw = os.path.join(self.t, "foreign_wal")
        put(fw, name(2, 1), seg_bytes("f1", sysid=999, tli=2))
        with self.assertRaises(WalArchiveError):
            wm.archive_segment(put(fw, "00000002.history", b"1\t0/150000\tx\n"), "00000002.history")
        # our own database, from its data directory: accepted
        ours = os.path.join(self.t, "ours_pgdata")
        put(os.path.join(ours, "global"), "pg_control", struct.pack("=Q", SYSID) + b"\0" * 100)
        os.chdir(ours)
        self.assertTrue(wm.archive_segment(put(os.path.join(ours, "pg_wal"), "00000002.history", b"1\t0/150000\tx\n"), "00000002.history")[0])
        os.chdir(self.cwd)
        # nothing tells which database wrote it: accepted as before
        self.assertTrue(wm.archive_segment(put(os.path.join(self.t, "bare"), "00000003.history", b"2\t0/250000\tx\n"), "00000003.history")[0])


class S5EncryptedQuarantine(Base):
    def setUp(self):
        Base.setUp(self)
        try:
            from pg_arca.engine.crypt import generate_key, from_settings
            self.kf = os.path.join(self.t, "key")
            generate_key(self.kf)
            self.cr = from_settings(self.kf)
        except Exception as e:                                            # pragma: no cover
            self.skipTest("no crypto: %s" % e)

    def test_quarantined_copy_stays_sealed_and_the_executor_retires_with_the_key(self):
        wm = self.wm(crypto=self.cr)
        A, B = os.path.join(self.t, "A"), os.path.join(self.t, "B")
        self.arch(wm, A, name(2, 5), seg_bytes("A5", tli=2))
        with self.assertRaises(WalArchiveError):
            self.arch(wm, B, name(2, 5), seg_bytes("B5", tli=2))
        c = wm.conflicts()
        self.assertEqual(len(c), 1)
        qp = os.path.join(wm.wal_dir, "conflicts", c[0]["file"])
        with open(qp, "rb") as f:
            raw = f.read()
        self.assertNotEqual(raw, seg_bytes("B5", tli=2), "never plaintext WAL in an encrypted archive")
        self.assertEqual(self.cr.open(raw, "walq:" + name(2, 5)), seg_bytes("B5", tli=2))
        with open(qp + ".json") as f:
            side = json.load(f)
        self.assertEqual((side["sha256"], side["size"]), (sha(seg_bytes("B5", tli=2)), SEG))
        self.assertEqual(c[0]["size"], SEG, "the raw size, not the sealed file's")
        from pg_arca.executor import OperationExecutor
        ex = OperationExecutor({"wal_archive_dir": wm.wal_dir, "encryption_key_file": self.kf, "compression": "none", "state_dir": os.path.join(self.t, "state")}, None, None)
        rep = ex.h_wal_retire_branch({"timeline": 2, "confirm": "RETIRE"})
        self.assertEqual((rep["retired"], rep["promoted"], rep["skipped"]), ([name(2, 5)], [name(2, 5)], []), rep)
        self.assertFalse(rep["verified_against_primary"])
        self.assertEqual(rep["unverified"], [name(2, 5)])
        self.assertEqual(self.stored_sha(wm, name(2, 5)), sha(seg_bytes("B5", tli=2)))
        self.assertEqual(wm._read_meta(name(2, 5)).get("key_id"), self.cr.key_id, "promoted through the encrypted path")
        ok, _, _, msg = self.arch(wm, B, name(2, 5), seg_bytes("B5", tli=2))
        self.assertIn("identical", msg)
        out = os.path.join(self.t, "r")
        self.assertEqual(wm.retrieve_segment(name(2, 5), out)[0], 0)
        lst = ex.h_wal_conflicts({})
        self.assertEqual(lst["conflicts"], [])


class S6DoubtAfterRetire(Base):
    def _ctx(self, wm):
        class C(object):
            pass
        ctx = C()
        ctx.wal = wm
        return ctx

    def test_retired_dead_branch_is_not_a_doubt_for_a_later_backup(self):
        from pg_arca.engine.backup import _late_wal_doubt
        wm = self.wm()
        P, DR = os.path.join(self.t, "P"), os.path.join(self.t, "DR")
        for n in (1, 2):
            self.arch(wm, P, name(1, n), seg_bytes("s%d" % n))
        self.arch(wm, DR, "00000002.history", b"1\t0/250000\tno recovery target specified\n")
        for n in (2, 3, 4, 5):
            self.arch(wm, DR, name(2, n), seg_bytes("dr%d" % n, tli=2))
        for n in (3, 4, 5):
            self.arch(wm, P, name(1, n), seg_bytes("p%d" % n))
        before = time.time() - 60
        rep = wm.retire_abandoned(2, 1)
        with open(os.path.join(rep["dead_branch_dir"], "RETIRED.json")) as f:
            r = json.load(f)
        self.assertEqual(r["timeline"], 2)
        self.assertTrue(r["at"] > before and r.get("by"))
        time.sleep(0.01)
        self.arch(wm, P, "00000002.history", b"1\t0/450000\tno recovery target specified\n")    # a later real failover reuses 2
        for n in (4, 5, 6):
            self.arch(wm, P, name(2, n), seg_bytes("new%d" % n, tli=2))
        s = {"timeline": 2, "stop_lsn": "0/580000", "started_ts": time.time()}
        self.assertEqual(_late_wal_doubt(self._ctx(wm), s, [name(2, 5)]), "")
        self.assertIn("dead-branch-00000002", _late_wal_doubt(self._ctx(wm), dict(s, started_ts=before), [name(2, 5)]),
                      "a backup that started before the retirement may hold the dead branch's WAL")
        self.assertIn("dead-branch", _late_wal_doubt(self._ctx(wm), {"timeline": 2, "stop_lsn": "0/580000"}, [name(2, 5)]), "no start time: doubt")

    def test_a_timeline_number_retired_twice_keeps_both_sets_aside(self):
        wm = self.wm()
        P, DR = os.path.join(self.t, "P"), os.path.join(self.t, "DR")
        self.arch(wm, P, name(1, 1), seg_bytes("s1"))
        self.arch(wm, DR, "00000002.history", b"1\t0/150000\tno recovery target specified\n")
        self.arch(wm, DR, name(2, 2), seg_bytes("first", tli=2))
        first = wm.retire_abandoned(2, 1)
        self.arch(wm, DR, "00000002.history", b"1\t0/160000\tother\n")             # the number is used (and abandoned) a second time
        self.arch(wm, DR, name(2, 2), seg_bytes("second", tli=2))
        wm.retire_abandoned(2, 1)
        kept = sorted(os.listdir(first["dead_branch_dir"]))
        self.assertIn(name(2, 2), kept); self.assertIn(name(2, 2) + ".prev-1", kept)
        self.assertIn("00000002.history", kept); self.assertIn("00000002.history.prev-1", kept)
        with open(os.path.join(first["dead_branch_dir"], "00000002.history")) as f:
            self.assertIn("0/150000", f.read(), "the first retirement's copy is never overwritten")

    def test_copies_consumed_by_retire_branch_are_resolved_too(self):
        from pg_arca.engine.backup import _late_wal_doubt
        wm = self.wm()
        A, B = os.path.join(self.t, "A"), os.path.join(self.t, "B")
        self.arch(wm, A, name(3, 7), seg_bytes("A7", tli=3))
        with self.assertRaises(WalArchiveError):
            self.arch(wm, B, name(3, 7), seg_bytes("B7", tli=3))
        early = time.time() - 1
        self.assertIn("quarantine", _late_wal_doubt(self._ctx(wm), {"timeline": 3, "stop_lsn": "0/780000", "started_ts": time.time()}, [name(3, 7)]))
        rep = wm.retire_branch(3)
        self.assertEqual(rep["promoted"], [name(3, 7)])
        self.assertTrue(os.path.exists(os.path.join(rep["dead_branch_dir"], "RETIRED.json")))
        time.sleep(0.01)
        self.assertEqual(_late_wal_doubt(self._ctx(wm), {"timeline": 3, "stop_lsn": "0/780000", "started_ts": time.time()}, [name(3, 7)]), "")
        self.assertNotEqual(_late_wal_doubt(self._ctx(wm), {"timeline": 3, "stop_lsn": "0/780000", "started_ts": early}, [name(3, 7)]), "")


class S7S8RetireBranch(Base):
    def test_several_distinct_unproven_copies_are_not_promoted(self):
        wm = self.wm()
        A, B, C = (os.path.join(self.t, x) for x in "ABC")
        self.arch(wm, A, name(2, 3), seg_bytes("A3", tli=2))
        for who in (B, C):
            with self.assertRaises(WalArchiveError):
                self.arch(wm, who, name(2, 3), seg_bytes(os.path.basename(who) + "3", tli=2))
        surv = os.path.join(self.t, "survivor_pgdata")
        os.makedirs(os.path.join(surv, "pg_wal"))
        rep = wm.retire_branch(2, survivor_pgdata=surv)                   # the survivor's pg_wal no longer has the file: no proof
        self.assertEqual((rep["promoted"], rep["retired"]), ([], []))
        self.assertTrue(any(s["name"] == name(2, 3) and "2 distinct" in s["why"] for s in rep["skipped"]), rep["skipped"])
        self.assertEqual(self.stored_sha(wm, name(2, 3)), sha(seg_bytes("A3", tli=2)), "nothing changes without proof")
        self.assertEqual(len(wm.conflicts()), 2)
        put(os.path.join(surv, "pg_wal"), name(2, 3), seg_bytes("B3", tli=2))   # the survivor's own file proves which copy is its
        rep = wm.retire_branch(2, survivor_pgdata=surv)
        self.assertEqual((rep["promoted"], rep["verified"], rep["unverified"]), ([name(2, 3)], [name(2, 3)], []))
        self.assertEqual(self.stored_sha(wm, name(2, 3)), sha(seg_bytes("B3", tli=2)))
        self.assertEqual(wm.conflicts(), [])

    def test_executor_claims_verified_only_when_every_promotion_was(self):
        from pg_arca.executor import OperationExecutor
        wm = self.wm()
        A, B = os.path.join(self.t, "A"), os.path.join(self.t, "B")
        for n in (3, 4):
            self.arch(wm, A, name(2, n), seg_bytes("A%d" % n, tli=2))
            with self.assertRaises(WalArchiveError):
                self.arch(wm, B, name(2, n), seg_bytes("B%d" % n, tli=2))
        surv = os.path.join(self.t, "pgdata")
        put(os.path.join(surv, "pg_wal"), name(2, 4), seg_bytes("B4", tli=2))   # segment 3 is recycled already: unverified

        class Db(object):
            def ping(self):
                return True

            def run_psql(self, sql, **kw):
                return True, surv + "\n", ""
        ex = OperationExecutor({"wal_archive_dir": wm.wal_dir, "compression": "none", "state_dir": os.path.join(self.t, "state")}, Db(), None)
        rep = ex.h_wal_retire_branch({"timeline": 2, "confirm": "RETIRE"})
        self.assertEqual(sorted(rep["promoted"]), [name(2, 3), name(2, 4)])
        self.assertEqual((rep["verified"], rep["unverified"]), ([name(2, 4)], [name(2, 3)]))
        self.assertFalse(rep["verified_against_primary"], "segment 3 was promoted without proof")


class G12Writer(Base):
    def test_who_wrote_each_copy_is_recorded(self):
        import socket
        wm = self.wm()
        pgdata = os.path.join(self.t, "pgdata")
        os.makedirs(pgdata)
        os.chdir(pgdata)
        self.arch(wm, os.path.join(pgdata, "pg_wal"), name(1, 1), seg_bytes("a1"))
        os.chdir(self.cwd)
        w = wm._read_meta(name(1, 1))["writer"]
        self.assertEqual((w["host"], os.path.realpath(w["pgdata"]), w["via"]), (socket.gethostname(), os.path.realpath(pgdata), "archive_command"))
        spool = os.path.join(self.t, "spool")
        put(spool, name(1, 2), seg_bytes("a2"))
        wm.pg_wal_dir = os.path.join(pgdata, "pg_wal")
        wal_spool.Pusher(wm, spool).cycle()
        self.assertEqual(wm._read_meta(name(1, 2))["writer"]["via"], "spool")
        self.assertEqual(wm._read_meta(name(1, 2))["writer"]["pgdata"], pgdata)
        with self.assertRaises(WalArchiveError):
            self.arch(wm, os.path.join(self.t, "other"), name(1, 2), seg_bytes("b2"), via="rescue")
        c = wm.conflicts()[0]
        self.assertEqual(c["writer"]["via"], "rescue")
        self.assertEqual(c["stored_writer"]["via"], "spool")
        from pg_arca.executor import OperationExecutor
        ex = OperationExecutor({"wal_archive_dir": wm.wal_dir, "compression": "none", "state_dir": os.path.join(self.t, "state")}, None, None)
        got = ex.h_wal_conflicts({})["conflicts"][0]
        self.assertEqual((got["writer"]["via"], got["stored_writer"]["via"]), ("rescue", "spool"))


if __name__ == "__main__":
    unittest.main()


class S9ExpiredQuarantine(Base):
    """The lab case (17/10): 137 identical copies of 0000001A000000010000001B an older agent quarantined on every archive_command retry, the
    stored copy (and the successor timeline's) later removed by the retention: no recovery from a kept backup can read that range any more,
    yet verification failed forever ('divergent WAL copies') and retiring the branch found 'nothing stored under this name'."""

    def _setup(self):
        wm = self.wm()
        P = os.path.join(self.t, "P")
        for n in (1, 2, 3, 4, 5, 6):
            self.arch(wm, P, name(1, n), seg_bytes("s%d" % n))
        q = os.path.join(wm.wal_dir, "conflicts")
        os.makedirs(os.path.join(q, "reviewed"))
        old = seg_bytes("other", tli=1)
        sh = sha(old)[:12]
        for i, ts in enumerate((1791985661, 1791985670, 1791985678)):              # an older agent's retries: same content, timestamped names
            with open(os.path.join(q, "%s.%s.%d" % (name(1, 2), sh, ts)), "wb") as f:
                f.write(old)
        with open(os.path.join(q, "%s.%s.%d" % (name(1, 5), sh, 1)), "wb") as f:   # above the floor: still a real divergence
            f.write(old)
        with open(os.path.join(q, "reviewed", "%s.%s.%d" % (name(1, 3), sh, 1)), "wb") as f:
            f.write(old)
        with open(os.path.join(q, "00000002.history.%s.1" % sh), "w") as f:      # a history copy: never expired
            f.write("1\t0/100000\tx\n")
        return wm

    def test_copies_below_the_retention_floor_are_not_divergent(self):
        wm = self._setup()
        before = wm.verify_continuity(max_age=0)
        self.assertEqual(before["conflicts"], 3, "segment 2 (one content), segment 5, the history")
        for n in (1, 2, 3):
            wm.remove_segment(name(1, n))
        wm.set_retention_floor(4, "0/400000")                                      # what the retention writes after removing 1..3
        kinds = {(c["name"], c["kind"]) for c in wm.classify_conflicts(None)}
        self.assertIn((name(1, 2), "expired"), kinds)
        self.assertIn((name(1, 5), "divergent"), kinds, "above the floor nothing is relieved")
        self.assertIn(("00000002.history", "divergent"), kinds)
        after = wm.verify_continuity(max_age=0)
        self.assertEqual(after["conflicts"], 2); self.assertEqual(after["conflicts_expired"], 1)

    def test_retention_tidies_the_quarantine(self):
        wm = self._setup()
        for n in (1, 2, 3):
            wm.remove_segment(name(1, n))
        wm.set_retention_floor(4, "0/400000")
        r = wm.tidy_quarantine()
        self.assertEqual(r["expired"], 4, "three copies of segment 2 and the reviewed copy of segment 3")
        left = sorted(os.listdir(os.path.join(wm.wal_dir, "conflicts")))
        self.assertIn("00000002.history.%s.1" % sha(seg_bytes("other", tli=1))[:12], left)
        self.assertTrue(any(f.startswith(name(1, 5)) for f in left))
        self.assertFalse(any(f.startswith(name(1, 2)) for f in left))

    def test_identical_retries_collapse_to_one(self):
        wm = self._setup()                                                         # no retention floor: nothing expires, duplicates go
        r = wm.tidy_quarantine()
        self.assertEqual((r["expired"], r["duplicates"]), (0, 2))
        left = [f for f in os.listdir(os.path.join(wm.wal_dir, "conflicts")) if f.startswith(name(1, 2))]
        self.assertEqual(left, ["%s.%s.1791985661" % (name(1, 2), sha(seg_bytes("other", tli=1))[:12])], "the oldest copy is kept")
