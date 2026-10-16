"""Patroni answers a successful write with PLAIN TEXT on several endpoints (switchover, reload, restart...). That must be a success, not 'Patroni unreachable'.
A slow write is a timeout to be verified by the caller, not a refusal."""
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.patroni_bridge import PatroniBridge


CFG = {"ttl": 30}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/config":
            self._send(200, json.dumps(CFG), "application/json")
        else:
            self._send(404, "{}", "application/json")

    def do_PATCH(self):
        n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}")
        if body.get("slow_but_applied"):
            CFG.update(body); time.sleep(1.5); self._send(200, json.dumps(CFG), "application/json")
        elif body.get("slow_and_lost"):
            time.sleep(1.5); self._send(200, "{}", "application/json")
        else:
            CFG.update(body); self._send(200, json.dumps(CFG), "application/json")

    def _send(self, code, body, ctype="text/html"):
        b = body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); self.rfile.read(n)
        if self.path == "/switchover":
            self._send(200, "Successfully switched over to \"pg2\"")
        elif self.path == "/reload":
            self._send(202, "reload scheduled")
        elif self.path == "/restart":
            time.sleep(2); self._send(200, "restart initiated")
        elif self.path == "/failover":
            self._send(412, "failover is not possible: no good candidates have been found")
        else:
            self._send(200, "{}", "application/json")


class Bridge(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), H); cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.b = PatroniBridge("http://127.0.0.1:%d" % cls.port)

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def test_plain_text_success_is_success(self):
        st, d = self.b.switchover("pg1", "pg2")
        self.assertEqual(st, 200); self.assertIn("Successfully", d["message"])
        st, d = self.b.reload()
        self.assertEqual(st, 202); self.assertEqual(d["message"], "reload scheduled")

    def test_plain_text_refusal_keeps_the_text(self):
        st, d = self.b.failover("pg2")
        self.assertEqual(st, 412); self.assertIn("no good candidates", d["error"])

    def test_slow_write_is_a_timeout_not_unreachable(self):
        st, d = self.b.request("/restart", "POST", {}, timeout=0.5)
        self.assertEqual(st, 504); self.assertTrue(d.get("timeout"))

    def test_patch_that_timed_out_is_read_back(self):
        """a PATCH the DCS took late is applied, not 'rejected' (independent review: a promotion happened with no failover record)"""
        import pg_arca.patroni_bridge as pb
        real = pb.time.sleep
        pb.time.sleep = lambda s: real(min(s, 0.6))
        try:
            st, d = self.b.patch_config({"slow_but_applied": 1, "pause": True}, timeout=0.5)
            self.assertEqual(st, 200); self.assertTrue(d.get("_applied_after_timeout"))
            st, d = self.b.patch_config({"slow_and_lost": 1}, timeout=0.5)
            self.assertEqual(st, 504); self.assertFalse(d.get("applied", True))
        finally:
            pb.time.sleep = real

    def test_config_has(self):
        from pg_arca.patroni_bridge import config_has
        cfg = {"standby_cluster": None, "pause": True, "postgresql": {"parameters": {"work_mem": "64MB"}}, "slots": {"a": {"type": "physical"}}}
        self.assertTrue(config_has(cfg, {"standby_cluster": None, "pause": True}))
        self.assertTrue(config_has(cfg, {"postgresql": {"parameters": {"work_mem": "64MB"}}}))
        self.assertTrue(config_has(cfg, {"slots": {"b": None}}))
        self.assertFalse(config_has(cfg, {"slots": {"a": None}}))
        self.assertFalse(config_has(cfg, {"pause": False}))

    def test_standby_leader_is_the_sites_leader(self):
        b = PatroniBridge("http://x")
        b.get_cluster_topology = lambda: (200, {"members": [{"name": "m1", "role": "replica"}, {"name": "m2", "role": "standby_leader"}]})
        self.assertEqual(b.leader()[0], "m2")

    def test_really_unreachable(self):
        st, d = PatroniBridge("http://127.0.0.1:1").request("/x")
        self.assertEqual(st, 503); self.assertIn("unreachable", d["error"])


if __name__ == "__main__":
    unittest.main()


class RestAuthFromPatroniYml(unittest.TestCase):
    def test_credentials_and_ca_come_from_patroni_yml(self):
        """restapi.authentication protects Patroni's changes: the agent uses the credentials of patroni.yml (independent review: 401 on every
        change while the reads worked)."""
        import tempfile
        from pg_arca.runtime import _patroni_rest_auth
        d = tempfile.mkdtemp()
        p = os.path.join(d, "patroni.yml")
        with open(p, "w") as f:
            f.write("scope: x\nrestapi:\n  listen: 0.0.0.0:8008\n  cafile: /etc/patroni/ca.pem\n  authentication:\n    username: patroni\n    password: 's3cret'\n")
        self.assertEqual(_patroni_rest_auth(p), ("patroni", "s3cret", "/etc/patroni/ca.pem"))
        self.assertEqual(_patroni_rest_auth(os.path.join(d, "missing.yml")), ("", "", ""))
