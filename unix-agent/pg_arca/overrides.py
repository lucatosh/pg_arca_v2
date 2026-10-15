"""Customer-specific settings that auto-detection cannot (or should not) guess: PGDATA, binaries, port, socket, paths, Patroni URL.

Precedence (lowest -> highest): built-in defaults < agent.conf < agent.local.json (managed from the console, validated here) < environment.
The console never sends free-form config: only whitelisted keys, each validated by the agent against the real filesystem before it is saved.
"""

import os
import re

from pg_arca.config import atomic_write_json

LOCAL_NAME = "agent.local.json"

# key -> (kind, label). The order is the order shown in the UI.
SPEC = [
    ("pg_data", "pgdata", "Data directory (PGDATA)"),
    ("pg_bin_dir", "bindir", "PostgreSQL binaries directory"),
    ("pg_port", "port", "Port"),
    ("pg_host", "host", "Connection socket or host"),
    ("pg_user", "ident", "OS / PostgreSQL user"),
    ("repo_path", "wdir", "Backup repository directory"),
    ("wal_archive_dir", "wdir", "WAL archive directory"),
    ("scratch_dir", "wdir", "Scratch directory (test restores)"),
    ("patroni_url", "url", "Patroni REST URL"),
    ("wal_archive_async", "bool", "Asynchronous WAL archiving (local spool, pushed by the agent)"),
]
# set by the console when a destination changes (not edited by hand, not listed in the settings screen): earlier locations, read only
HIDDEN = [
    ("repo_previous", "rdirs", "Previous repository locations (read-only)"),
    ("wal_previous", "rdirs", "Previous WAL archive locations (read-only)"),
    ("offsite", "offsite", "Offsite copy (S3-compatible object storage)"),       # edited through its own screen (secrets): not in the generic list
]
KINDS = {k: kind for k, kind, _ in SPEC + HIDDEN}
LABELS = {k: label for k, _, label in SPEC + HIDDEN}
# never allowed as a target for anything the agent WRITES (repo / wal / scratch), whatever the console says
_FORBIDDEN_WRITE = ("/", "/etc", "/proc", "/sys", "/dev", "/boot", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/root", "/run", "/var", "/home", "/srv", "/opt", "/mnt", "/tmp")
_FORBIDDEN_UNDER = ("/etc", "/proc", "/sys", "/dev", "/boot", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/root")
_IDENT = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
_HOST = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")


class OverrideError(ValueError):
    pass


def local_path(config):
    return config.get("_overrides_path") or os.path.join(os.path.dirname(config.get("credentials_file") or "/etc/pg-arca/credentials.json"), LOCAL_NAME)


def _abs_dir(v):
    s = str(v)
    if not s or "\x00" in s or "\n" in s or not os.path.isabs(s):
        raise OverrideError("an absolute path is required")
    parts = s.split("/")
    if ".." in parts:
        raise OverrideError("“..” is not allowed in the path")
    return os.path.normpath(s)


def validate(key, value):
    """Returns the cleaned value or raises OverrideError (message is user-facing)."""
    kind = KINDS.get(key)
    if kind is None:
        raise OverrideError("setting cannot be changed: %s" % key)
    if kind == "port":
        try:
            n = int(value)
        except (TypeError, ValueError):
            raise OverrideError("the port must be a number")
        if not 1 <= n <= 65535:
            raise OverrideError("port out of range (1-65535)")
        return n
    if kind == "ident":
        if not _IDENT.match(str(value)):
            raise OverrideError("invalid user name")
        return str(value)
    if kind == "url":
        s = str(value).strip()
        m = re.match(r"^(https?)://([^/@\s]+)(/[^\s]*)?$", s)
        if not m:
            raise OverrideError("an http(s):// URL without embedded credentials is required")
        return s.rstrip("/")
    if kind == "host":
        s = str(value).strip()
        if s.startswith("/"):
            p = _abs_dir(s)
            if not os.path.isdir(p):
                raise OverrideError("the socket directory does not exist: %s" % p)
            return p
        if not _HOST.match(s):
            raise OverrideError("invalid host")
        return s
    if kind == "bool":
        v = value if isinstance(value, bool) else str(value).strip().lower()
        if v in (True, "true", "on", "yes", "1"):
            return True
        if v in (False, "false", "off", "no", "0"):
            return False
        raise OverrideError("true or false")
    if kind == "offsite":
        from pg_arca import offsite
        try:
            return offsite.validate(value)
        except ValueError as e:
            raise OverrideError(str(e))
    if kind == "rdirs":
        vals = value if isinstance(value, list) else [x for x in str(value).split(",") if x.strip()]
        if len(vals) > 8:
            raise OverrideError("at most 8 previous locations")
        out = []
        for v in vals:
            d = _abs_dir(str(v).strip())
            if d not in out:
                out.append(d)
        return out
    p = _abs_dir(value)
    real = os.path.realpath(p)
    if kind == "pgdata":
        if not os.path.isdir(real):
            raise OverrideError("the directory does not exist: %s" % p)
        if not os.path.isfile(os.path.join(real, "PG_VERSION")) or not os.path.isfile(os.path.join(real, "global", "pg_control")):
            raise OverrideError("not a PGDATA (PG_VERSION and global/pg_control are missing). Hint: it is often a subdirectory, for example …/data/pgdata or …/16/main")
        return p
    if kind == "bindir":
        if not os.path.isdir(real):
            raise OverrideError("the directory does not exist: %s" % p)
        if not any(os.path.isfile(os.path.join(real, b)) and os.access(os.path.join(real, b), os.X_OK) for b in ("pg_ctl", "postgres")):
            raise OverrideError("it contains no executable pg_ctl/postgres")
        return p
    # wdir: somewhere the agent writes. Must exist (or its parent must) and must not be a system directory.
    if p in _FORBIDDEN_WRITE or real in _FORBIDDEN_WRITE or any(real == f or real.startswith(f + "/") for f in _FORBIDDEN_UNDER):
        raise OverrideError("system directory not allowed: use a dedicated subdirectory (for example /var/lib/pgarca/…)")
    target = real if os.path.isdir(real) else os.path.dirname(real)
    if not os.path.isdir(target):
        raise OverrideError("the parent directory does not exist: %s" % target)
    if not os.access(target, os.W_OK):
        raise OverrideError("the agent cannot write to %s" % target)
    return p


def load(config):
    path = local_path(config)
    try:
        import json
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        return {k: v for k, v in d.items() if k in KINDS}
    except (IOError, OSError, ValueError):
        return {}


def apply_to(config, overrides):
    for k, v in overrides.items():
        if k in KINDS:
            config[k] = v


def save(config, changes):
    """changes: {key: value | None}. Validates everything first; nothing is written if anything is wrong."""
    errors, clean = {}, {}
    for k, v in (changes or {}).items():
        if v is None or v == "":
            if k not in KINDS:
                errors[k] = "setting cannot be changed"
            clean[k] = None
            continue
        try:
            clean[k] = validate(k, v)
        except OverrideError as e:
            errors[k] = str(e)
    if errors:
        raise OverrideError(errors)
    cur = load(config)
    for k, v in clean.items():
        if v is None:
            cur.pop(k, None)
        else:
            cur[k] = v
    atomic_write_json(local_path(config), cur, 0o640)
    return cur


def describe(config, runtime=None):
    """What the UI shows: per setting the auto-detected value, the override (if any), the effective value and its source."""
    ov = load(config)
    inst = (runtime.instance if runtime else None) or {}
    detected = {"pg_data": inst.get("data_directory") or "", "pg_port": inst.get("port") or "", "pg_host": inst.get("socket_directory") or "",
                "pg_user": (getattr(getattr(runtime, "db", None), "user", None) or "postgres") if runtime else "postgres", "pg_bin_dir": inst.get("bin_dir") or inst.get("bindir") or "",
                "repo_path": "/var/lib/pgarca/repo", "wal_archive_dir": "/var/lib/pgarca/wal", "scratch_dir": "/var/tmp/pg_arca_scratch",
                "patroni_url": ("http://127.0.0.1:%s" % runtime.patroni_info["restapi_port"]) if runtime and getattr(runtime, "patroni_info", None) else "",
                "wal_archive_async": "false"}
    env_keys = {"pg_data": "PG_ARCA_PGDATA", "repo_path": "PG_ARCA_REPO", "wal_archive_dir": "WAL_ARCHIVE_DIR", "patroni_url": "PATRONI_URL", "pg_port": "PGPORT"}
    out = []
    for key, kind, label in SPEC:
        env = env_keys.get(key)
        if env and os.environ.get(env):
            source, effective = "environment (%s)" % env, config.get(key)
        elif key in ov:
            source, effective = "set here", ov[key]
        elif config.get(key):
            source, effective = "agent.conf", config.get(key)
        else:
            source, effective = "detected", detected.get(key, "")
        check = None
        if key in ov:
            try:
                validate(key, ov[key]); check = {"ok": True}
            except OverrideError as e:
                check = {"ok": False, "message": str(e)}
        out.append({"key": key, "label": label, "kind": kind, "detected": detected.get(key, ""), "override": ov.get(key), "effective": effective, "source": source, "check": check})
    return out
