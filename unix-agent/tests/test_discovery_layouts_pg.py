"""Discovery against REAL PostgreSQL in layouts that differ from the lab: custom data directory, configuration files outside PGDATA (Debian style),
non-default port and socket directory, a stopped instance, and two independent instances on one host.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_discovery_layouts_pg'"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.test_engine_pg import BIN, SKIP, sh
from pg_arca.discovery import ClusterDiscoveryEngine


def run(cmd):
    r = sh(*cmd)
    if r.returncode != 0:
        raise RuntimeError("%s failed: %s" % (cmd[0], r.stderr[-400:]))
    return r


def make_instance(root, name, port, conf_outside):
    data = os.path.join(root, name, "data")           # deliberately NOT a well-known location
    sock = os.path.join(root, name, "sock"); os.makedirs(sock)
    run([os.path.join(BIN, "initdb"), "-D", data, "-A", "trust", "--data-checksums"])
    args = ["-p", str(port), "-c", "unix_socket_directories=" + sock, "-c", "listen_addresses=127.0.0.1"]
    if conf_outside:
        cdir = os.path.join(root, name, "etc"); os.makedirs(cdir)
        shutil.move(os.path.join(data, "postgresql.conf"), os.path.join(cdir, "postgresql.conf"))
        with open(os.path.join(cdir, "postgresql.conf"), "a") as f:
            f.write("\ndata_directory = '%s'\nport = %d\nunix_socket_directories = '%s'\nlog_directory = 'mylog'\n" % (data, port, sock))
        args = ["-c", "config_file=" + os.path.join(cdir, "postgresql.conf")]
    run([os.path.join(BIN, "pg_ctl"), "-D", data, "-w", "-o", " ".join(args), "-l", os.path.join(root, name + ".log"), "start"])
    return data, sock


@unittest.skipIf(SKIP, "PostgreSQL binaries not available")
class Layouts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="arca_layout_")
        cls.a, cls.a_sock = make_instance(cls.root, "single", 54411, conf_outside=False)
        cls.b, cls.b_sock = make_instance(cls.root, "debianish", 54412, conf_outside=True)

    @classmethod
    def tearDownClass(cls):
        for d in (cls.a, cls.b):
            try:
                run([os.path.join(BIN, "pg_ctl"), "-D", d, "-m", "immediate", "stop"])
            except Exception:
                pass
        shutil.rmtree(cls.root, ignore_errors=True)

    def scan(self, extra=None):
        return ClusterDiscoveryEngine(search_paths=extra or []).scan_all()

    def test_running_instances_in_custom_directories_are_found_without_any_hint(self):
        got = {os.path.realpath(i["data_directory"]): i for i in self.scan()["postgres_instances"]}
        for d, port, sock in ((self.a, 54411, self.a_sock), (self.b, 54412, self.b_sock)):
            i = got.get(os.path.realpath(d))
            self.assertIsNotNone(i, "instance in %s not discovered (found: %s)" % (d, list(got)))
            self.assertTrue(i["running"]); self.assertEqual(i["port"], port); self.assertEqual(i["socket_directory"], sock)
            self.assertTrue(str(i.get("cluster_key", "")).startswith("sysid:"), "standalone instance is identified by its system identifier")
            self.assertTrue(i["control"].get("data_checksums"))

    def test_config_outside_pgdata_and_log_directory_are_read(self):
        i = {os.path.realpath(i["data_directory"]): i for i in self.scan()["postgres_instances"]}[os.path.realpath(self.b)]
        self.assertTrue(i["config_file"].endswith("etc/postgresql.conf"), i["config_file"])
        self.assertEqual(i["settings"].get("log_directory"), "mylog")

    def test_two_instances_get_distinct_identities(self):
        keys = {i["cluster_key"] for i in self.scan()["postgres_instances"] if os.path.realpath(i["data_directory"]) in (os.path.realpath(self.a), os.path.realpath(self.b))}
        self.assertEqual(len(keys), 2)

    def test_no_patroni_means_standalone(self):
        s = self.scan()
        self.assertEqual(s["summary"]["patroni_clusters_found"], 0)
        self.assertTrue(all("patroni" not in i for i in s["postgres_instances"] if os.path.realpath(i["data_directory"]) in (os.path.realpath(self.a), os.path.realpath(self.b))))


if __name__ == "__main__":
    unittest.main()
