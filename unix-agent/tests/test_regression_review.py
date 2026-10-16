"""Regression review of the night's fixes (16-17/10): the binding to a stopped instance, tablespaces at a mount point, a commented pg_hba list item
without PyYAML, a full scratch disk named as such. No PostgreSQL needed."""
import errno
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.discovery import ClusterDiscoveryEngine


class Binding(unittest.TestCase):
    def setUp(self):
        from pg_arca import runtime, pgaccess
        self.runtime = runtime
        self.d = tempfile.mkdtemp()
        self.state = os.path.join(self.d, "state")
        os.makedirs(self.state)
        self.rep = {"postgres_instances": [], "patroni_clusters": []}
        self._scan, self._ru = ClusterDiscoveryEngine.scan_all, pgaccess.resolve_user
        ClusterDiscoveryEngine.scan_all = lambda s: json.loads(json.dumps(self.rep))
        pgaccess.resolve_user = lambda *a, **k: "postgres"

    def tearDown(self):
        from pg_arca import pgaccess
        ClusterDiscoveryEngine.scan_all, pgaccess.resolve_user = self._scan, self._ru
        shutil.rmtree(self.d, ignore_errors=True)

    def inst(self, d, running):
        return {"data_directory": d, "running": running, "port_listening": running, "port": 5432, "socket_directory": None, "connect": {"host": "127.0.0.1"}}

    def test_nothing_running_at_boot_binds_nothing(self):
        self.rep["postgres_instances"] = [self.inst("/var/lib/pgsql/15/data", False), self.inst("/var/lib/pgsql/16/data", False)]
        self.runtime.Runtime({"state_dir": self.state, "node_role": "database"})
        self.assertFalse(os.path.exists(os.path.join(self.state, "instance.json")), "a stopped pick is not recorded")
        self.rep["postgres_instances"][1]["running"] = True
        self.rep["postgres_instances"][1]["port_listening"] = True
        r = self.runtime.Runtime({"state_dir": self.state, "node_role": "database"})
        self.assertEqual(r.instance["data_directory"], "/var/lib/pgsql/16/data")

    def test_a_long_stopped_instance_hands_over_to_the_only_running_one(self):
        json.dump({"data_directory": "/var/lib/pgsql/15/data"}, open(os.path.join(self.state, "instance.json"), "w"))
        self.rep["postgres_instances"] = [self.inst("/var/lib/pgsql/15/data", False), self.inst("/var/lib/pgsql/16/data", True)]
        r = self.runtime.Runtime({"state_dir": self.state, "node_role": "database"})
        self.assertEqual(r.instance["data_directory"], "/var/lib/pgsql/15/data", "just stopped: still served")
        json.dump({"data_directory": "/var/lib/pgsql/15/data", "since": time.time() - 7200}, open(os.path.join(self.state, "instance-stopped.json"), "w"))
        r.refresh()
        self.assertEqual(r.instance["data_directory"], "/var/lib/pgsql/16/data")
        self.assertTrue(any(f["code"] == "INSTANCE_SWITCHED" for f in r.report["findings"]))


class OwnInstances(unittest.TestCase):
    def test_pg_arca_copies_are_never_served(self):
        from pg_arca import runtime, pgaccess
        d = tempfile.mkdtemp()
        sc, ru = ClusterDiscoveryEngine.scan_all, pgaccess.resolve_user
        try:
            state = os.path.join(d, "state")
            os.makedirs(state)
            json.dump({"data_directory": "/data/prod"}, open(os.path.join(state, "instance.json"), "w"))
            json.dump({"data_directory": "/data/prod", "since": time.time() - 7200}, open(os.path.join(state, "instance-stopped.json"), "w"))
            rep = {"postgres_instances": [
                {"data_directory": "/data/prod", "running": False, "port": 5432, "connect": {"host": "127.0.0.1"}},
                {"data_directory": "/var/tmp/pg_arca_scratch/eph1", "running": True, "port_listening": True, "port": 55001, "connect": {"host": "127.0.0.1"}, "pgarca_owned": True}],
                "patroni_clusters": []}
            ClusterDiscoveryEngine.scan_all = lambda s: json.loads(json.dumps(rep))
            pgaccess.resolve_user = lambda *a, **k: "postgres"
            r = runtime.Runtime({"state_dir": state, "node_role": "database"})
            self.assertEqual(r.instance["data_directory"], "/data/prod", "a recovery instance never takes production's place")
            os.unlink(os.path.join(state, "instance.json"))
            r.refresh()
            self.assertEqual(r.instance["data_directory"], "/data/prod")
        finally:
            ClusterDiscoveryEngine.scan_all, pgaccess.resolve_user = sc, ru
            shutil.rmtree(d)


