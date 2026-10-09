"""
pg_arca Outbound Push Client & Heartbeat Module
================================================
Allows nodes in private VPCs/behind NAT to "phone home" to the pg_arca Web UI.
Periodically registers node health, DCS role, LSN, and checks for pending commands.
"""

import time
import json
import threading
import urllib.request
import urllib.error
import logging
import os

logger = logging.getLogger("pg_arca.heartbeat_client")


class HeartbeatClient(threading.Thread):
    def __init__(self, config, db_client, wal_manager, cas_store, patroni_bridge):
        super().__init__(daemon=True)
        self.config = config
        self.db_client = db_client
        self.wal_manager = wal_manager
        self.cas_store = cas_store
        self.patroni_bridge = patroni_bridge
        self.web_url = config.get("web_server_url", "http://127.0.0.1:3000").rstrip("/")
        self.interval = config.get("heartbeat_interval_seconds", 10)
        self.running = True

    def run(self):
        logger.info(f"[*] Starting Outbound Heartbeat Client to {self.web_url} (every {self.interval}s)...")
        while self.running:
            try:
                self.send_heartbeat()
            except Exception as e:
                logger.debug(f"Heartbeat attempt failed: {e}")
            time.sleep(self.interval)

    def stop(self):
        self.running = False

    def send_heartbeat(self):
        # Collect local state
        pg_state = self.db_client.get_cluster_state()
        p_status, p_data = self.patroni_bridge.get_node_status()
        wal_report = self.wal_manager.verify_continuity()
        cas_stats = self.cas_store.get_stats()

        try:
            load1, _, _ = os.getloadavg()
        except Exception:
            load1 = 0.0

        payload = {
            "node_name": self.config.get("node_name", os.uname().nodename),
            "cluster_id": self.config.get("cluster_id", "cluster-prod-01"),
            "environment": self.config.get("environment", "prod"),
            "listen_port": self.config.get("listen_port", 9898),
            "auth_mode": self.config.get("auth_mode", "token"),
            "connection_mode": self.config.get("connection_mode", "hybrid"),
            "postgres": pg_state,
            "patroni": {
                "accessible": p_status == 200,
                "role": p_data.get("role", "unknown") if isinstance(p_data, dict) else "unknown",
                "state": p_data.get("state", "unknown") if isinstance(p_data, dict) else "unknown"
            },
            "wal": wal_report,
            "cas": cas_stats,
            "system": {
                "load_avg_1m": load1,
                "timestamp": time.time()
            }
        }

        url = f"{self.web_url}/api/agent/register-heartbeat"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Arca-Token": self.config.get("auth_token", "")
            },
            method="POST"
        )

        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status == 200:
                body = json.loads(resp.read().decode("utf-8"))
                # If server sent back pending commands, we can process them
                if "pending_command" in body and body["pending_command"]:
                    logger.info(f"Received pending command from server: {body['pending_command']}")
