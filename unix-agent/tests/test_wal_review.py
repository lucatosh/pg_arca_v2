"""WAL archive path (independent review 16/10 night): restore_command never says "end of archive" for an error, archive_command never archives with
a configuration it could not read nor into a share that is not mounted, a different .partial does not block the archiver, a dead spool pusher
does not leave a hole."""
import json
import os
import shutil
import struct
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca import wal_archive, wal_spool
from pg_arca.wal_manager import WalManager, WalArchiveError, OWNER_FILE

SEG = 16 * 1024 * 1024


def segment(path, sysid=7000000000000000001, fill=b"\0"):
    """A file that looks like a WAL segment (long page header with the system identifier)."""
    hdr = struct.pack("<HHIQII", 0xD116, 0x0002, 1, 0, 0, 0) + struct.pack("<QII", sysid, SEG, 8192)
    with open(path, "wb") as f:
        f.write(hdr + fill * (SEG - len(hdr)))
    return path


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


class RestoreCommand(unittest.TestCase):
    def test_missing_archive_aborts_recovery_instead_of_ending_it(self):
        d = tempfile.mkdtemp()
        with Env(WAL_ARCHIVE_DIR=os.path.join(d, "not-mounted", "wal"), PG_ARCA_CONF="/nonexistent", PG_ARCA_SPOOL=None):
            self.assertEqual(wal_archive.main(["x", "get", "000000010000000000000003", os.path.join(d, "p")]), 126)
        self.assertFalse(os.path.exists(os.path.join(d, "not-mounted")), "restore_command never creates an archive")

    def test_a_standby_is_never_aborted_by_an_archive_error(self):
        d = tempfile.mkdtemp(); pgdata = tempfile.mkdtemp()
        open(os.path.join(pgdata, "standby.signal"), "w").close()
        cwd = os.getcwd(); os.chdir(pgdata)
        try:
            with Env(WAL_ARCHIVE_DIR=os.path.join(d, "not-mounted"), PG_ARCA_CONF="/nonexistent", PG_ARCA_SPOOL=None):
                self.assertEqual(wal_archive.main(["x", "get", "000000010000000000000003", os.path.join(d, "p")]), 1, "streaming goes on")
        finally:
            os.chdir(cwd)

    def test_existing_archive_without_the_segment_is_end_of_archive(self):
        d = tempfile.mkdtemp()
        with Env(WAL_ARCHIVE_DIR=d, PG_ARCA_CONF="/nonexistent", PG_ARCA_SPOOL=None):
            self.assertEqual(wal_archive.main(["x", "get", "000000010000000000000003", os.path.join(d, "p")]), 1)


class ArchiveConf(unittest.TestCase):
    def test_unreadable_default_config_fails_the_archive(self):
        d = tempfile.mkdtemp()
        bad = os.path.join(d, "agent.conf")
        with open(bad, "w") as f:
            f.write('{"wal_archive_dir": "/x", ')               # half-written
        real = wal_archive.DEFAULT_CONF
        wal_archive.DEFAULT_CONF = bad
        try:
            with Env(PG_ARCA_CONF=None, WAL_ARCHIVE_DIR=None):
                with self.assertRaises(wal_archive.ConfError):
                    wal_archive._settings()
            wal_archive.DEFAULT_CONF = os.path.join(d, "missing.conf")
            with Env(PG_ARCA_CONF=None, WAL_ARCHIVE_DIR=None):
                self.assertEqual(wal_archive._settings()[0], "/var/lib/pgarca/wal", "no configuration at all: the defaults")
        finally:
            wal_archive.DEFAULT_CONF = real


class Archive(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.wal = os.path.join(self.d, "wal")
        self.pgwal = os.path.join(self.d, "pg_wal")
        os.makedirs(self.pgwal)
        self.known = os.path.join(self.d, "wal_archives.json")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_a_known_archive_found_empty_is_not_written(self):
        wm = WalManager(self.wal, "none", known_file=self.known)
        wm.archive_segment(segment(os.path.join(self.pgwal, "000000010000000000000001")), "000000010000000000000001")
        self.assertTrue(json.load(open(self.known)))
        shutil.rmtree(self.wal); os.makedirs(self.wal)              # the share is not mounted: the bare mount point
        wm2 = WalManager(self.wal, "none", known_file=self.known)
        with self.assertRaises(WalArchiveError) as e:
            wm2.archive_segment(segment(os.path.join(self.pgwal, "000000010000000000000002")), "000000010000000000000002")
        self.assertIn("PGA-WAL-096", str(e.exception))
        self.assertFalse(os.path.exists(os.path.join(self.wal, "000000010000000000000002")))
        other = os.path.join(self.d, "new-archive")                 # a NEW archive (destination changed) is created as before
        WalManager(other, "none", known_file=self.known).archive_segment(os.path.join(self.pgwal, "000000010000000000000002"), "000000010000000000000002")

    def test_a_different_partial_is_acknowledged_and_kept(self):
        wm = WalManager(self.wal, "none")
        a = segment(os.path.join(self.d, "a.partial"), fill=b"\1")
        b = segment(os.path.join(self.d, "b.partial"), fill=b"\2")
        wm.archive_segment(a, "000000010000000000000005.partial")
        ok, _dest, _sha, msg = wm.archive_segment(b, "000000010000000000000005.partial")
        self.assertTrue(ok); self.assertIn("never reads", msg)
        self.assertTrue(os.listdir(os.path.join(self.wal, "conflicts")), "the other copy is kept")

    def test_dead_pusher_spool_is_archived_first(self):
        state = os.path.join(self.d, "state"); sp = wal_spool.spool_dir(state); os.makedirs(sp)
        segment(os.path.join(sp, "000000010000000000000001"))
        segment(os.path.join(sp, "000000010000000000000002"))
        conf = os.path.join(self.d, "agent.conf")
        json.dump({"wal_archive_dir": self.wal, "compression": "none", "wal_archive_async": True, "state_dir": state}, open(conf, "w"))
        src = segment(os.path.join(self.pgwal, "000000010000000000000003"))
        with Env(PG_ARCA_CONF=conf, WAL_ARCHIVE_DIR=None, PG_ARCA_WAL_SYNC=None):
            self.assertEqual(wal_archive.main(["x", "archive", src, "000000010000000000000003"]), 0)
        names = sorted(n for n in os.listdir(self.wal) if n.startswith("0000") and not n.endswith(".meta"))
        self.assertEqual(names, ["000000010000000000000001", "000000010000000000000002", "000000010000000000000003"], "no hole")
        self.assertEqual(wal_spool.pending(sp), [])


if __name__ == "__main__":
    unittest.main()
