import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.discovery import advise


class Advisor(unittest.TestCase):
    def codes(self, scan):
        return {f["code"]: f["severity"] for f in advise(scan)}

    def test_healthy_instance_has_no_findings_beyond_tools(self):
        scan = {"toolchain": {"psql": "/x", "pg_waldump": "/x", "zstd": "/x"}, "postgres_instances": [{
            "data_directory": "/d", "major_version": "16", "running": True, "readable_by_agent": True, "settings": {"ssl": "on"},
            "archiving": {"archive_mode": "on", "foreign_tool": None}, "control": {"available": True, "data_checksums": True, "wal_level": "replica"}}]}
        self.assertEqual(self.codes(scan), {})

    def test_problems_are_reported_with_severity(self):
        scan = {"toolchain": {}, "postgres_instances": [{
            "data_directory": "/d", "major_version": "12", "running": False, "readable_by_agent": False, "settings": {"ssl": "off", "fsync": "off"},
            "archiving": {"archive_mode": "off"}, "control": {"available": True, "data_checksums": False, "wal_level": "minimal"}}],
            "etcd_clusters": [{"name": "e", "members": [1, 2]}]}
        c = self.codes(scan)
        for code, sev in (("NO_PSQL", "critical"), ("PG_EOL", "warning"), ("UNREADABLE", "critical"), ("WAL_MINIMAL", "critical"), ("UNSAFE_DURABILITY", "critical"),
                          ("ARCHIVE_OFF", "warning"), ("SSL_OFF", "warning"), ("NOT_RUNNING", "warning"), ("ETCD_EVEN", "warning"), ("NO_CHECKSUMS", "info")):
            self.assertEqual(c.get(code), sev, code)
        f = advise(scan)
        self.assertEqual(f[0]["severity"], "critical"); self.assertTrue(all(x["fix"] or x["severity"] == "info" for x in f if x["code"] != "NO_ZSTD"))

    def test_version_findings_follow_the_compatibility_profile(self):
        def codes(ver):
            return self.codes({"toolchain": {"psql": "x", "pg_waldump": "x", "zstd": "x"}, "postgres_instances": [{"data_directory": "/d", "major_version": ver, "running": True,
                               "readable_by_agent": True, "settings": {"ssl": "on"}, "archiving": {"archive_mode": "on"}, "control": {"available": True, "data_checksums": True, "wal_level": "replica"}}]})
        self.assertEqual(codes("9.6").get("PG_UNSUPPORTED"), "critical")
        self.assertEqual(codes("11").get("PG_LEGACY"), "warning")
        self.assertEqual(codes("17"), {})
        self.assertEqual(codes("19").get("PG_NEWER"), "info")

    def test_foreign_archiver_flagged(self):
        scan = {"toolchain": {"psql": "x"}, "postgres_instances": [{"data_directory": "/d", "major_version": "16", "running": True, "settings": {}, "archiving": {"archive_mode": "on", "foreign_tool": "pgbackrest"}, "control": {}}]}
        self.assertEqual(self.codes(scan).get("ARCHIVE_FOREIGN"), "warning")


if __name__ == "__main__":
    unittest.main()