class OffsiteReplaced(unittest.TestCase):
    def test_metas_and_histories_follow_a_retired_branch(self):
        from pg_arca import offsite
        up, _ = offsite.plan({"wal/000000010000000000000005.meta": 120, "wal/00000005.history": 80},
                             {"wal/000000010000000000000005.meta": 118, "wal/00000005.history": 60})
        self.assertEqual(sorted(up), ["wal/000000010000000000000005.meta", "wal/00000005.history"])


class TablespaceMountPoint(unittest.TestCase):
    def test_only_postgresql_directories_are_walked(self):
        from pg_arca.engine.pgdata import walk_pgdata
        d = tempfile.mkdtemp()
        try:
            pgdata, tbs = os.path.join(d, "data"), os.path.join(d, "mnt")
            os.makedirs(os.path.join(pgdata, "pg_tblspc"))
            open(os.path.join(pgdata, "PG_VERSION"), "w").write("16\n")
            os.makedirs(os.path.join(tbs, "lost+found"))
            open(os.path.join(tbs, "lost+found", "#1234"), "w").write("x")
            os.makedirs(os.path.join(tbs, "PG_16_202307071", "5"))
            open(os.path.join(tbs, "PG_16_202307071", "5", "16400"), "wb").write(b"\0" * 8192)
            os.symlink(tbs, os.path.join(pgdata, "pg_tblspc", "16500"))
            rels = sorted(r for r, _f, _s in walk_pgdata(pgdata))
            self.assertIn("pg_tblspc/16500/PG_16_202307071/5/16400", rels)
            self.assertFalse(any("lost+found" in r for r in rels))
        finally:
            shutil.rmtree(d)


class YamlListComment(unittest.TestCase):
    def test_a_commented_list_item_stays_a_string(self):
        from pg_arca import discovery
        old = sys.modules.get("yaml", "absent")
        sys.modules["yaml"] = None
        try:
            y = discovery.parse_simple_yaml("postgresql:\n  pg_hba:\n  - host all all 0.0.0.0/0 scram-sha-256  # comment: everyone\n")
        finally:
            if old == "absent":
                sys.modules.pop("yaml", None)
            else:
                sys.modules["yaml"] = old
        self.assertEqual(y["postgresql"]["pg_hba"], ["host all all 0.0.0.0/0 scram-sha-256"])


class StorageErrors(unittest.TestCase):
    def test_a_full_scratch_disk_is_called_full(self):
        from pg_arca.engine.backup import _storage_error

        class R(object):
            path = "/var/lib/pgarca/repo"

        class C(object):
            repo = R()
        e = _storage_error(OSError(errno.ENOSPC, "No space left on device", "/var/tmp/pg_arca_scratch/x"), C())
        self.assertEqual(e.code, "PGA-GEN-047")
        e = _storage_error(OSError(errno.EACCES, "Permission denied", "/etc/postgresql/16/main/pg_hba.conf"), C())
        self.assertEqual(e.code, "PGA-GEN-046")
        e = _storage_error(OSError(errno.ENOSPC, "No space left on device", "/var/lib/pgarca/repo/cas/x"), C())
        self.assertEqual(e.code, "PGA-REPO-060")


if __name__ == "__main__":
    unittest.main()
