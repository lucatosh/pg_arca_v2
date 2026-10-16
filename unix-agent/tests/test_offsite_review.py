"""Offsite copy, encryption and destination changes (independent review, 16/10 night), without PostgreSQL: a download cut short never lands, an
immutable object is never re-uploaded over the bucket's copy, a file removed during a cycle does not end it, the mirror waits for a rehydrate,
two clusters on one prefix are refused, the WAL archive holds one key, the database-name registry is never rewritten from what could not be
read, a previous location written with another key is not offered for reading."""
import io
import json
import os
import shutil
import struct
import tempfile
import time
import unittest

from pg_arca import offsite, s3
from pg_arca.engine import crypt
from pg_arca.engine.repo import Repo
from pg_arca.wal_manager import WalManager, WalArchiveError
from tests.fake_s3 import FakeS3

SEG = 16 * 1024 * 1024


def segment(path, sysid=7000000000000000001):
    hdr = struct.pack("<HHIQII", 0xD116, 0x0002, 1, 0, 0, 0) + struct.pack("<QII", sysid, SEG, 8192)
    with open(path, "wb") as f:
        f.write(hdr + b"\0" * (SEG - len(hdr)))
    return path


class Downloads(unittest.TestCase):
    def test_a_download_cut_short_is_refused(self):
        class Resp(object):
            def __init__(self):
                self.b = io.BytesIO(b"x" * 1000)

            def getheader(self, k):
                return "2000" if k == "content-length" else None

            def read(self, n):
                return self.b.read(n)

            def close(self):
                pass
        c = s3.S3Client("http://127.0.0.1:1", "bk", "a", "s")
        c._req = lambda *a, **k: Resp()
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "x.pack")
            with self.assertRaises(s3.S3Error):
                c.get_to_file("repo/cas/packs/x.pack", p)
            self.assertFalse(os.path.exists(p))
            self.assertFalse(os.path.exists(p + ".part"))
            Resp.getheader = lambda self, k: None
            with self.assertRaises(s3.S3Error):
                c.get_to_file("repo/cas/packs/x.pack", p, expect_size=2000)       # no Content-Length: the listed size decides
            c.get_to_file("repo/cas/packs/x.pack", p, expect_size=1000)
            self.assertEqual(os.path.getsize(p), 1000)
        finally:
            shutil.rmtree(d)

    def test_immutable_objects_are_never_uploaded_over_the_bucket(self):
        up, _down = offsite.plan({"repo/cas/packs/a.pack": 100, "wal/000000010000000000000001": 5, "repo/stanza/m/backup/F/meta.json": 10,
                                  "repo/stanza/m/backup/F/manifest.json.z": 7},
                                 {"repo/cas/packs/a.pack": 200, "wal/000000010000000000000001": 9, "repo/stanza/m/backup/F/meta.json": 12,
                                  "repo/stanza/m/backup/F/manifest.json.z": 8})
        self.assertEqual(up, ["repo/stanza/m/backup/F/meta.json"], "only the set's status file changes")

    def test_a_vanished_file_is_a_file_error(self):
        c = s3.S3Client("http://127.0.0.1:1", "bk", "a", "s")
        with self.assertRaises((IOError, OSError)):
            c.put("repo/cas/packs/gone.pack", "/nonexistent/gone.pack")


