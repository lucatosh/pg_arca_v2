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
import re
import secrets
import ssl
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from pg_arca.config import atomic_write_json, load_credentials, save_credentials
from pg_arca.build import AGENT_BUILD
from pg_arca.runtime import AGENT_VERSION

logger = logging.getLogger("pg_arca.console")


_STARTED = int(time.time())      # identifies this agent process: the console hands back what a previous process had taken and never finished

def _instance_of(conf_path):
    """The installer's instance name (PG_ARCA_INSTANCE) of this agent, from its config path /etc/pg-arca/<instance>/agent.conf: the console's upgrade
    command must name it, otherwise it would install a second, main agent on the host (independent review)."""
    m = re.match(r"^/etc/pg-arca/([a-z0-9][a-z0-9_-]{0,30})/agent\.conf$", str(conf_path or ""))
    return m.group(1) if m else None


class ConsoleError(Exception):
    def __init__(self, status, body):
        super(ConsoleError, self).__init__("console returned %s: %s" % (status, body))
        self.status = status
        self.body = body


WORKERS = 4                  # operations in flight at once: control lane + data lane + analysis lane + restored copies (the server leases at most one per lane)

class ConsoleClient(threading.Thread):
    def __init__(self, config, runtime, executor, wal, cas, logshipper=None):
        super(ConsoleClient, self).__init__(daemon=True, name="console-client")
        self.config, self.rt, self.executor, self.wal, self.cas, self.logs = config, runtime, executor, wal, cas, logshipper
        self.base = config["web_server_url"].rstrip("/")
        self.stop_ev = threading.Event()
        self.creds = load_credentials(config)
        if self.creds and self.creds.get("node_kind") == "worker":
            runtime.set_worker(True)                                 # remembered from the console: an operational machine
        self.pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="op")   # control + data + analysis + restored copies
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

    REPORT_MAX = 3 * 1024 * 1024                  # the console takes request bodies up to 4 MB

    def _report(self, op_id, status, result=None, error=None, progress=None):
        """One report. A refusal that will never change (400/404/409/413/422: the operation is unknown, belongs to another node, is already over,
        or the body is too big) is final: logged and dropped. Before, it was retried forever AHEAD of the heartbeat - the node went 'offline' and
        received no more work until someone restarted the agent. Network errors and 5xx raise: the report is kept and sent again."""
        body = {"status": status} if status == "running" else {"status": status, "result": result, "error": error}
        if progress is not None:
            body["progress"] = progress
        if status != "running":
            try:
                n = len(json.dumps(result))
            except (TypeError, ValueError):
                n = self.REPORT_MAX + 1
            if n > self.REPORT_MAX:
                logger.warning("result of %s is %d bytes: sent without its detail", op_id, n)
                body["result"] = {"result_too_large": n, "note": "the result was too large to send to the console (%d bytes); the outcome is %s" % (n, status)}
        try:
            return self._post("/api/agent/ops/%s/report" % op_id, body)
        except ConsoleError as e:
            if e.status in (400, 404, 409, 413, 422):
                logger.warning("console refused the %s report of operation %s for good (%s %s): dropped", status, op_id, e.status, str(e.body)[:200])
                return {}
            raise

    # ------------------------------------------------------------------ status for the installer / the administrator on the server
    def _status(self, state, **kw):
        """state_dir/console_status.json: what the agent knows about its registration (the installer waits on it and tells the user)."""
        if getattr(self, "_last_status", None) == (state, kw.get("detail")):
            return
        self._last_status = (state, kw.get("detail"))
        try:
            d = self.config.get("state_dir") or os.path.dirname(self.config["credentials_file"])
            atomic_write_json(os.path.join(d, "console_status.json"), dict(kw, state=state, at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                                                             console=self.config.get("web_server_url")))
        except Exception:
            pass

    # ------------------------------------------------------------------ enrollment
    def enroll(self):
        token = self.config.get("enrollment_token")
        if not token:
            raise RuntimeError("not enrolled and no enrollment_token configured (set PG_ARCA_ENROLL_TOKEN)")
        r = self._post("/api/agent/enroll", {"enrollment_token": token, "node_name": self.config["node_name"], "agent_version": AGENT_VERSION, "agent_build": AGENT_BUILD,
                                             "discovery": self.rt.report, "node_role": self.config.get("node_role") or "auto"}, auth=False)
        save_credentials(self.config, r["node_id"], r["agent_token"], r.get("cluster_id"), r.get("node_kind"))
        self.rt.set_worker(r.get("node_kind") == "worker")
        self.creds = load_credentials(self.config)
        logger.info("enrolled as node %s in cluster %s", r["node_id"], r.get("cluster_id"))
        self._status("enrolled", node_id=r["node_id"], cluster_id=r.get("cluster_id"), via="token")
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
                "agent_version": AGENT_VERSION, "agent_build": AGENT_BUILD, "discovery": self.rt.report, "node_role": self.config.get("node_role") or "auto"}
        self._post("/api/agent/request-join", body, auth=False)
        st = self._post("/api/agent/join-status", {"fingerprint": j["fingerprint"], "secret": j["secret"]}, auth=False)
        if st.get("status") == "approved":
            save_credentials(self.config, st["node_id"], j["secret"], st.get("cluster_id"), st.get("node_kind"))
            self.creds = load_credentials(self.config)
            self.rt.set_worker(st.get("node_kind") == "worker")
            logger.info("approved by the console: node %s, cluster %s", st["node_id"], st.get("cluster_id"))
            self._status("enrolled", node_id=st["node_id"], cluster_id=st.get("cluster_id"), via="approval")
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
            self._status("waiting_approval", detail=getattr(self, "_token_refused", None))
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
                self._status("connected", node_id=(self.creds or {}).get("node_id"), cluster_id=(self.creds or {}).get("cluster_id"))
                backoff = 1.0
                self._rejected = 0
                self._rejected_since = None
                self.stop_ev.wait(interval)
            except ConsoleError as e:
                if e.status == 401 and self.creds:
                    # 'node_deleted': an administrator removed this node - announce ourselves again at once, an administrator approves the server
                    # anew (no manual reset on the node). 'node_unknown' or a plain 401 can also be a console started on an empty or wrong data
                    # directory, or something in the path (a gateway): giving up the credentials of the whole fleet on that would need every node
                    # approved again. Only a rejection that lasts (30 min by default) does it, and the credentials are set aside, not deleted.
                    self._rejected = getattr(self, "_rejected", 0) + 1
                    if not getattr(self, "_rejected_since", None):
                        self._rejected_since = time.time()
                    deleted = "node_deleted" in str(e.body)
                    lasting = time.time() - self._rejected_since >= float(self.config.get("credentials_forget_after_seconds", 1800))
                    if (deleted or lasting) and not self.config.get("enrollment_token"):
                        logger.warning("console keeps rejecting our credentials (node deleted/revoked): dropping them and announcing again for approval")
                        self.forget_credentials()
                    else:
                        logger.error("console rejected our credentials (node revoked?). Retrying in 20s.")
                        self.stop_ev.wait(float(self.config.get("rejected_retry_seconds", 20)))
                elif e.status in (401, 403) and not self.creds and self.config.get("enrollment_token"):
                    # expired / already used / unknown token: do not loop on it forever - announce this server instead, an administrator approves it
                    why = (e.body or {}).get("error") if isinstance(e.body, dict) else str(e.body)[:80]
                    logger.error("enrollment token refused by the console (%s): announcing this server for approval instead", why)
                    self._token_refused = why
                    self._status("token_refused", detail=why)
                    self.config["enrollment_token"] = None
                    try:
                        os.unlink(os.path.join(os.path.dirname(self.config["credentials_file"]), "enroll.env"))
                    except OSError:
                        pass
                elif e.status in (401, 403) and not self.creds:
                    logger.error("enrollment refused: %s. Waiting 60s.", e.body)
                    self.stop_ev.wait(60)
                else:
                    logger.warning("console error: %s", e)
                    self.stop_ev.wait(min(60, backoff) * (0.5 + random.random()))
                    backoff *= 2
            except Exception as e:
                logger.warning("console unreachable: %s", e)
                if not self.creds:
                    self._status("unreachable", detail=str(e)[:200])
                self.stop_ev.wait(min(60, backoff) * (0.5 + random.random()))
                backoff = min(backoff * 2, 60)

    def forget_credentials(self):
        """Set the credentials aside (<file>.rejected-<time>: an administrator can put them back) and announce this server again. Operations
        still running finish; their reports, refused under the old identity, are dropped (see _report)."""
        d = os.path.dirname(self.config["credentials_file"])
        stamp = time.strftime("%Y%m%d%H%M%S", time.gmtime())
        for f in (self.config["credentials_file"], os.path.join(d, "join.json")):
            try:
                os.rename(f, "%s.rejected-%s" % (f, stamp))
            except OSError:
                pass
        self.creds = None
        self._rejected = 0
        self._rejected_since = None

    def stop(self):
        self.stop_ev.set()

    def beat(self):
        # periodic re-discovery (also keeps Patroni/PG bindings fresh)
        now = time.time()
        full_discovery = None
        # PostgreSQL not visible yet (replica still being cloned, Patroni bootstrapping, instance stopped): look again soon, not after 10 minutes
        # also while the instance does not answer: after a restart on another port / socket directory the old binding never connects again
        blind = not self.rt.worker and (not self.rt.instance or not self.rt.instance.get("running") or getattr(self.rt, "db_alive", None) is False)
        # soon at first, then less and less often (a database that refuses the agent for good must not cost a full scan every 30 s forever)
        n = getattr(self, "_blind_n", 0) if blind else 0
        self._blind_n = n
        wait_s = min(self.config.get("discovery_interval_seconds", 600), (15 if not self.rt.instance else 30) * (2 ** min(n, 6))) if blind else self.config.get("discovery_interval_seconds", 600)
        if now - self.last_discovery > wait_s:
            full_discovery = self.rt.refresh()
            self.last_discovery = now
            if blind:
                self._blind_n = n + 1
        # results and lease keep-alives FIRST, before the telemetry (which can take a minute while PostgreSQL is slow or restarting: the leases
        # lapsed meanwhile and the console handed running operations back)
        for op_id, (status, result, error) in list(self.unreported.items()):
            self._report(op_id, status, result, error)
            del self.unreported[op_id]
        for op_id, fut in list(self.inflight.items()):
            if fut.done():
                status, result, error = fut.result()
                del self.inflight[op_id]
                self.unreported[op_id] = (status, result, error)
                self._report(op_id, status, result, error)
                del self.unreported[op_id]
            else:
                r = self._report(op_id, "running", progress=self.executor.progress_of(op_id))   # lease keep-alive + live progress
                if r.get("cancel"):
                    self.executor.request_cancel(op_id)
        # while operations run the loop turns every second for their progress: the full snapshot (psql sessions on production, up to a MB on
        # the wire) goes at the normal pace only
        if not self.inflight or now - getattr(self, "_snap_at", 0) >= float(self.config.get("heartbeat_interval_seconds", 10)) or full_discovery:
            snapshot = self.rt.build_snapshot(self.wal, self.cas)
            self._snap_at = now
        else:
            snapshot = None

        free_slots = max(0, WORKERS - len(self.inflight))
        wait = 0 if self.inflight or not free_slots else min(8, int(self.config.get("heartbeat_interval_seconds", 10)))
        resp = self._post("/api/agent/heartbeat", {"snapshot": snapshot, "agent_version": AGENT_VERSION, "agent_build": AGENT_BUILD, "console_url": self.base, "tls_ca_file": self.config.get("tls_ca_file") or None, "agent_instance": _instance_of(self.config.get("_conf_path")), "agent_now": time.time(), "tls_insecure": bool(self.config.get("tls_insecure_skip_verify")) or not self.base.startswith("https://"), "max_ops": free_slots, "agent_started": _STARTED,
                                                   "discovery": full_discovery, "wait_seconds": wait}, timeout=wait + 15)
        if self.logs:
            self.logs.set_mode(resp.get("log_mode"))
        sh = resp.get("stanza") if "stanza" in resp else self.config.get("stanza_shared")
        if sh is not None and not (isinstance(sh, str) and re.match(r"^[A-Za-z0-9_.-]{1,60}$", sh)):
            sh = None
        if (sh or None) != self.config.get("stanza_shared"):
            logger.info("backup catalog (stanza) assigned by the console: %s", sh or "(own)")
            if sh:
                self.config["stanza_shared"] = sh
            else:
                self.config.pop("stanza_shared", None)
        kind = resp.get("node_kind")
        if kind in ("worker", "db") and (kind == "worker") != bool(self.rt.worker):
            self.rt.set_worker(kind == "worker")                   # decided in the console (enrolled / converted as an operational machine)
            if self.creds and self.creds.get("node_kind") != kind:
                save_credentials(self.config, self.creds["node_id"], self.creds["agent_token"], self.creds.get("cluster_id"), kind)
                self.creds = load_credentials(self.config)
        for op in resp.get("ops", []):
            if op["id"] in self.inflight:
                continue
            logger.info("received operation %s (%s)", op["id"], op["type"])
            self.inflight[op["id"]] = self.pool.submit(self.executor.execute, op)
        if self.logs:
            try:
                lines = self.logs.collect()
                if lines:
                    r = self._post("/api/agent/logs", {"logs": lines})
                    self.logs.set_mode(r.get("log_mode"))
            except ConsoleError:
                raise
            except Exception as e:
                logger.debug("log shipping skipped: %s", e)
        # long-poll already paced the loop when idle; poll results faster while operations are running
        return 1.0 if (self.inflight or resp.get("ops")) else (0.5 if wait else float(self.config.get("heartbeat_interval_seconds", 10)))
