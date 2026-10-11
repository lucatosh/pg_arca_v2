"""Ephemeral-instance configuration: settings validation, binaries per PostgreSQL major, preflight and the installation plan (no PostgreSQL needed:
the binaries are tiny scripts that print a version, the package manager is a stub)."""
import os
import socket
import stat
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pg_arca.engine import ephcfg
from pg_arca.engine.util import EngineError


def fake_bin(root, major, missing=()):
    d = os.path.join(root, "bin")
    os.makedirs(d, exist_ok=True)
    for t in ephcfg.TOOLS:
        if t in missing:
            continue
        p = os.path.join(d, t)
        with open(p, "w") as f:
            f.write("#!/bin/sh\necho '%s (PostgreSQL) %d.4'\n" % (t, major))
        os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return d


class Settings(unittest.TestCase):
    def test_valid_settings_are_normalised_and_unknown_keys_dropped(self):
        t = tempfile.mkdtemp()
        out = ephcfg.normalize({"placement": "central", "central_node": "n1", "scratch_dir": os.path.join(t, "s"), "port_min": "55000", "port_max": 55010,
                                "shared_buffers_mb": "128", "keep_on_failure": 1, "evil": "x"})
        self.assertEqual(out["placement"], "central")
        self.assertEqual((out["port_min"], out["port_max"], out["shared_buffers_mb"]), (55000, 55010, 128))
        self.assertTrue(out["keep_on_failure"])
        self.assertNotIn("evil", out)

    def test_refusals_say_which_setting_and_why(self):
        for bad in ({"placement": "cloud"}, {"scratch_dir": "relative/dir"}, {"scratch_dir": "/etc"}, {"scratch_dir": "/tmp/../etc/x"}, {"port_min": 80, "port_max": 90},
                    {"port_min": 55000}, {"port_min": 55010, "port_max": 55000}, {"shared_buffers_mb": 1}, {"bin_dir": "/nonexistent-bin"}, {"install_mode": "rpm"}):
            with self.assertRaises(EngineError, msg=str(bad)) as cm:
                ephcfg.normalize(bad)
            self.assertEqual(cm.exception.code, "PGA-CFG-040")

    def test_port_comes_from_the_range_and_a_busy_range_is_reported(self):
        base = 56100
        socks = []
        try:
            for p in range(base, base + 3):
                s = socket.socket(); s.bind(("127.0.0.1", p)); socks.append(s)
            with self.assertRaises(EngineError) as cm:
                ephcfg.free_port({"port_min": base, "port_max": base + 2})
            self.assertEqual(cm.exception.code, "PGA-CFG-041")
            self.assertIn(ephcfg.free_port({"port_min": base, "port_max": base + 3}), [base + 3])
        finally:
            for s in socks:
                s.close()


class Binaries(unittest.TestCase):
    def test_the_matching_major_is_found_in_the_private_root_and_preferred_over_a_wrong_node_default(self):
        t = tempfile.mkdtemp()
        b14 = fake_bin(os.path.join(t, "node"), 14)
        b15 = fake_bin(os.path.join(t, "pg", "15", "usr", "lib", "postgresql", "15"), 15)
        eph = {"install_dir": os.path.join(t, "pg")}
        self.assertEqual(ephcfg.pick_bindir(15, eph, b14), (b15, "private"))
        self.assertEqual(ephcfg.pick_bindir(14, eph, b14), (b14, "node"))
        self.assertEqual(ephcfg.pick_bindir(13, eph, b14)[0], b14)                        # nothing matches: the node's own is returned, the caller explains the mismatch
        self.assertEqual(ephcfg.pick_bindir(15, dict(eph, bin_dir=b14), b14)[0], b15)     # a configured dir of another major is ignored for this backup

    def test_an_incomplete_installation_is_reported_with_its_missing_tools(self):
        t = tempfile.mkdtemp()
        d = fake_bin(os.path.join(t, "x"), 16, missing=("pg_waldump", "pg_restore"))
        i = ephcfg._inst(d, "configured")
        self.assertFalse(i["complete"])
        self.assertEqual(sorted(i["missing_tools"]), ["pg_restore", "pg_waldump"])


