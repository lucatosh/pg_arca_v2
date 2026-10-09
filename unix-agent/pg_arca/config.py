"""
pg_arca agent configuration
===========================
Precedence: environment variables > /etc/pg-arca/agent.conf (JSON) > safe defaults.

Security defaults:
  * No shared secret exists in the config. The agent authenticates to the console with a
    per-node secret obtained at enrollment and stored in credentials.json (0600, atomic write).
  * The inbound HTTP API is OFF unless connection_mode includes "daemon", binds to 127.0.0.1
    by default and refuses to start without a non-trivial token.
  * TLS verification is ON; to trust a private CA set tls_ca_file. Disabling verification
    requires the explicit key tls_insecure_skip_verify=true and is logged loudly.
Python 3.6+ (RHEL 8) compatible, stdlib only.
"""

import json
import logging
import os
import sys
import socket
import tempfile

DEFAULT_CONF_PATH = os.environ.get("PG_ARCA_CONF", "/etc/pg-arca/agent.conf")

DEFAULT_CONFIG = {
    # identity (empty = derived from host / discovery)
    "node_name": "",
    "environment": "prod",

    # console link. connection_mode: "push" (outbound only, recommended), "daemon" (inbound API only), "hybrid"
    "connection_mode": "push",
    "web_server_url": "",
    "enrollment_token": "",
    "credentials_file": "/etc/pg-arca/credentials.json",
    "heartbeat_interval_seconds": 10,
    "discovery_interval_seconds": 600,
    "tls_ca_file": "",
    "tls_insecure_skip_verify": False,

    # optional inbound API
    "listen_host": "127.0.0.1",
    "listen_port": 9898,
    "auth_token": "",

    # local PostgreSQL access (agent runs as the postgres OS user -> peer auth over the socket)
    "pg_user": "postgres",
    "pg_port": 0,              # 0 = auto (discovery / postmaster.pid)
    "pg_host": "",             # "" = auto (unix socket dir from postmaster.pid)
    "pg_data": "",             # "" = auto (discovery). Explicit override only: env PG_ARCA_PGDATA or agent.conf
    "pg_data_hint": "",        # from the generic PGDATA env var: only a fallback, because many images/profiles set PGDATA to a parent dir (e.g. the postgres docker image + Patroni)
    "patroni_url": "",         # "" = auto (discovery)
    "patroni_user": "",
    "patroni_password": "",

    # storage
    "repo_path": "/var/lib/pgarca/repo",
    "wal_archive_dir": "/var/lib/pgarca/wal",
    "scratch_dir": "/var/tmp/pg_arca_scratch",
    "state_dir": "/var/lib/pgarca/state",     # operation journal lives here
    "compression": "zstd",
    "compression_level": 3,
    "encryption_key_file": "",   # path of a 0600 key file -> AES-256-GCM repository + WAL archive (python3 -m pg_arca.engine.crypt keygen <path>)
    "chunk_size_bytes": 65536,

    # guardrails
    "safety_max_scratch_disk_usage_percent": 90,
}

_WEAK_TOKENS = {"", "arca-secret-token-change-me", "changeme", "password", "token"}


def load_config(conf_path=None):
    config = dict(DEFAULT_CONFIG)
    target = conf_path or DEFAULT_CONF_PATH
    if os.path.exists(target):
        try:
            with open(target, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            config.update({k: v for k, v in loaded.items() if not k.startswith("_")})
        except Exception as e:  # a broken config must be loud, not silently ignored
            raise SystemExit("FATAL: cannot parse %s: %s" % (target, e))
    elif conf_path:
        raise SystemExit("FATAL: config file %s does not exist" % conf_path)

    env_map = {
        "PG_ARCA_WEB_URL": "web_server_url", "PG_ARCA_ENROLL_TOKEN": "enrollment_token", "PG_ARCA_NODE_NAME": "node_name",
        "PG_ARCA_ENVIRONMENT": "environment", "PG_ARCA_CONNECTION_MODE": "connection_mode", "PG_ARCA_AUTH_TOKEN": "auth_token",
        "PG_ARCA_REPO": "repo_path", "WAL_ARCHIVE_DIR": "wal_archive_dir", "PATRONI_URL": "patroni_url", "PG_ARCA_PGDATA": "pg_data", "PGDATA": "pg_data_hint",
        "PG_ARCA_TLS_CA": "tls_ca_file",
    }
    try:                                                   # console-managed, validated overrides (see overrides.py); environment still wins
        from pg_arca import overrides as _ov
        config["_overrides_path"] = os.path.join(os.path.dirname(os.path.abspath(target)), _ov.LOCAL_NAME)
        _ov.apply_to(config, _ov.load(config))
    except Exception as e:                                 # never let a bad overrides file stop the agent
        sys.stderr.write("WARN: ignoring %s: %s\n" % (_ov.LOCAL_NAME if "_ov" in dir() else "overrides", e))
    for env, key in env_map.items():
        if os.environ.get(env):
            config[key] = os.environ[env]
    for env, key in (("PG_ARCA_PORT", "listen_port"), ("PGPORT", "pg_port")):
        if os.environ.get(env):
            config[key] = int(os.environ[env])

    if not config["node_name"]:
        config["node_name"] = socket.gethostname().split(".")[0]
    return config


def validate(config):
    """Returns a list of fatal problems (empty list = OK)."""
    problems = []
    mode = config.get("connection_mode")
    if mode not in ("push", "daemon", "hybrid"):
        problems.append("connection_mode must be push|daemon|hybrid (got %r)" % mode)
    if mode in ("push", "hybrid") and not config.get("web_server_url"):
        problems.append("web_server_url is required for push/hybrid mode")
    if mode in ("daemon", "hybrid") and str(config.get("auth_token", "")).strip() in _WEAK_TOKENS:
        problems.append("inbound API requires a strong auth_token (>=24 chars); refusing to start with an empty/default token")
    if mode in ("daemon", "hybrid") and len(str(config.get("auth_token", ""))) < 24:
        problems.append("auth_token too short (<24 chars)")
    url = config.get("web_server_url", "")
    if url and not (url.startswith("https://") or url.startswith("http://")):
        problems.append("web_server_url must start with http:// or https://")
    return problems


def load_credentials(config):
    try:
        with open(config["credentials_file"], "r", encoding="utf-8") as f:
            c = json.load(f)
        if c.get("node_id") and c.get("agent_token"):
            return c
    except Exception:
        pass
    return None


def atomic_write_json(path, data, mode=0o600):
    """tmp + fsync + rename + fsync(dir): the file is either old or new, never torn."""
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.rename(tmp, path)
        dfd = os.open(d, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def save_credentials(config, node_id, agent_token, cluster_id=None):
    atomic_write_json(config["credentials_file"], {"node_id": node_id, "agent_token": agent_token, "cluster_id": cluster_id})
