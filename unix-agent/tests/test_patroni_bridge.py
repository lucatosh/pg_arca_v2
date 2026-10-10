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


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

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

    def test_really_unreachable(self):
        st, d = PatroniBridge("http://127.0.0.1:1").request("/x")
        self.assertEqual(st, 503); self.assertIn("unreachable", d["error"])


if __name__ == "__main__":
    unittest.main()