FACTS_DEB = {"os": "Ubuntu 24.04", "family": "debian", "euid": 1000, "root": False, "sudo_nopasswd": False, "arch": "x86_64", "mem_total": 8 << 30, "mem_available": 4 << 30, "cpus": 4,
             "apt": True, "dnf": False, "dpkg_deb": True, "rpm2cpio": False, "cpio": False}


class InstallPlan(unittest.TestCase):
    def test_non_root_gets_the_private_mode_and_the_system_mode_says_what_it_needs(self):
        t = tempfile.mkdtemp()
        p = ephcfg.install_plan(15, {"install_dir": os.path.join(t, "pg")}, FACTS_DEB, available=True)
        self.assertTrue(p["modes"]["private"]["possible"])
        self.assertFalse(p["modes"]["system"]["possible"])
        self.assertTrue(any("root or passwordless sudo" in b for b in p["modes"]["system"]["blockers"]))
        self.assertEqual(p["recommended"], "private")
        self.assertIn("postgresql-15", " ".join(p["modes"]["private"]["commands"]))
        self.assertTrue(p["modes"]["system"]["warnings"])

    def test_sudo_makes_the_system_mode_possible_and_it_warns_about_the_cluster(self):
        p = ephcfg.install_plan(15, {"install_dir": tempfile.mkdtemp()}, dict(FACTS_DEB, sudo_nopasswd=True), available=True)
        self.assertTrue(p["modes"]["system"]["possible"])
        self.assertTrue(any("cluster" in w for w in p["modes"]["system"]["warnings"]))

    def test_an_unknown_package_points_to_the_repository_to_add(self):
        p = ephcfg.install_plan(19, {"install_dir": tempfile.mkdtemp()}, FACTS_DEB, available=False)
        self.assertFalse(p["modes"]["private"]["possible"])
        self.assertTrue(any("PGDG" in b for b in p["modes"]["private"]["blockers"]))
        self.assertIsNone(p["recommended"])

    def test_rhel_family_and_unsupported_family(self):
        rh = dict(FACTS_DEB, family="rhel", apt=False, dnf=True, dpkg_deb=False, rpm2cpio=True, cpio=True)
        p = ephcfg.install_plan(16, {"install_dir": tempfile.mkdtemp()}, rh, available=True)
        self.assertIn("postgresql16-server", " ".join(p["modes"]["private"]["commands"]))
        self.assertTrue(p["modes"]["private"]["possible"])
        p = ephcfg.install_plan(16, {}, dict(FACTS_DEB, family="unknown"), available=True)
        self.assertIn("blocked", p)

    def test_private_install_unpacks_without_root_and_the_result_is_picked_up(self):
        t = tempfile.mkdtemp()
        eph = {"install_dir": os.path.join(t, "pg")}
        calls = []

        def run(cmd, cwd=None, timeout=900, env=None):
            calls.append(cmd)
            if cmd[0] == "apt-get":
                for n in ("postgresql-15_15.4_amd64.deb", "postgresql-client-15_15.4_amd64.deb"):
                    open(os.path.join(cwd, n), "w").write("x")
                return 0, ""
            if cmd[0] == "dpkg-deb":
                fake_bin(os.path.join(cmd[3], "usr", "lib", "postgresql", "15"), 15)            # what unpacking would leave behind
                return 0, ""
            return 1, "unexpected"
        r = ephcfg.install(15, "private", eph, FACTS_DEB, run=run, available=True)
        self.assertEqual(r["mode"], "private")
        self.assertTrue(r["bindir"].endswith("/15/usr/lib/postgresql/15/bin"))
        self.assertEqual(ephcfg.pick_bindir(15, eph, "")[0], r["bindir"])
        self.assertEqual([c[0] for c in calls], ["apt-get", "dpkg-deb", "dpkg-deb"])
        self.assertNotIn("sudo", [c[0] for c in calls])
        self.assertEqual([x for x in os.listdir(eph["install_dir"]) if x.startswith(".dl-")], [], "download directory removed")

    def test_a_failed_download_is_explained_and_leaves_nothing(self):
        t = tempfile.mkdtemp()
        eph = {"install_dir": os.path.join(t, "pg")}
        with self.assertRaises(EngineError) as cm:
            ephcfg.install(15, "private", eph, FACTS_DEB, available=True, run=lambda cmd, cwd=None, timeout=900, env=None: (100, "E: Unable to locate package"))
        self.assertEqual(cm.exception.code, "PGA-INS-007")
        self.assertIn("network", cm.exception.hint)
        self.assertEqual(os.listdir(eph["install_dir"]), [])

    def test_system_install_without_privileges_is_refused_before_touching_anything(self):
        with self.assertRaises(EngineError) as cm:
            ephcfg.install(15, "system", {"install_dir": tempfile.mkdtemp()}, FACTS_DEB, available=True, run=lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not run")))
        self.assertEqual(cm.exception.code, "PGA-INS-002")


class Preflight(unittest.TestCase):
    def ctx(self, t, major=15):
        repo = types.SimpleNamespace(path=os.path.join(t, "repo"), complete_sets=lambda: [{"pg_version": "%d.4" % major, "pg_version_num": major * 10000 + 4}])
        os.makedirs(repo.path, exist_ok=True)
        wal = os.path.join(t, "wal")
        os.makedirs(wal, exist_ok=True)
        return types.SimpleNamespace(scratch_dir=os.path.join(t, "scratch"), pgdata=os.path.join(t, "data"), repo=repo, wal_dir=wal, conn=types.SimpleNamespace(bindir=""), eph={})

    def test_missing_binaries_make_it_fail_with_the_plan_attached(self):
        t = tempfile.mkdtemp()
        r = ephcfg.preflight(self.ctx(t, 99), None, {"install_dir": os.path.join(t, "pg")}, facts=FACTS_DEB)
        self.assertFalse(r["ok"])
        b = [c for c in r["checks"] if c["id"] == "binaries"][0]
        self.assertEqual(b["level"], "bad")
        self.assertEqual(b["missing_major"], 99)
        self.assertEqual(r["major"], 99)
        self.assertIsNotNone(r["install_plan"])

    def test_everything_in_place_is_ok_and_space_is_checked(self):
        t = tempfile.mkdtemp()
        bd = fake_bin(os.path.join(t, "b"), 15)
        r = ephcfg.preflight(self.ctx(t, 15), 15, {"bin_dir": bd, "scratch_dir": os.path.join(t, "scratch")}, facts=FACTS_DEB)
        self.assertTrue(r["ok"], r["checks"])
        self.assertEqual(r["chosen"]["bindir"], bd)
        r2 = ephcfg.preflight(self.ctx(t, 15), 15, {"bin_dir": bd, "scratch_dir": os.path.join(t, "scratch")}, need_bytes=1 << 60, facts=FACTS_DEB)
        self.assertFalse(r2["ok"])
        self.assertEqual([c for c in r2["checks"] if c["id"] == "scratch"][0]["level"], "bad")

    def test_root_and_unreadable_repository_are_reported(self):
        t = tempfile.mkdtemp()
        c = self.ctx(t, 15)
        c.wal_dir = os.path.join(t, "no-such-wal")
        r = ephcfg.preflight(c, 15, {}, facts=dict(FACTS_DEB, root=True, euid=0), with_plan=False)
        lv = {x["id"]: x["level"] for x in r["checks"]}
        self.assertEqual(lv["user"], "bad")
        self.assertEqual(lv["wal"], "bad")
        self.assertEqual(lv["repo"], "ok")


if __name__ == "__main__":
    unittest.main()
