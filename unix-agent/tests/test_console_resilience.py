"""Connection robustness review (16/10): a refused report never wedges the agent, an oversized result is still reported, and the credentials
survive a console that does not know the node (empty or wrong data directory) unless an administrator really deleted it."""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.config import save_credentials
from pg_arca.console_client import ConsoleClient, ConsoleError


class _Rt(object):
    worker = False
    report = {}

    def set_worker(self, v):
        self.worker = v


def client(t, **cfg):
    c = {"web_server_url": "http://console.invalid:1", "credentials_file": os.path.join(t, "cred.json"), "state_dir": os.path.join(t, "state"),
         "node_name": "n", "rejected_retry_seconds": 0.05, "heartbeat_interval_seconds": 1}
    c.update(cfg)
    save_credentials(c, "node-1", "secret", "c1", "db")
    return ConsoleClient(c, _Rt(), None, None, None)


class Reports(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def test_final_refusals_are_dropped_network_errors_kept(self):
        cl = client(self.t)
        for code in (400, 404, 409, 413, 422):
            def post(path, body, auth=True, timeout=15, code=code):
                raise ConsoleError(code, {"reason": "already cancelled"})
            cl._post = post
            self.assertEqual(cl._report("op1", "failed", None, "x"), {}, code)
        def down(path, body, auth=True, timeout=15):
            raise ConsoleError(503, "unavailable")
        cl._post = down
        with self.assertRaises(ConsoleError):
            cl._report("op1", "failed", None, "x")

    def test_oversized_result_is_reported_without_its_detail(self):
        cl = client(self.t)
        sent = []
        cl._post = lambda path, body, auth=True, timeout=15: sent.append(body) or {"ok": True}
        cl._report("op1", "succeeded", {"objects": ["x" * 1000] * 5000}, None)
        self.assertEqual(sent[0]["status"], "succeeded")
        self.assertIn("result_too_large", sent[0]["result"])
        self.assertLess(len(json.dumps(sent[0])), 10000)


class Credentials(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def _run(self, cl, err, seconds=0.6):
        def beat():
            raise ConsoleError(401, {"error": err})
        cl.beat = beat
        cl.join_step = lambda: False
        th = threading.Thread(target=cl.run, daemon=True)
        th.start()
        time.sleep(seconds)
        cl.stop()
        th.join(5)

    def test_unknown_node_keeps_the_credentials_for_a_while(self):
        cl = client(self.t)
        self._run(cl, "node_unknown")
        self.assertTrue(os.path.exists(os.path.join(self.t, "cred.json")), "a console that does not know us (empty state?) must not wipe the fleet")
        self.assertIsNotNone(cl.creds)

    def test_lasting_rejection_sets_the_credentials_aside(self):
        cl = client(self.t, credentials_forget_after_seconds=0)
        self._run(cl, "unauthorized")
        self.assertFalse(os.path.exists(os.path.join(self.t, "cred.json")))
        self.assertTrue([f for f in os.listdir(self.t) if f.startswith("cred.json.rejected-")], "kept aside, not deleted")

    def test_deleted_node_announces_again_at_once(self):
        cl = client(self.t)
        self._run(cl, "node_deleted", 0.3)
        self.assertIsNone(cl.creds)
        self.assertFalse(os.path.exists(os.path.join(self.t, "cred.json")))


class SingleInstance(unittest.TestCase):
    def test_second_agent_on_the_same_state_dir_refused(self):
        import importlib.util
        import subprocess
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        spec = importlib.util.spec_from_file_location("pga_agent_main", os.path.join(here, "pg-arca-agent.py"))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        t = tempfile.mkdtemp()
        try:
            fd = m._single_instance(t)
            self.assertIsInstance(fd, int)
            # another PROCESS (flock is per open file description: a second process is what the service + a manual run are)
            code = "import importlib.util,sys;s=importlib.util.spec_from_file_location('a',%r);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);sys.exit(0 if m._single_instance(%r) is None else 1)" % (os.path.join(here, "pg-arca-agent.py"), t)
            self.assertEqual(subprocess.call([sys.executable, "-c", code], cwd=here), 0, "the second one must be refused")
            os.close(fd)
            self.assertEqual(subprocess.call([sys.executable, "-c", code], cwd=here), 1, "free again once the first one is gone")
        finally:
            shutil.rmtree(t, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
