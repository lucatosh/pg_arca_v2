#!/usr/bin/env python3
"""
pg_arca Enterprise Node Agent Daemon
====================================
High-Performance, Zero-Downtime PostgreSQL Physical Archiver & Cluster Manager.
Runs as a systemd service on each Ubuntu/Debian/RHEL cluster node.

Supports:
 - Inbound REST API server (with Token/Basic/Socket authentication)
 - Outbound Phone-Home Heartbeat Client (for NAT/firewalled private VPCs)
 - Surgical Granular PITR Engine with Ephemeral Sandbox Isolation
 - Continuous WAL Archiving with Gap Detection & Verification
 - CAS (Content-Addressed Storage) Page-Level Deduplication
 - Patroni DCS Orchestration & Zero-Downtime Rolling Restarts
"""

import os
import sys
import signal
import logging

# Ensure local package import
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pg_arca.config import load_config
from pg_arca.db_client import PostgresClient
from pg_arca.patroni_bridge import PatroniBridge
from pg_arca.cas_engine import CasStore
from pg_arca.wal_manager import WalManager
from pg_arca.granular_restore import GranularRestoreEngine
from pg_arca.heartbeat_client import HeartbeatClient
from pg_arca.api_server import ThreadingSimpleServer, make_agent_handler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("pg_arca_agent")


def main():
    config = load_config()
    logger.info("==================================================================")
    logger.info("   pg_arca Enterprise Node Agent v1.0.0 (Unix Daemon)")
    logger.info("==================================================================")
    logger.info(f"[*] Node Name:        {config.get('node_name')}")
    logger.info(f"[*] Cluster ID:       {config.get('cluster_id')}")
    logger.info(f"[*] Environment:      {config.get('environment')}")
    logger.info(f"[*] Auth Mode:         {config.get('auth_mode')}")
    logger.info(f"[*] Connection Mode:   {config.get('connection_mode')}")
    logger.info(f"[*] Repo Vault:       {config.get('repo_path')}")
    logger.info(f"[*] WAL Archive Dir:  {config.get('wal_archive_dir')}")
    logger.info(f"[*] Patroni REST:     {config.get('patroni_url')}")
    logger.info("==================================================================")

    # Initialize Components
    db_client = PostgresClient(
        user=config.get("pg_user", "postgres"),
        port=config.get("pg_port", 5432),
        host=config.get("pg_host", "127.0.0.1")
    )
    patroni_bridge = PatroniBridge(config.get("patroni_url", "http://127.0.0.1:8008"))
    cas_store = CasStore(config.get("repo_path", "/var/lib/pgarca/repo"))
    wal_manager = WalManager(
        wal_dir=config.get("wal_archive_dir", "/var/lib/postgresql/wal_archive"),
        compression=config.get("compression", "zstd")
    )
    restore_engine = GranularRestoreEngine(config, cas_store, wal_manager, db_client)

    # 1. Outbound Push Client (if configured)
    hb_client = None
    if config.get("connection_mode") in ("push_client", "hybrid") and config.get("auto_register"):
        hb_client = HeartbeatClient(config, db_client, wal_manager, cas_store, patroni_bridge)
        hb_client.start()
        logger.info(f"[+] Outbound Heartbeat worker active -> {config.get('web_server_url')}")

    # 2. Inbound REST API Server (if daemon or hybrid)
    if config.get("connection_mode") in ("daemon", "hybrid"):
        listen_host = config.get("listen_host", "0.0.0.0")
        listen_port = config.get("listen_port", 9898)
        handler_cls = make_agent_handler(config, db_client, wal_manager, cas_store, patroni_bridge, restore_engine)
        httpd = ThreadingSimpleServer((listen_host, listen_port), handler_cls)

        def shutdown_handler(signum, frame):
            logger.info("\n[!] Received termination signal. Shutting down gracefully...")
            if hb_client:
                hb_client.stop()
            httpd.server_close()
            sys.exit(0)

        signal.signal(signal.SIGINT, shutdown_handler)
        signal.signal(signal.SIGTERM, shutdown_handler)

        logger.info(f"[+] Listening for incoming API requests on {listen_host}:{listen_port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            shutdown_handler(None, None)
    else:
        # Push client only mode: keep main thread alive
        logger.info("[+] Running in outbound-only client mode. Waiting for events...")
        try:
            while True:
                signal.pause()
        except KeyboardInterrupt:
            if hb_client:
                hb_client.stop()
            sys.exit(0)


if __name__ == "__main__":
    main()
