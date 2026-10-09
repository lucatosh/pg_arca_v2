"""
pg_arca Patroni Bridge Module
==============================
Interacts with Patroni REST API (port 8008) for HA cluster management,
topology queries, controlled switchovers, and configuration reloads.
"""

import json
import urllib.request
import urllib.error
import logging

logger = logging.getLogger("pg_arca.patroni_bridge")


class PatroniBridge:
    def __init__(self, patroni_url="http://127.0.0.1:8008"):
        self.patroni_url = patroni_url.rstrip("/")

    def request(self, path, method="GET", body=None, timeout=5):
        url = f"{self.patroni_url}{path}"
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                content = response.read().decode("utf-8")
                return response.status, json.loads(content) if content else {}
        except urllib.error.HTTPError as e:
            content = e.read().decode("utf-8")
            try:
                return e.code, json.loads(content)
            except Exception:
                return e.code, {"error": content}
        except Exception as e:
            return 503, {"error": f"Patroni unreachable at {url}: {str(e)}"}

    def get_node_status(self):
        return self.request("/patroni")

    def get_cluster_topology(self):
        return self.request("/cluster")

    def get_config(self):
        return self.request("/config")

    def reload(self):
        return self.request("/reload", method="POST")

    def switchover(self, candidate=None):
        payload = {}
        if candidate:
            payload["candidate"] = candidate
        return self.request("/switchover", method="POST", body=payload)

    def restart(self, role=None):
        payload = {}
        if role:
            payload["role"] = role
        return self.request("/restart", method="POST", body=payload)
