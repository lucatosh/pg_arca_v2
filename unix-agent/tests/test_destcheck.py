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

    def test_the_share_must_come_from_the_chosen_backup_server(self):
        table = [("/", "ext4", "/dev/vda"), (self.t, "nfs4", "bk1.example.lan:/export/pgarca")]
        ok = destcheck.check_path("repo", os.path.join(self.t, "r"), "nfs", True, table=table, expect_server={"name": "bk1", "hosts": ["bk1", "10.0.0.9"]})
        self.assertTrue(ok["ok"], ok["checks"]); self.assertEqual(lv(ok, "server"), ["ok"], "short name of the FQDN matches")
        wrong = destcheck.check_path("repo", os.path.join(self.t, "w"), "nfs", True, table=table, expect_server={"name": "bk2", "hosts": ["bk2", "10.0.0.10"]})
        self.assertFalse(wrong["ok"]); self.assertEqual(lv(wrong, "server"), ["bad"])
        self.assertFalse(os.path.exists(os.path.join(self.t, "w")), "nothing created on a share from the wrong server")
        ip = destcheck.check_path("repo", os.path.join(self.t, "i"), "nfs", True, table=[("/", "ext4", "x"), (self.t, "nfs", "[fd00::9]:/x")],
                                  expect_server={"name": "bk1", "hosts": ["fd00::9"]})
        self.assertEqual(lv(ip, "server"), ["ok"])
        smb = destcheck.check_path("repo", os.path.join(self.t, "s"), "smb", False, table=[("/", "ext4", "x"), (self.t, "cifs", "//BK1/backup")],
                                   expect_server={"name": "bk1", "hosts": ["bk1"]})
        self.assertEqual(lv(smb, "server"), ["ok"], "case-insensitive")
        self.assertEqual(destcheck.remote_host("/dev/sdb1"), None)
        # addresses are never shortened, names from two different domains never match
        self.assertFalse(destcheck._same_server("10.0.0.50", ["10.0.0.9"]))
        self.assertFalse(destcheck._same_server("192.168.5.5", ["192.168.1.9", "bk1"]))
        self.assertFalse(destcheck._same_server("bk1.other.org", ["bk1.lan"]))
        self.assertFalse(destcheck._same_server("bk1.other.org", ["bk1", "bk1.lan"]), "the server has an FQDN of its own")
        self.assertTrue(destcheck._same_server("bk1.any.org", ["bk1"]), "known by its short name only")
        self.assertTrue(destcheck._same_server("bk1.lan", ["bk1"])); self.assertTrue(destcheck._same_server("bk1", ["bk1.lan"]))
        self.assertTrue(destcheck._same_server("::ffff:10.0.0.9", ["10.0.0.9"]))

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


WAL_TOOL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pg-arca-wal")


class Identities(unittest.TestCase):
    """Two writers: the agent and the PostgreSQL server (archive_command). The server side is run here with runuser as another OS user, exactly the
    command PostgreSQL runs through COPY ... TO PROGRAM."""
    def setUp(self):
        self.t = os.path.realpath(tempfile.mkdtemp())
        os.chmod(self.t, 0o755)

    def _as(self, user):
        import shlex
        import subprocess

        def run(sql):
            cmd = sql.split("TO PROGRAM '", 1)[1].rsplit("'", 1)[0].replace("''", "'")
            r = subprocess.run(["runuser", "-u", user, "--", "sh", "-c", cmd], input=b"1\n", stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return r.returncode == 0, r.stdout.decode(), r.stderr.decode()
        return run

    @unittest.skipUnless(os.geteuid() == 0, "needs root to act as two OS users")
    def test_server_user_that_cannot_write_is_refused_and_a_shared_group_fixes_it(self):
        import subprocess
        d = os.path.join(self.t, "wal")
        os.makedirs(d, mode=0o700)                     # the agent's (root's) private directory: the server user 'nobody' cannot get in
        r = destcheck.server_probe(self._as("nobody"), WAL_TOOL, d)
        self.assertEqual([c["level"] for c in r["checks"] if c["id"] == "server_write"], ["bad"], r)
        self.assertIn("cannot write", r["checks"][0]["text"])
        subprocess.run(["groupadd", "-f", "pgarcatest"], check=True)
        subprocess.run(["usermod", "-aG", "pgarcatest", "nobody"], check=True)
        os.chown(d, 0, int(subprocess.check_output(["getent", "group", "pgarcatest"]).decode().split(":")[2]))
        os.chmod(d, 0o2770)
        r = destcheck.server_probe(self._as("nobody"), WAL_TOOL, d)
        self.assertEqual({c["id"]: c["level"] for c in r["checks"]}, {"server_write": "ok", "server_read": "ok"}, r)
        self.assertEqual(r["server"]["user"], "nobody")
        self.assertEqual([n for n in os.listdir(d)], [], "both probe files removed")
        cmds = destcheck.fix_commands(d, destcheck.identity(), r["server"])
        self.assertTrue(any("2770" in c and "pgarca" in c for c in cmds), cmds)

    def test_same_user_gets_a_private_directory(self):
        me = destcheck.identity()
        self.assertEqual(destcheck.fix_commands("/srv/b", me, dict(me)), ["install -d -m 0700 -o %s -g %s '/srv/b'" % (me["user"], me["group"])])
        self.assertTrue(any("all_squash" in c for c in destcheck.fix_commands("/srv/b", me, network="nfs")))

    def test_world_readable_backups_are_flagged(self):
        d = os.path.join(self.t, "repo")
        os.makedirs(d)
        os.chmod(d, 0o755)
        r = destcheck.check_path("repo", d, table=[("/", "ext4", "/dev/vda")])
        self.assertEqual(lv(r, "perm"), ["warn"])
        os.chmod(d, 0o700)
        r = destcheck.check_path("repo", d, table=[("/", "ext4", "/dev/vda")])
        self.assertEqual(lv(r, "perm"), ["ok"])
        self.assertEqual(r["identity"]["dir_mode"], "0700")

    def test_wal_archive_of_another_cluster_is_refused(self):
        from pg_arca.wal_manager import WalManager
        d = os.path.join(self.t, "wal")
        os.makedirs(d, mode=0o700)
        WalManager(d)._check_owner("111")                      # what the archive itself writes on its first segment
        r = destcheck.check_path("wal", d, table=[("/", "ext4", "/dev/vda")], owner={"system_identifier": "222"})
        self.assertEqual(lv(r, "wal_owner"), ["bad"]); self.assertFalse(r["ok"])
        r = destcheck.check_path("wal", d, table=[("/", "ext4", "/dev/vda")], owner={"system_identifier": "111"})
        self.assertEqual(lv(r, "wal_owner"), ["ok"])

    def test_soft_nfs_mount_option_is_flagged(self):
        f = tempfile.NamedTemporaryFile("w", delete=False)
        f.write("36 35 0:50 / /mnt/b rw,relatime shared:1 - nfs4 srv:/x rw,vers=4.2,soft,proto=tcp\n")
        f.close()
        self.assertIn("soft", destcheck.mount_options("/mnt/b", f.name))
        self.assertEqual(destcheck.mount_options("/mnt/other", f.name), set())


if __name__ == "__main__":
    unittest.main()
