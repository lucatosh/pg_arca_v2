"""
pg_arca Configuration Module
=============================
Handles configuration loading from /etc/pg-arca/agent.conf, environment variables,
and sensible production defaults.
"""

import os
import json
import logging

DEFAULT_CONF_PATH = os.environ.get("PG_ARCA_CONF", "/etc/pg-arca/agent.conf")

DEFAULT_CONFIG = {
    # Node & Cluster Identity
    "node_name": os.uname().nodename,
    "cluster_id": "cluster-prod-01",
    "environment": "prod",

    # Connectivity & Security Modes
    # connection_mode: "daemon" (inbound HTTP), "push_client" (outbound heartbeat), "hybrid" (both), "cli_socket" (Unix socket only)
    "connection_mode": "hybrid",
    "listen_host": "0.0.0.0",
    "listen_port": 9898,
    "socket_path": "/var/run/pg-arca/agent.sock",

    # Authentication: "token", "basic", "mutual_tls", "unix_socket_only", "open"
    "auth_mode": "token",
    "auth_token": "arca-secret-token-change-me",
    "basic_auth_user": "arca_admin",
    "basic_auth_password": "",
    "tls_cert_file": "",
    "tls_key_file": "",

    # Web Management UI Bridge (Outbound Push Mode)
    "web_server_url": os.environ.get("PG_ARCA_WEB_URL", "http://127.0.0.1:3000"),
    "heartbeat_interval_seconds": 10,
    "auto_register": True,

    # PostgreSQL Local Settings
    "pg_user": os.environ.get("PGUSER", "postgres"),
    "pg_port": int(os.environ.get("PGPORT", 5432)),
    "pg_host": "127.0.0.1",
    "pg_data": os.environ.get("PGDATA", "/var/lib/postgresql/data"),
    "patroni_url": os.environ.get("PATRONI_URL", "http://127.0.0.1:8008"),

    # Storage Paths
    "repo_path": os.environ.get("PG_ARCA_REPO", "/var/lib/pgarca/repo"),
    "wal_archive_dir": os.environ.get("WAL_ARCHIVE_DIR", "/var/lib/postgresql/wal_archive"),
    "scratch_dir": os.environ.get("PG_ARCA_SCRATCH", "/var/tmp/pg_arca_scratch"),
    "safety_snapshot_dir": os.environ.get("PG_ARCA_SAFETY_DIR", "/var/lib/pgarca/safety_snapshots"),

    # Compression & Storage Tuning
    "compression": "zstd", # zstd, lz4, gzip
    "compression_level": 3,
    "chunk_size_bytes": 65536, # 64 KiB = 8 x 8192 bytes PostgreSQL blocks

    # Safety Guardrails
    "safety_require_admin_confirmation_for_inplace": True,
    "safety_enforce_preflight_amcheck": True,
    "safety_max_scratch_disk_usage_percent": 90,
}


def load_config(conf_path=None):
    """Loads configuration with hierarchy: config file -> environment variables -> defaults."""
    config = dict(DEFAULT_CONFIG)
    target_path = conf_path or DEFAULT_CONF_PATH

    if os.path.exists(target_path):
        try:
            with open(target_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                config.update(loaded)
        except Exception as e:
            logging.warning(f"Could not parse config file {target_path}: {e}")

    # Override from Environment Variables
    if os.environ.get("PG_ARCA_PORT"):
        config["listen_port"] = int(os.environ["PG_ARCA_PORT"])
    if os.environ.get("PG_ARCA_AUTH_TOKEN"):
        config["auth_token"] = os.environ["PG_ARCA_AUTH_TOKEN"]
    if os.environ.get("PG_ARCA_AUTH_MODE"):
        config["auth_mode"] = os.environ["PG_ARCA_AUTH_MODE"]
    if os.environ.get("PG_ARCA_CONNECTION_MODE"):
        config["connection_mode"] = os.environ["PG_ARCA_CONNECTION_MODE"]
    if os.environ.get("PG_ARCA_WEB_URL"):
        config["web_server_url"] = os.environ["PG_ARCA_WEB_URL"]
    if os.environ.get("PG_ARCA_REPO"):
        config["repo_path"] = os.environ["PG_ARCA_REPO"]
    if os.environ.get("WAL_ARCHIVE_DIR"):
        config["wal_archive_dir"] = os.environ["WAL_ARCHIVE_DIR"]
    if os.environ.get("PATRONI_URL"):
        config["patroni_url"] = os.environ["PATRONI_URL"]

    return config
