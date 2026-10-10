"""
Console link (outbound only). Enrolls once, then loops:
    heartbeat(telemetry up) -> receive operations -> execute (worker thread) -> report
Failure behaviour: exponential backoff with jitter; a 401 means the node was revoked in the console
(the agent stops hammering and waits). Results are re-reported until acknowledged; if the agent
dies first, redelivery + the executor journal re-report the stored outcome (never re-execute).
"""

import hashlib
import json
import logging
import os
import random
import secrets
import ssl
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from pg_arca.config import atomic_write_json, load_credentials, save_credentials
from pg_arca.runtime import AGENT_VERSION

logger = logging.getLogger("pg_arca.console")


class ConsoleError(Exception):
    def __init__(self, status, body):
        super(ConsoleError, self).__init__("console returned %s: %s" % (status, body))
        self.status = status
        self.body = body


class ConsoleClient(threading.Thread):
    def __init__(self, config, runtime, executor, wal, cas, logshipper=None):
        super(ConsoleClient, self).__init__(daemon=True, name="console-client")
        self.config, self.rt, self.executor, self.wal, self.cas, self.logs = config, runtime, executor, wal, cas, logshipper
        self.base = config["web_server_url"].rstrip("/")
        self.stop_ev = threading.Event()
        self.creds = load_credentials(config)
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="op")
        self.inflight = {}           # op_id -> future
        self.unreported = {}         # op_id -> (status, result, error)
        self.last_discovery = 0
        self.ctx = None
        if self.base.startswith("https://"):
            self.ctx = ssl.create_default_context(cafile=config.get("tls_ca_file") or None)
            if config.get("tls_insecure_skip_verify"):
                logger.warning("TLS VERIFICATION DISABLED (tls_insecure_skip_verify=true) - the console identity is NOT checked")
                self.ctx.check_hostname = False
                self.ctx.verify_mode = ssl.CERT_NONE

    # ------------------------------------------------------------------ http
    def _post(self, path, body, auth=True, timeout=15):
        headers = {"Content-Type": "application/json", "User-Agent": "pg_arca-agent/" + AGENT_VERSION}
        if auth:
            headers["Authorization"] = "Bearer " + self.creds["agent_token"]
            headers["X-Arca-Node"] = self.creds["node_id"]
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                body = json.loads(raw)
            except ValueError:
                body = raw[:300]
            raise ConsoleError(e.code, body)

    # ------------------------------------------------------------------ enrollment
    def enroll(self):
        token = self.config.get("enrollment_token")
        if not token:
            raise RuntimeError("not enrolled and no enrollment_token configured (set PG_ARCA_ENROLL_TOKEN)")
        r = self._post("/api/agent/enroll", {"enrollment_token": token, "node_name": self.config["node_name"], "agent_version": AGENT_VERSION,
                                             "discovery": self.rt.report}, auth=False)
        save_credentials(self.config, r["node_id"], r["agent_token"], r.get("cluster_id"))
        self.creds = load_credentials(self.config)
        logger.info("enrolled as node %s in cluster %s", r["node_id"], r.get("cluster_id"))
        env_file = os.path.join(os.path.dirname(self.config["credentials_file"]), "enroll.env")
        try:                                        # the one-time token is spent; do not leave it on disk
            os.unlink(env_file)
        except OSError:
            pass

    # ------------------------------------------------------------------ self-announcement (no enrollment token)
    def _join_state(self):
        """fingerprint + our own secret, created once and kept (0600): the console only ever receives the secret's hash."""
        path = os.path.join(os.path.dirname(self.config["credentials_file"]), "join.json")
        try:
            with open(path, "r", encoding="utf-8") as f:
                j = json.load(f)
            if j.get("fingerprint") and j.get("secret"):
                return j, path
        except Exception:
            pass
        j = {"fingerprint": secrets.token_urlsafe(24), "secret": secrets.token_hex(32)}
        atomic_write_json(path, j)
        return j, path

    def join_step(self):
        """One announce/poll round. Returns True once approved and credentials are saved, False while waiting (the caller sleeps)."""
        j, path = self._join_state()
        # the agent may start before PostgreSQL does (containers, Patroni bootstrap): re-scan while nothing is found, so the console sees the instance
        if not (self.rt.report or {}).get("postgres_instances") and time.time() - getattr(self, "_join_scan_at", 0) > 20:
            self._join_scan_at = time.time()
            try:
                self.rt.refresh()
            except Exception as e:
                logger.warning("discovery refresh failed: %s", e)
        body = {"fingerprint": j["fingerprint"], "secret_hash": hashlib.sha256(j["secret"].encode("utf-8")).hexdigest(), "node_name": self.config["node_name"],
                "agent_version": AGENT_VERSION, "discovery": self.rt.report}
        self._post("/api/agent/request-join", body, auth=False)
        st = self._post("/api/agent/join-status", {"fingerprint": j["fingerprint"], "secret": j["secret"]}, auth=False)
        if st.get("status") == "approved":
            save_credentials(self.config, st["node_id"], j["secret"], st.get("cluster_id"))
            self.creds = load_credentials(self.config)
            logger.info("approved by the console: node %s, cluster %s", st["node_id"], st.get("cluster_id"))
            try:
                os.unlink(path)
            except OSError:
                pass
            return True
        if st.get("status") == "rejected":
            logger.error("the console administrator rejected this server. Retrying in 30 minutes (ask them to approve it, or use an enrollment token).")
            self.stop_ev.wait(1800)
            try:
                os.unlink(path)                      # a new fingerprint on the next round
            except OSError:
                pass
        else:
            logger.info("waiting for approval in the console (Cluster page) ...")
        return False

    # ------------------------------------------------------------------ main loop
    def run(self):
        backoff = 1.0
        while not self.stop_ev.is_set():
            try:
                if not self.creds:
                    if self.config.get("enrollment_token"):
                        self.enroll()
                    elif not self.join_step():
                        self.stop_ev.wait(10)
                        continue
                interval = self.beat()
                backoff = 1.0
                self._rejected = 0
                self.stop_ev.wait(interval)
            except ConsoleError as e:
                if e.status == 401 and self.creds:
                    # node/cluster deleted or revoked in the console: after a few consecutive rejections (not a blip) forget the stale credentials
                    # and announce ourselves again, so an administrator can simply approve the server anew (no manual reset on the node)
                    self._rejected = getattr(self, "_rejected", 0) + 1
                    if self._rejected >= 3 and not self.config.get("enrollment_token"):
                        logger.warning("console keeps rejecting our credentials (node deleted/revoked): dropping them and announcing again for approval")
                        self.forget_credentials()
                    else:
                        logger.error("console rejected our credentials (node revoked?). Retrying in 20s.")
                        self.stop_ev.wait(float(self.config.get("rejected_retry_seconds", 20)))
                elif e.status in (401, 403) and not self.creds:
                    logger.error("enrollment refused: %s. Waiting 60s.", e.body)
                    self.stop_ev.wait(60)
                else:
                    logger.warning("console error: %s", e)
                    self.stop_ev.wait(min(60, backoff) * (0.5 + random.random()))
                    backoff *= 2
            except Exception as e:
                logger.warning("console unreachable: %s", e)
                self.stop_ev.wait(min(60, backoff) * (0.5 + random.random()))
                backoff = min(backoff * 2, 60)

    def forget_credentials(self):
        d = os.path.dirname(self.config["credentials_file"])
        for f in (self.config["credentials_file"], os.path.join(d, "join.json")):
            try:
                os.unlink(f)
            except OSError:
                pass
        self.creds = None
        self._rejected = 0
        self.inflight.clear()

    def stop(self):
        self.stop_ev.set()

    def beat(self):
        # periodic re-discovery (also keeps Patroni/PG bindings fresh)
        now = time.time()
        full_discovery = None
        if now - self.last_discovery > self.config.get("discovery_interval_seconds", 600):
            full_discovery = self.rt.refresh()
            self.last_discovery = now
        snapshot = self.rt.build_snapshot(self.wal, self.cas)

        # results first: the console must learn outcomes before we ask for more work
        for op_id, (status, result, error) in list(self.unreported.items()):
            self._post("/api/agent/ops/%s/report" % op_id, {"status": status, "result": result, "error": error})
            del self.unreported[op_id]
        for op_id, fut in list(self.inflight.items()):
            if fut.done():
                status, result, error = fut.result()
                del self.inflight[op_id]
                self.unreported[op_id] = (status, result, error)
                self._post("/api/agent/ops/%s/report" % op_id, {"status": status, "result": result, "error": error})
                del self.unreported[op_id]
            else:
                r = self._post("/api/agent/ops/%s/report" % op_id, {"status": "running", "progress": self.executor.progress_of(op_id)})   # lease keep-alive + live progress
                if r.get("cancel"):
                    self.executor.request_cancel(op_id)

        free_slots = max(0, 2 - len(self.inflight))
        wait = 0 if self.inflight or not free_slots else min(8, int(self.config.get("heartbeat_interval_seconds", 10)))
        resp = self._post("/api/agent/heartbeat", {"snapshot": snapshot, "agent_version": AGENT_VERSION, "max_ops": free_slots,
                                                   "discovery": full_discovery, "wait_seconds": wait}, timeout=wait + 15)
        for op in resp.get("ops", []):
            if op["id"] in self.inflight:
                continue
            logger.info("received operation %s (%s)", op["id"], op["type"])
            self.inflight[op["id"]] = self.pool.submit(self.executor.execute, op)
        if self.logs:
            try:
                lines = self.logs.collect()
                if lines:
                    self._post("/api/agent/logs", {"logs": lines})
            except ConsoleError:
                raise
            except Exception as e:
                logger.debug("log shipping skipped: %s", e)
        # long-poll already paced the loop when idle; poll results faster while operations are running
        return 1.0 if (self.inflight or resp.get("ops")) else (0.5 if wait else float(self.config.get("heartbeat_interval_seconds", 10)))
