"""Backup destination checks (mount type, write semantics, space, protection): the mount table is injected, the filesystem operations are real."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pg_arca.engine import destcheck
from pg_arca.engine.util import EngineError


def lv(res, cid):
    return [c["level"] for c in res["checks"] if c["id"] == cid]


class Mounts(unittest.TestCase):
    def test_longest_mountpoint_wins_and_escapes_are_decoded(self):
        t = [("/", "ext4", "/dev/vda"), ("/mnt/backup", "nfs4", "srv:/export"), ("/mnt/backup/archive disk", "xfs", "/dev/vdb")]
        self.assertEqual(destcheck.mount_of("/mnt/backup/pgarca", t)[1], "nfs4")
        self.assertEqual(destcheck.mount_of("/mnt/backup", t)[1], "nfs4")
        self.assertEqual(destcheck.mount_of("/mnt/backups", t)[1], "ext4", "a prefix of the NAME is not a parent directory")
        self.assertEqual(destcheck.mount_of("/var/lib", t)[1], "ext4")
        f = tempfile.NamedTemporaryFile("w", delete=False)
        f.write("36 35 98:0 / /mnt/my\\040share rw,relatime shared:1 - cifs //srv/share rw\n")
        f.close()
        self.assertEqual(destcheck.mounts(f.name), [("/mnt/my share", "cifs", "//srv/share")])


class Paths(unittest.TestCase):
    def setUp(self):
        self.t = os.path.realpath(tempfile.mkdtemp())

    def test_a_mounted_share_passes_and_the_probe_leaves_nothing(self):
        table = [("/", "ext4", "/dev/vda"), (self.t, "nfs4", "srv:/export")]
        r = destcheck.check_path("repo", os.path.join(self.t, "pgarca"), "nfs", True, 0.001, "main", table=table)
        self.assertTrue(r["ok"], r["checks"])
        self.assertEqual(lv(r, "fs"), ["ok"]); self.assertEqual(lv(r, "mount"), ["ok"]); self.assertEqual(lv(r, "write"), ["ok"])
        self.assertEqual([n for n in os.listdir(os.path.join(self.t, "pgarca"))], [], "probe file removed")
        self.assertEqual(r["mount"]["fstype"], "nfs4")

    def test_share_not_mounted_is_refused_and_NOTHING_is_created_on_the_local_disk(self):
        table = [("/", "ext4", "/dev/vda")]
        target = os.path.join(self.t, "mnt", "backup", "pgarca")
        r = destcheck.check_path("repo", target, "nfs", True, table=table)
        self.assertFalse(r["ok"])
        self.assertEqual(lv(r, "fs"), ["bad"]); self.assertEqual(lv(r, "mount"), ["bad"])
        self.assertFalse(os.path.exists(os.path.join(self.t, "mnt")), "must not create the directory on the root disk")
        self.assertIn("not mounted", [c for c in r["checks"] if c["id"] == "fs"][0]["text"])

    def test_smb_expects_cifs_and_warns_on_the_wrong_network_type(self):
        r = destcheck.check_path("repo", os.path.join(self.t, "r"), "smb", False, table=[("/", "ext4", "x"), (self.t, "nfs4", "s")])
        self.assertEqual(lv(r, "fs"), ["warn"]); self.assertTrue(r["ok"])

    def test_object_store_fuse_is_flagged(self):
        r = destcheck.check_path("repo", os.path.join(self.t, "r"), "local", False, table=[("/", "ext4", "x"), (self.t, "fuse.s3fs", "bucket")])
        self.assertEqual(lv(r, "fs"), ["warn"])
        self.assertIn("object store", r["checks"][0]["text"])

    def test_space_minimum_and_protected_overlap(self):
        r = destcheck.check_path("wal", os.path.join(self.t, "w"), "local", False, min_free_gb=10 ** 9, table=[("/", "ext4", "x")])
        self.assertEqual(lv(r, "space"), ["bad"]); self.assertFalse(r["ok"])
        data = os.path.join(self.t, "pgdata")
        os.makedirs(data)
        r = destcheck.check_path("repo", os.path.join(data, "backups"), "local", protected=[data], table=[("/", "ext4", "x")])
        self.assertEqual(lv(r, "protected"), ["bad"])
        r = destcheck.check_path("repo", self.t, "local", protected=[data], table=[("/", "ext4", "x")])
        self.assertEqual(lv(r, "protected"), ["bad"], "a directory that CONTAINS the data directory is refused too")

    def test_system_directories_and_relative_paths_are_refused(self):
        for bad in ("/etc/pgarca", "/usr/lib/x", "relative", "/a/../etc", "/"):
            r = destcheck.check_path("repo", bad, "local")
            self.assertFalse(r["ok"], bad)
            self.assertEqual(lv(r, "path"), ["bad"])

    def test_old_location_content_is_reported_not_moved(self):
        old = os.path.join(self.t, "old")
        os.makedirs(os.path.join(old, "stanza", "main", "backup", "20260101-000000F"))
        r = destcheck.check_path("repo", os.path.join(self.t, "new"), "local", stanza="main", current=old, table=[("/", "ext4", "x")])
        self.assertEqual(lv(r, "existing"), ["warn"])
        self.assertTrue(os.path.isdir(os.path.join(old, "stanza")), "untouched")

    def test_benchmark_is_a_measurement(self):
        r = destcheck.check_path("repo", os.path.join(self.t, "b"), "local", bench=True, table=[("/", "ext4", "x")])
        self.assertGreater(r["bench"]["write_mb_s"], 0); self.assertEqual(r["bench"]["mb"], 32)
        self.assertEqual(os.listdir(os.path.join(self.t, "b")), [])


class Destination(unittest.TestCase):
    def test_same_directory_and_unsupported_types_are_errors(self):
        t = tempfile.mkdtemp()
        with self.assertRaises(EngineError) as cm:
            destcheck.check_destination({"type": "local", "repo_path": t + "/x", "wal_path": t + "/x"})
        self.assertEqual(cm.exception.code, "PGA-DST-003")
        with self.assertRaises(EngineError) as cm:
            destcheck.check_destination({"type": "s3", "repo_path": t})
        self.assertEqual(cm.exception.code, "PGA-DST-001")
        with self.assertRaises(EngineError):
            destcheck.check_destination({"type": "local"})

    def test_both_paths_are_checked(self):
        t = tempfile.mkdtemp()
        r = destcheck.check_destination({"type": "local", "repo_path": t + "/repo", "wal_path": t + "/wal"})
        self.assertTrue(r["ok"]); self.assertEqual([p["kind"] for p in r["paths"]], ["repo", "wal"])


if __name__ == "__main__":
    unittest.main()
