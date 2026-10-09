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
    ("pg_data", "pgdata", "Cartella dati (PGDATA)"),
    ("pg_bin_dir", "bindir", "Cartella dei binari PostgreSQL"),
    ("pg_port", "port", "Porta"),
    ("pg_host", "host", "Socket o host di connessione"),
    ("pg_user", "ident", "Utente del sistema operativo / PostgreSQL"),
    ("repo_path", "wdir", "Cartella del repository di backup"),
    ("wal_archive_dir", "wdir", "Cartella dell’archivio WAL"),
    ("scratch_dir", "wdir", "Cartella temporanea (ripristini di prova)"),
    ("patroni_url", "url", "URL REST di Patroni"),
]
KINDS = {k: kind for k, kind, _ in SPEC}
LABELS = {k: label for k, _, label in SPEC}
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
        raise OverrideError("serve un percorso assoluto")
    parts = s.split("/")
    if ".." in parts:
        raise OverrideError("«..» non è ammesso nel percorso")
    return os.path.normpath(s)


def validate(key, value):
    """Returns the cleaned value or raises OverrideError (message is user-facing)."""
    kind = KINDS.get(key)
    if kind is None:
        raise OverrideError("impostazione non modificabile: %s" % key)
    if kind == "port":
        try:
            n = int(value)
        except (TypeError, ValueError):
            raise OverrideError("la porta deve essere un numero")
        if not 1 <= n <= 65535:
            raise OverrideError("porta fuori intervallo (1-65535)")
        return n
    if kind == "ident":
        if not _IDENT.match(str(value)):
            raise OverrideError("nome utente non valido")
        return str(value)
    if kind == "url":
        s = str(value).strip()
        m = re.match(r"^(https?)://([^/@\s]+)(/[^\s]*)?$", s)
        if not m:
            raise OverrideError("serve un URL http(s):// senza credenziali incorporate")
        return s.rstrip("/")
    if kind == "host":
        s = str(value).strip()
        if s.startswith("/"):
            p = _abs_dir(s)
            if not os.path.isdir(p):
                raise OverrideError("la cartella del socket non esiste: %s" % p)
            return p
        if not _HOST.match(s):
            raise OverrideError("host non valido")
        return s
    p = _abs_dir(value)
    real = os.path.realpath(p)
    if kind == "pgdata":
        if not os.path.isdir(real):
            raise OverrideError("la cartella non esiste: %s" % p)
        if not os.path.isfile(os.path.join(real, "PG_VERSION")) or not os.path.isfile(os.path.join(real, "global", "pg_control")):
            raise OverrideError("non è un PGDATA (mancano PG_VERSION e global/pg_control). Suggerimento: spesso è una sottocartella, per esempio …/data/pgdata o …/16/main")
        return p
    if kind == "bindir":
        if not os.path.isdir(real):
            raise OverrideError("la cartella non esiste: %s" % p)
        if not any(os.path.isfile(os.path.join(real, b)) and os.access(os.path.join(real, b), os.X_OK) for b in ("pg_ctl", "postgres")):
            raise OverrideError("non contiene pg_ctl/postgres eseguibili")
        return p
    # wdir: somewhere the agent writes. Must exist (or its parent must) and must not be a system directory.
    if p in _FORBIDDEN_WRITE or real in _FORBIDDEN_WRITE or any(real == f or real.startswith(f + "/") for f in _FORBIDDEN_UNDER):
        raise OverrideError("cartella di sistema non ammessa: usa una sottocartella dedicata (per esempio /var/lib/pgarca/…)")
    target = real if os.path.isdir(real) else os.path.dirname(real)
    if not os.path.isdir(target):
        raise OverrideError("la cartella superiore non esiste: %s" % target)
    if not os.access(target, os.W_OK):
        raise OverrideError("l’agent non può scrivere in %s" % target)
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
                errors[k] = "impostazione non modificabile"
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
                "pg_user": "postgres", "pg_bin_dir": inst.get("bin_dir") or inst.get("bindir") or "",
                "repo_path": "/var/lib/pgarca/repo", "wal_archive_dir": "/var/lib/pgarca/wal", "scratch_dir": "/var/tmp/pg_arca_scratch",
                "patroni_url": ("http://127.0.0.1:%s" % runtime.patroni_info["restapi_port"]) if runtime and getattr(runtime, "patroni_info", None) else ""}
    env_keys = {"pg_data": "PG_ARCA_PGDATA", "repo_path": "PG_ARCA_REPO", "wal_archive_dir": "WAL_ARCHIVE_DIR", "patroni_url": "PATRONI_URL", "pg_port": "PGPORT"}
    out = []
    for key, kind, label in SPEC:
        env = env_keys.get(key)
        if env and os.environ.get(env):
            source, effective = "ambiente (%s)" % env, config.get(key)
        elif key in ov:
            source, effective = "impostato qui", ov[key]
        elif config.get(key):
            source, effective = "agent.conf", config.get(key)
        else:
            source, effective = "rilevato", detected.get(key, "")
        check = None
        if key in ov:
            try:
                validate(key, ov[key]); check = {"ok": True}
            except OverrideError as e:
                check = {"ok": False, "message": str(e)}
        out.append({"key": key, "label": label, "kind": kind, "detected": detected.get(key, ""), "override": ov.get(key), "effective": effective, "source": source, "check": check})
    return out
