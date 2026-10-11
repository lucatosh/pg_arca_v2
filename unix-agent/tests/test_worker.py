"""Operational machines: role precedence, mount inventory, and a Runtime that never looks for a database in worker mode. No PostgreSQL needed."""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca import worker


class Role(unittest.TestCase):
    def test_precedence(self):
        self.assertTrue(worker.is_worker({"node_role": "worker"}, {"node_kind": "db"}))       # local config wins
        self.assertFalse(worker.is_worker({"node_role": "database"}, {"node_kind": "worker"}))
        self.assertTrue(worker.is_worker({"node_role": "auto"}, {"node_kind": "worker"}))     # auto: the console decides
        self.assertFalse(worker.is_worker({}, None))


class Mounts(unittest.TestCase):
    def test_real_filesystems_only_and_remote_flag(self):
        d = tempfile.mkdtemp()
        f = os.path.join(d, "mounts")
        with open(f, "w") as h:
            h.write("proc /proc proc rw 0 0\nsysfs /sys sysfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n"
                    "nas:/export/backup %s nfs4 rw 0 0\ntmpfs /run tmpfs rw 0 0\noverlay /var/lib/docker/overlay2/x/merged overlay rw 0 0\n" % d.replace(" ", "\\040"))
        m = worker.mounts(f)
        by = {x["mount"]: x for x in m}
        self.assertIn("/", by)
        self.assertNotIn("/proc", by); self.assertNotIn("/run", by)
        self.assertFalse(any("overlay2" in k for k in by), "container layers are not storage")
        nfs = [x for x in m if x["fstype"] == "nfs4"]
        if nfs:                                                   # same device as / in a test container: the shorter mount point is kept
            self.assertTrue(nfs[0]["remote"])
        self.assertTrue(all(x["total_bytes"] > 0 for x in m))


class WorkerRuntime(unittest.TestCase):
    def test_no_database_search_and_inventory_snapshot(self):
        from pg_arca import runtime
        d = tempfile.mkdtemp()
        cfg = {"node_role": "worker", "node_name": "bk01", "scratch_dir": d, "repo_path": os.path.join(d, "repo"), "wal_archive_dir": os.path.join(d, "wal")}
        with mock.patch.object(runtime.ClusterDiscoveryEngine, "scan_all", side_effect=AssertionError("a worker must not look for PostgreSQL")):
            rt = runtime.Runtime(cfg)
            self.assertTrue(rt.worker)
            self.assertIsNone(rt.instance)
            snap = rt.build_snapshot(None, None)
        self.assertEqual(snap["node_kind"], "worker")
        self.assertNotIn("postgres", snap)
        inv = snap["worker"]
        self.assertIn("pg_installations", inv); self.assertIn("mounts", inv)
        self.assertEqual(inv["dirs"]["scratch"]["path"], d)
        self.assertTrue(inv["dirs"]["scratch"]["writable"])
        self.assertEqual(inv["dirs"]["repo"]["exists"], False)

    def test_console_can_switch_the_role(self):
        from pg_arca import runtime
        with mock.patch.object(runtime.ClusterDiscoveryEngine, "scan_all", return_value={"postgres_instances": [], "patroni_clusters": []}) as scan:
            rt = runtime.Runtime({"node_name": "x"})
            self.assertFalse(rt.worker)
            n = scan.call_count
            rt.set_worker(True)
            self.assertTrue(rt.worker)
            self.assertEqual(scan.call_count, n, "no database search after becoming a worker")
            rt2 = runtime.Runtime({"node_name": "y", "node_role": "database"})
            rt2.set_worker(True)
            self.assertFalse(rt2.worker, "an explicit local role is never overridden")


if __name__ == "__main__":
    unittest.main()


class StanzaForCentralOps(unittest.TestCase):
    """A backup server serves many clusters: its operations carry the cluster's stanza (lab: a DR drill on bk1 looked in stanza 'main'). A database node ignores it."""
    def test_worker_uses_the_operation_stanza_db_node_never(self):
        from pg_arca.executor import OperationExecutor
        class RT(object):
            worker = True
        ex = OperationExecutor({"state_dir": tempfile.mkdtemp(), "stanza": None}, None, None, None, RT())
        ex._tl.stanza = "patroni-geo-dc1"
        self.assertEqual(ex._cfg()["stanza"], "patroni-geo-dc1")
        RT.worker = False
        self.assertIsNone(ex._cfg()["stanza"])
