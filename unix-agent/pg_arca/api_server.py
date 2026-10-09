"""
Optional inbound API (connection_mode daemon/hybrid), used by the local CLI and by operators who
prefer pull over push. Hardened: no CORS, constant-time token check, size-limited bodies, and no
endpoint that pretends to do work it does not do. Binds to 127.0.0.1 unless configured otherwise.
"""

import json
import logging
import re
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

from pg_arca.auth import verify_request_auth

logger = logging.getLogger("pg_arca.api_server")
MAX_BODY = 1 << 20


class ThreadingSimpleServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def make_agent_handler(config, runtime, executor, wal_manager, cas_store):
    class Handler(BaseHTTPRequestHandler):
        server_version = "pg_arca-agent"

        def log_message(self, fmt, *args):  # route access log through logging, not stderr
            logger.debug("%s - %s", self.address_string(), fmt % args)

        def _send(self, code, data):
            body = json.dumps(data).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _auth(self):
            ok, msg = verify_request_auth(self.headers, config, self.client_address)
            if not ok:
                self._send(401, {"error": "unauthorized"})
            return ok

        def do_GET(self):
            if not self._auth():
                return
            if self.path in ("/", "/api/status"):
                return self._send(200, runtime.build_snapshot(wal_manager, cas_store))
            if self.path == "/api/discovery/scan":
                return self._send(200, runtime.refresh())
            if self.path == "/api/wal/status":
                return self._send(200, wal_manager.verify_continuity())
            if self.path == "/api/backup/manifests":
                return self._send(200, {"manifests": cas_store.list_manifests(), "cas_stats": cas_store.get_stats()})
            self._send(404, {"error": "not_found"})

        def do_POST(self):
            if not self._auth():
                return
            try:
                n = int(self.headers.get("Content-Length", 0))
                if n > MAX_BODY:
                    return self._send(413, {"error": "body_too_large"})
                body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
            except Exception:
                return self._send(400, {"error": "invalid_json"})
            if self.path == "/api/ops":
                # synchronous execution of one operation; the id makes it idempotent exactly like console-delivered ops
                op = {"id": body.get("id", ""), "type": body.get("type", ""), "params": body.get("params") or {}}
                if not re.match(r"^op-[0-9a-f]{12}$", op["id"]):
                    return self._send(400, {"error": "id must look like op-<12 hex>"})
                status, result, error = executor.execute(op)
                return self._send(200 if status == "succeeded" else 422, {"status": status, "result": result, "error": error})
            if self.path == "/api/network/scan":
                res = runtime.engine.scan_network_cidr(body.get("target") or "127.0.0.1/32", body.get("ports"), int(body.get("timeout_ms", 300)))
                return self._send(200 if "error" not in res else 400, res)
            self._send(404, {"error": "not_found"})

    return Handler