class Mirror(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = FakeS3()

    @classmethod
    def tearDownClass(cls):
        cls.srv.close()

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.repo_path, self.wal, self.state = os.path.join(self.d, "repo"), os.path.join(self.d, "wal"), os.path.join(self.d, "state")
        os.makedirs(self.wal)
        Repo(self.repo_path, "main", algo="zlib").init()
        self.cfg = {"repo_path": self.repo_path, "wal_archive_dir": self.wal, "state_dir": self.state,
                    "offsite": {"type": "s3", "endpoint": self.srv.endpoint, "bucket": "bk", "prefix": "p%d" % int(time.time() * 1e6), "access_key": "AKTEST", "secret_key": "s"}}
        self.m = offsite.Mirror(self.cfg, self.state)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_the_mirror_waits_for_a_rehydrate(self):
        lk = self.m._lock(block=True, who="rehydrate")
        try:
            st = self.m.sync()
            self.assertTrue(st.get("skipped") and st.get("busy") == "rehydrate", st)
            with self.assertRaises(s3.S3Error):
                self.m.sync(force=True)                  # asked by a person: said, never a stale "ok"
            with self.assertRaises(s3.S3Error):
                self.m._lock(block=True, cancel=lambda: True)      # a waiting rehydrate can be cancelled
        finally:
            self.m._unlock(lk)
        self.assertTrue(self.m.sync(force=True).get("ok"))

    def test_a_prefix_of_another_database_is_refused(self):
        json.dump({"system_identifier": "111"}, open(os.path.join(self.wal, "ARCHIVE_OWNER.json"), "w"))
        self.assertTrue(self.m.sync(force=True).get("ok"))
        json.dump({"system_identifier": "222"}, open(os.path.join(self.wal, "ARCHIVE_OWNER.json"), "w"))
        st = self.m.sync(force=True)
        self.assertFalse(st.get("ok"))
        self.assertIn("another database", st.get("last_error") or "")


class ArchiveKey(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.wal = os.path.join(self.d, "wal")
        self.pgwal = os.path.join(self.d, "pg_wal")
        os.makedirs(self.pgwal)
        self.k1 = crypt.from_settings(crypt.generate_key(os.path.join(self.d, "k1")))
        self.k2 = crypt.from_settings(crypt.generate_key(os.path.join(self.d, "k2")))

    def tearDown(self):
        shutil.rmtree(self.d)

    def test_one_key_per_archive(self):
        WalManager(self.wal, "none", crypto=self.k1).archive_segment(segment(os.path.join(self.pgwal, "000000010000000000000001")), "000000010000000000000001")
        for other in (None, self.k2):
            with self.assertRaises(WalArchiveError) as e:
                WalManager(self.wal, "none", crypto=other).archive_segment(segment(os.path.join(self.pgwal, "000000010000000000000002")), "000000010000000000000002")
            self.assertIn("PGA-WAL-037", str(e.exception))
        self.assertEqual(WalManager(self.wal, "none").archive_key(), self.k1.key_id)

    def test_an_existing_archive_is_recognised_by_its_segments(self):
        WalManager(self.wal, "none", crypto=self.k1).archive_segment(segment(os.path.join(self.pgwal, "000000010000000000000001")), "000000010000000000000001")
        os.unlink(os.path.join(self.wal, "ARCHIVE_KEY.json"))                     # an archive of an earlier version
        with self.assertRaises(WalArchiveError):
            WalManager(self.wal, "none").archive_segment(segment(os.path.join(self.pgwal, "000000010000000000000002")), "000000010000000000000002")
        self.assertEqual(WalManager(self.wal, "none").archive_key(), self.k1.key_id)

    def test_database_names_are_not_rewritten_from_an_unreadable_registry(self):
        w1 = WalManager(self.wal, "none", crypto=self.k1)
        os.makedirs(self.wal, exist_ok=True)
        w1.note_databases([{"oid": 16384, "name": "sales"}])
        before = open(os.path.join(self.wal, WalManager.DBNAMES), "rb").read()
        w2 = WalManager(self.wal, "none", crypto=self.k2)                        # another key: cannot read it
        self.assertFalse(w2.note_databases([{"oid": 16385, "name": "other"}]))
        self.assertEqual(open(os.path.join(self.wal, WalManager.DBNAMES), "rb").read(), before)
        self.assertEqual(WalManager(self.wal, "none", crypto=self.k1).database_names(), {"16384": "sales"})


class PreviousLocation(unittest.TestCase):
    def test_a_previous_location_with_another_setting_is_not_read(self):
        d = tempfile.mkdtemp()
        try:
            k = crypt.from_settings(crypt.generate_key(os.path.join(d, "k")))
            Repo(os.path.join(d, "old"), "main", algo="zlib").init()                 # plain
            r = Repo(os.path.join(d, "new"), "main", algo="zlib", crypto=k, previous=[os.path.join(d, "old")])
            self.assertEqual(r.previous, [])
            self.assertIn("not encrypted", list(r.unreadable_previous.values())[0])
            r2 = Repo(os.path.join(d, "new2"), "main", algo="zlib", previous=[os.path.join(d, "old")])
            self.assertEqual(r2.previous, [os.path.realpath(os.path.join(d, "old"))])
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
