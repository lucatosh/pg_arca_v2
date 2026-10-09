"""
Patroni REST bridge with verification helpers.
Every mutating call is followed by *observation* of the cluster (we report what actually
happened, not what Patroni promised): leader change, pause flag, restart completion.
"""

import base64
import json
import logging
import ssl
import time
import urllib.error
import urllib.request

logger = logging.getLogger("pg_arca.patroni_bridge")


class PatroniBridge:
    def __init__(self, patroni_url="", user="", password="", ca_file="", insecure=False):
        self.patroni_url = (patroni_url or "").rstrip("/")
        self.user = user
        self.password = password
        self.ctx = None
        if self.patroni_url.startswith("https://"):
            self.ctx = ssl.create_default_context(cafile=ca_file or None)
            if insecure:
                self.ctx.check_hostname = False
                self.ctx.verify_mode = ssl.CERT_NONE

    @property
    def configured(self):
        return bool(self.patroni_url)

    def request(self, path, method="GET", body=None, timeout=6):
        if not self.configured:
            return 503, {"error": "Patroni not configured/detected on this node"}
        url = self.patroni_url + path
        headers = {"User-Agent": "pg_arca-agent"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.user:
            headers["Authorization"] = "Basic " + base64.b64encode(("%s:%s" % (self.user, self.password)).encode()).decode()
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self.ctx) as r:
                raw = r.read().decode("utf-8", "replace")
                return r.status, (json.loads(raw) if raw.strip() else {})
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"error": raw[:500]}
        except Exception as e:
            return 503, {"error": "Patroni unreachable at %s: %s" % (url, e)}

    # --- reads ---
    def get_node_status(self):
        return self.request("/patroni")

    def get_cluster_topology(self):
        return self.request("/cluster")

    def get_config(self):
        return self.request("/config")

    def leader(self):
        st, d = self.get_cluster_topology()
        if st != 200 or not isinstance(d, dict):
            return None, []
        members = d.get("members", [])
        lead = next((m.get("name") for m in members if m.get("role") in ("leader", "master", "primary")), None)
        return lead, members

    # --- writes (callers verify afterwards) ---
    def reload(self):
        return self.request("/reload", "POST")

    def switchover(self, leader, candidate=None, scheduled_at=None):
        body = {"leader": leader}
        if candidate:
            body["candidate"] = candidate
        if scheduled_at:
            body["scheduled_at"] = scheduled_at
        return self.request("/switchover", "POST", body, timeout=15)

    def failover(self, candidate):
        return self.request("/failover", "POST", {"candidate": candidate}, timeout=15)

    def restart(self, role=None):
        return self.request("/restart", "POST", {"role": role} if role else {}, timeout=30)

    def patch_config(self, patch):
        return self.request("/config", "PATCH", patch)

    def wait_for(self, predicate, timeout=90, interval=2):
        """Poll /cluster until predicate(leader, members) is true. Returns (ok, leader, members)."""
        deadline = time.time() + timeout
        lead, members = None, []
        while time.time() < deadline:
            lead, members = self.leader()
            if predicate(lead, members):
                return True, lead, members
            time.sleep(interval)
        return False, lead, members
