"""Portability review (16/10 night): the agent on hosts that are not "systemd Linux with Python 3.7+ in a UTF-8 locale" - Python 3.6 in the C locale,
LATIN1 configuration files, no /proc (FreeBSD), BSD/busybox userlands, packages built from a checkout with loose modes. No PostgreSQL needed."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)


class Encoding(unittest.TestCase):
    def test_config_rewrite_keeps_foreign_bytes_in_the_c_locale(self):
        d = tempfile.mkdtemp()
        try:
            conf = os.path.join(d, "postgresql.conf")
            raw = b"# r\xe9glages (latin1)\n# r\xc3\xa9glages (utf-8)\nshared_preload_libraries = 'pg_stat_statements'\narchive_command = 'x'\nwork_mem = 4MB\n"
            open(conf, "wb").write(raw)
            code = ("import sys; sys.path.insert(0, %r)\nfrom pg_arca.engine.ephemeral import quarantine_config\n"
                    "quarantine_config(%r, {}, 55555, '/tmp/s', 'true')\n") % (HERE, d)
            env = dict(os.environ, LC_ALL="C", LANG="C", PYTHONIOENCODING="")
            env.pop("PYTHONUTF8", None)
            r = subprocess.run([sys.executable, "-X", "utf8=0", "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            self.assertEqual(r.returncode, 0, r.stderr.decode("utf-8", "replace")[-800:])
            out = open(conf, "rb").read()
            self.assertIn(b"# r\xe9glages (latin1)\n", out, "LATIN1 bytes written back as they were")
            self.assertIn(b"# r\xc3\xa9glages (utf-8)\n", out)
            self.assertIn(b"# [pg_arca quarantine] archive_command", out)
        finally:
            shutil.rmtree(d)


class NoProc(unittest.TestCase):
    @unittest.skipUnless(shutil.which("ps"), "no ps on this system (slim container): the fallback has nothing to read")
    def test_processes_through_ps(self):
        from pg_arca import procs
        real = procs.HAVE_PROC
        procs.HAVE_PROC = False
        try:
            argv = procs.cmdline(os.getpid())
            self.assertTrue(argv and "python" in os.path.basename(argv[0]), argv)
            self.assertFalse(procs.is_postmaster(os.getpid()))
            self.assertEqual(procs.cmdline(4194303), [])
            self.assertFalse(procs.is_postmaster(4194303))
        finally:
            procs.HAVE_PROC = real

    def test_a_restored_copy_that_cannot_be_identified_counts_as_running(self):
        from pg_arca import procs
        from pg_arca.engine import restored
        d = tempfile.mkdtemp()
        real = procs.is_postmaster
        try:
            open(os.path.join(d, "postmaster.pid"), "w").write("%d\n" % os.getpid())
            procs.is_postmaster = lambda pid: None
            self.assertEqual(restored._alive({"dest": d}), os.getpid(), "never deleted under a postmaster it cannot see")
            procs.is_postmaster = lambda pid: False
            self.assertIsNone(restored._alive({"dest": d}))
        finally:
            procs.is_postmaster = real
            shutil.rmtree(d)

    def test_mounts_from_the_mount_command(self):
        from pg_arca.engine import destcheck
        real = subprocess.run

        class R(object):
            stdout = ("/dev/ada0p2 on / (ufs, local, journaled soft-updates)\n"
                      "nas:/export/wal on /mnt/wal (nfs, nfsv4acls)\n"
                      "//guest@srv/share on /mnt/smb type cifs (rw,relatime)\n")
        subprocess.run = lambda *a, **k: R()
        try:
            t = destcheck._mount_command()
        finally:
            subprocess.run = real
        self.assertIn(("/mnt/wal", "nfs", "nas:/export/wal"), t)
        self.assertIn(("/mnt/smb", "cifs", "//guest@srv/share"), t)
        self.assertEqual(destcheck.mount_of("/mnt/wal/x", t)[1], "nfs")


class Installer(unittest.TestCase):
    def test_no_gnu_only_or_linux_only_idioms(self):
        src = open(os.path.join(HERE, "install-agent.sh")).read()
        for bad in ("stat -c", "root:root", "-g root", "useradd --system --create-home --home-dir /var/lib/pgarca --shell /bin/bash pgarca ||"):
            self.assertNotIn(bad, src)
        self.assertEqual(subprocess.run(["bash", "-n", os.path.join(HERE, "install-agent.sh")]).returncode, 0)
        self.assertIn("openrc-run", src)
        self.assertIn("/usr/local/etc/rc.d/", src)

    def test_release_build_normalises_modes(self):
        f = os.path.join(os.path.dirname(HERE), "tools", "release", "build.sh")
        if not os.path.exists(f):
            self.skipTest("agent tested outside the repository (no tools/release/build.sh)")
        b = open(os.path.join(os.path.dirname(HERE), "tools", "release", "build.sh")).read()
        self.assertIn("norm_modes \"$A\"", b)
        self.assertIn("norm_modes \"$S/unix-agent\"", b)
        self.assertNotIn("procps-ng", b, "SUSE names it procps: a file dependency works everywhere")


class Zstd(unittest.TestCase):
    def test_chunks_decoded_by_the_command_without_the_module(self):
        from pg_arca.engine import util
        if util._zstd is None or not shutil.which("zstd"):
            self.skipTest("needs python zstandard (to write) and the zstd command (to read)")
        blob = util.compress(b"pg_arca " * 5000, "zstd")
        self.assertEqual(blob[:1], b"S")
        real = util._zstd
        util._zstd = None
        try:
            self.assertEqual(util.decompress(blob), b"pg_arca " * 5000)
        finally:
            util._zstd = real


if __name__ == "__main__":
    unittest.main()
