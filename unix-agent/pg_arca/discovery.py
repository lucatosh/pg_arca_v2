"""
pg_arca real auto-discovery engine
==================================
Everything reported here is *observed on the host*; nothing is assumed or
defaulted. If PostgreSQL is not found, the result is simply empty.

Evidence sources (in order of trust):
  1. /proc            running processes, cwd, uid, open sockets  (no privileges needed
                      for own processes; root sees everything)
  2. PGDATA files     postmaster.pid, PG_VERSION, global/pg_control (system_identifier),
                      postgresql.conf / postgresql.auto.conf, standby.signal,
                      pg_tblspc symlinks
  3. Patroni          patroni.yml found from the process command line + live REST probe
  4. systemd          unit state (informational)
  5. Config files    pgbouncer.ini, etcd conf, pgbackrest.conf (migration hint)

Compatible with Python 3.6+ (RHEL 8) and stdlib only.
"""

import glob
import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import struct
import subprocess
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("pg_arca.discovery")

SCHEMA_VERSION = 2

PG_INTERESTING_PARAMS = (
    "port", "listen_addresses", "unix_socket_directories", "wal_level", "archive_mode",
    "archive_command", "archive_timeout", "max_wal_senders", "max_connections",
    "wal_log_hints", "data_checksums", "shared_preload_libraries", "hot_standby",
    "primary_conninfo", "restore_command", "max_wal_size", "data_directory",
    "hba_file", "ident_file", "cluster_name", "ssl", "log_directory", "log_filename", "logging_collector",
)

EXTRA_CONFIG_GLOBS = [
    "/etc/patroni*.y*ml", "/etc/patroni/*.y*ml", "/opt/patroni/*.y*ml",
    "/etc/postgresql*/**/postgresql.conf", "/var/lib/pgsql/**/postgresql.conf",
    "/etc/pgbouncer/pgbouncer.ini", "/etc/pgbackrest/pgbackrest.conf",
    "/etc/pgbackrest.conf", "/etc/etcd/etcd.conf*", "/etc/default/etcd",
]

# the PostgreSQL server binary under its names (EDB Postgres Advanced Server: edb-postgres)
POSTMASTER_EXES = ("postgres", "postmaster", "edb-postgres")

# where data directories live when nothing runs: PGDG/RHEL, Debian/Ubuntu, source builds, EDB (RHEL / Debian), FreeBSD, SUSE / Alpine / Arch
DATA_GLOBS = ("/var/lib/pgsql/*/data", "/var/lib/pgsql/data", "/var/lib/postgresql/*/*", "/var/lib/postgresql/data", "/usr/local/pgsql/data",
              "/var/lib/edb/as*/data", "/var/lib/edb-as/*/*", "/var/db/postgres/data*", "/var/lib/postgres/data")

SERVICE_PATTERN = re.compile(r"(postgres|patroni|etcd|pgbouncer|haproxy|pgbackrest|pg-arca|pgpool|repmgr|keepalived)", re.I)


# ----------------------------------------------------------------------------
# small helpers
# ----------------------------------------------------------------------------
def _read(path: str, limit: int = 256 * 1024) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(limit)
    except Exception:
        return None


def _run(cmd: List[str], timeout: float = 4.0, env: Optional[Dict[str, str]] = None) -> Tuple[bool, str]:
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, encoding="utf-8", errors="replace", timeout=timeout, env=env)
        return p.returncode == 0, (p.stdout or "").strip()
    except Exception:
        return False, ""


def _tls_context(cafiles=(), certfile=None, keyfile=None):
    """Verification for a Patroni REST API over https: the system store plus Patroni's own CA (ctl.cacert / restapi.cafile) - an internal PKI is the
    rule - and the client certificate patronictl uses when the API requires one (restapi.verify_client)."""
    import ssl
    ctx = ssl.create_default_context()
    for ca in cafiles:
        if ca:
            try:
                ctx.load_verify_locations(cafile=ca)
            except (OSError, ssl.SSLError):
                pass
    if certfile:
        try:
            ctx.load_cert_chain(certfile, keyfile or None)
        except (OSError, ssl.SSLError):
            pass
    return ctx


def _http_json(url: str, timeout: float = 1.5, headers: Optional[Dict[str, str]] = None, context=None) -> Tuple[int, Any]:
    req = urllib.request.Request(url, headers=dict({"User-Agent": "pg_arca-agent"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=context) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:  # Patroni answers 503 for non-leader health endpoints, body is still JSON
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return e.code, None
    except Exception:
        return 0, None


_SECRET_RES = (re.compile(r"\b(password|passwd|pwd|sslpassword)\s*=\s*('(?:[^'\\]|\\.)*'|\"[^\"]*\"|\S+)", re.I),
                re.compile(r"\b(PGPASSWORD|[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|ACCESS_KEY)[A-Z0-9_]*)=(\S+)"))


def _scrub(v: str) -> str:
    """A setting's value without the secret part of credentials written into it."""
    for r in _SECRET_RES:
        v = r.sub(lambda m: m.group(1) + "=***", v)
    return v


def parse_conf(text: str) -> Dict[str, str]:
    """Parse postgresql.conf style 'key = value  # comment' lines (last one wins, like PG)."""
    out = {}  # type: Dict[str, str]
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z_][\w.]*)\s*(?:=|\s)\s*(.*)$", line)
        if not m:
            continue
        key, val = m.group(1).lower(), m.group(2).strip()
        if val.startswith("'"):
            end = val.find("'", 1)
            while end != -1 and val[end - 1:end + 1] == "\\'":
                end = val.find("'", end + 1)
            val = val[1:end] if end != -1 else val[1:]
        else:
            val = val.split("#", 1)[0].strip()
        out[key] = val
    return out


def _flow_split(s):
    """Split a YAML flow collection's content on the commas that are not inside quotes or nested brackets."""
    out, cur, depth, q = [], "", 0, None
    for ch in s:
        if q:
            cur += ch
            if ch == q:
                q = None
            continue
        if ch in "'\"":
            q = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(cur)
            cur = ""
            continue
        cur += ch
    if cur.strip():
        out.append(cur)
    return out


def _strip_comment(v):
    """The value without a trailing comment: '#' starts a comment only outside quotes and after a blank (YAML), so 'pa#ss' and "a #b" are values."""
    q = None
    i = 0
    while i < len(v):
        ch = v[i]
        if q == '"' and ch == "\\":
            i += 2
            continue
        if q:
            if ch == q:
                q = None
        elif ch in "'\"" and (i == 0 or v[i - 1] in " \t[{,:"):
            q = ch
        elif ch == "#" and (i == 0 or v[i - 1] in " \t"):
            return v[:i].rstrip()
        i += 1
    return v.rstrip()


def _yaml_scalar(v):
    v = _strip_comment(v).strip()
    if len(v) >= 2 and v[0] == v[-1] == '"':
        try:
            return json.loads(v)
        except ValueError:
            return v[1:-1]
    if len(v) >= 2 and v[0] == v[-1] == "'":
        return v[1:-1].replace("''", "'")
    if v.startswith("[") and v.endswith("]"):
        return [_yaml_scalar(x) for x in _flow_split(v[1:-1]) if x.strip()]
    if v.startswith("{") and v.endswith("}"):
        # inline maps ({username: rewinder, password: "rw"}) - common in patroni.yml; without PyYAML (python:3.6 platform-python, slim
        # images) they used to come back as one string and the geo rewind crashed reading its credentials (multi-OS matrix, 16/10)
        out = {}
        for part in _flow_split(v[1:-1]):
            if ":" in part:
                kk, vv = part.split(":", 1)
                out[kk.strip().strip("'\"")] = _yaml_scalar(vv)
        return out
    low = v.lower()
    if low in ("true", "yes", "on"):                          # YAML 1.1, as PyYAML (and so Patroni) reads it
        return True
    if low in ("false", "no", "off"):
        return False
    if low in ("~", "null", ""):
        return None if v else ""
    if re.match(r"^-?\d+$", v):
        return int(v)
    return v


def _yaml_key(s):
    """(key, rest) of a 'key: value' line, or None. A quoted key may contain ':'; an unquoted one ends at the first ': ' (so 'listen: 10.0.0.5:8008' works)."""
    if s[:1] in "'\"":
        end = s.find(s[0], 1)
        if end > 0 and s[end + 1:].lstrip().startswith(":"):
            rest = s[end + 1:].lstrip()[1:]
            if rest == "" or rest[0] in " \t":
                return s[1:end], rest.strip()
        return None
    m = re.match(r"^([^:#][^:]*?)\s*:(?:[ \t]+(.*)|)$", s)
    return (m.group(1), (m.group(2) or "").strip()) if m else None


def parse_simple_yaml(text: str) -> Dict[str, Any]:
    """
    YAML reader sufficient for patroni.yml without PyYAML (python 3.6 platform-python, slim images): block maps and lists (also lists of maps and
    lists at the parent's indentation), quoted scalars ('#' inside quotes is not a comment), flow [..] / {..}, block scalars (| and >), anchors,
    aliases and '<<' merges (independent review: `authentication: *restauth` came back as the string '*restauth', a `post_init: |` script leaked its lines
    as keys of the section). Uses PyYAML when installed.
    """
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(text)
        return data if isinstance(data, dict) else {}
    except Exception:
        pass

    lines = text.splitlines()
    root = {}  # type: Dict[str, Any]
    stack = [(-1, root)]          # (indent, container)
    last_key = {}                 # id(container) -> last key set in it
    owner = {}                    # id(placeholder dict) -> (parent, key): an empty value may turn out to be a list
    anchors = {}                  # name -> (container, key) | ("value", v)

    def resolve(name):
        ref = anchors.get(name)
        if ref is None:
            return None
        if ref[0] == "value":
            return ref[1]
        return ref[0].get(ref[1])

    def block(i, indent, style):
        """Lines of a block scalar after line i-1 (more indented than its key). Returns (text, next index)."""
        body = []
        while i < len(lines):
            ln = lines[i]
            if ln.strip() and (len(ln) - len(ln.lstrip(" "))) <= indent:
                break
            body.append(ln)
            i += 1
        while body and not body[-1].strip():
            body.pop()
        ind = min([len(x) - len(x.lstrip(" ")) for x in body if x.strip()] or [0])
        body = [x[ind:] for x in body]
        if style.startswith(">"):
            out, para = [], []
            for x in body:
                if x.strip():
                    para.append(x.strip())
                else:
                    out.append(" ".join(para))
                    para = []
            out.append(" ".join(para))
            txt = "\n".join(out)
        else:
            txt = "\n".join(body)
        return (txt if "-" in style else txt + "\n"), i

    def put(container, indent, s, i):
        kv = _yaml_key(s)
        if kv is None:
            return i
        k, v = kv
        v = _strip_comment(v)
        anchor = None
        if v.startswith("&"):
            parts = v.split(None, 1)
            anchor, v = parts[0][1:], (parts[1] if len(parts) > 1 else "")
        if k == "<<" and v.startswith("*"):
            src = resolve(v[1:].strip())
            if isinstance(src, dict):
                for kk, vv in src.items():
                    container.setdefault(kk, vv)
            return i
        if v == "":
            child = {}  # type: Dict[str, Any]
            container[k] = child
            owner[id(child)] = (container, k)
            stack.append((indent, child))
        elif re.match(r"^[|>][-+0-9]*$", v):
            container[k], i = block(i, indent, v)
        elif v.startswith("*"):
            container[k] = resolve(v[1:].strip())
        else:
            container[k] = _yaml_scalar(v)
        last_key[id(container)] = k
        if anchor:
            anchors[anchor] = (container, k)
        return i

    def list_of(container):
        if id(container) in owner:
            parent, key = owner[id(container)]
            if isinstance(parent.get(key), list):
                return parent[key]
            if parent.get(key) is container and not container:
                parent[key] = []
                return parent[key]
        key = last_key.get(id(container))
        if key is None:
            return None
        if not isinstance(container.get(key), list):
            container[key] = []
        return container[key]

    i = 0
    while i < len(lines):
        raw = lines[i]
        i += 1
        s = raw.strip()
        if not s or s.startswith("#") or s in ("---", "..."):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        container = stack[-1][1]
        if s == "-" or s.startswith("- "):
            lst = list_of(container)
            if lst is None:
                continue
            item = _strip_comment(s[1:].strip())               # "- host all all 0/0 scram  # comment: x" is a string, not a map
            kv = _yaml_key(item) if item and item[0] not in "[{" else None
            if kv is not None and not item.startswith(("'", '"')) or (kv is not None and kv[1] != ""):
                d = {}  # type: Dict[str, Any]
                lst.append(d)
                stack.append((indent, d))
                i = put(d, indent + 2, item, i)
            elif item.startswith("*"):
                lst.append(resolve(item[1:].strip()))
            else:
                lst.append(_yaml_scalar(item))
            continue
        i = put(container, indent, s, i)
    return root


def read_system_identifier(pgdata: str) -> Optional[str]:
    """First 8 bytes of global/pg_control are the cluster's system_identifier (uint64, host endian)."""
    try:
        with open(os.path.join(pgdata, "global", "pg_control"), "rb") as f:
            raw = f.read(8)
        if len(raw) == 8:
            return str(struct.unpack("=Q", raw)[0])
    except Exception:
        pass
    return None


# ----------------------------------------------------------------------------
# engine
# ----------------------------------------------------------------------------
def advise(scan: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Readiness / hygiene findings derived from what discovery saw. Every finding says what is wrong and what to do about it."""
    out: List[Dict[str, Any]] = []

    def add(sev, code, title, detail, fix="", target=""):
        out.append({"severity": sev, "code": code, "title": title, "detail": detail, "fix": fix, "target": target})

    tc = scan.get("toolchain") or {}
    if not tc.get("psql"):
        add("critical", "NO_PSQL", "psql not found", "The agent uses psql to query PostgreSQL and to run backups and restores.", "Install the PostgreSQL client package.", "host")
    if not tc.get("pg_waldump"):
        add("info", "NO_WALDUMP", "pg_waldump not found", "Without pg_waldump, DROP/TRUNCATE cannot be searched in the WAL.", "Install the PostgreSQL server binaries (postgresql-NN).", "host")
    if not tc.get("python_zstandard"):                         # the zstd COMMAND only serves the WAL archive: the backup chunks need the python module
        add("warning", "NO_ZSTD", "zstd compression not available for backups", "Chunks will be compressed with zlib: measured 5 to 10 times slower per core (in the lab a 10 GB backup took 12 minutes at ~14 MB/s).", "Install the python3-zstandard package (Debian/Ubuntu; EPEL on RHEL) or pip install zstandard for the agent's Python.", "host")
    running = [i for i in scan.get("postgres_instances") or [] if i.get("running") and not i.get("pgarca_owned")]
    if len(running) > 1:
        add("warning", "MULTI_INSTANCE", "Several PostgreSQL instances running on this server",
            "The agent manages ONE of them (%s); the others are neither backed up nor shown as clusters." % ", ".join("%s:%s" % (i.get("data_directory"), i.get("port")) for i in running),
            "Install one agent per additional instance: run the installer again with PG_ARCA_INSTANCE=<name> PG_ARCA_PGDATA=<data directory> (separate configuration, state and service: pg-arca-agent-<name>). To change the one managed by this agent, set pg_data in its settings.", "host")
    for i in scan.get("postgres_instances") or []:
        tgt = i.get("data_directory", "")
        st = i.get("settings") or {}
        ar = i.get("archiving") or {}
        ctl = i.get("control") or {}
        try:
            major = int(str(i.get("major_version") or "0").split(".")[0])
        except ValueError:
            major = 0
        if not i.get("readable_by_agent", True):
            add("critical", "UNREADABLE", "Data directory not readable by the agent", "Without access to the files the agent cannot take backups.", "Run the agent as the postgres user (or root).", tgt)
        cm = i.get("compat")
        if not cm and i.get("major_version"):
            try:
                from pg_arca.pgcompat import Profile
                cm = Profile.from_text(i["major_version"]).describe()
            except Exception:
                cm = None
        cm = cm or {}
        for pr in cm.get("problems") or []:
            title = {"unsupported": "PostgreSQL %s not supported" % cm.get("label"), "legacy": "PostgreSQL %s in legacy mode" % cm.get("label"),
                     "newer": "PostgreSQL %s newer than the verified versions" % cm.get("label"), "eol": "PostgreSQL %s is end-of-life (EOL %s)" % (cm.get("label"), cm.get("eol_date"))}.get(pr["code"], pr["code"])
            add(pr["severity"], "PG_" + pr["code"].upper(), title, pr["text"], "Plan an upgrade to a supported version (16 or later)." if pr["code"] in ("unsupported", "legacy", "eol") else "Run a test restore (drill) before relying on the backups.", tgt)
        if not i.get("running"):
            add("warning", "NOT_RUNNING", "Instance not running", "Backups need PostgreSQL running (restores into a directory do not).", "Start PostgreSQL.", tgt)
        mode = (ar.get("archive_mode") or "off").lower()
        if mode == "off":
            add("warning", "ARCHIVE_OFF", "WAL archiving is off", "Without archived WAL there is no point-in-time recovery.", "archive_mode = on; archive_command = '/usr/local/bin/pg-arca-wal archive %p %f' (requires a restart).", tgt)
        elif ar.get("foreign_tool"):
            add("warning", "ARCHIVE_FOREIGN", "Archiving is managed by %s" % ar["foreign_tool"], "Replacing archive_command breaks that backup chain.", "Consider a guided migration: do not change archive_command on the fly.", tgt)
        if (ctl.get("wal_level") or ar.get("wal_level")) == "minimal":
            add("critical", "WAL_MINIMAL", "wal_level = minimal", "With wal_level minimal you can neither archive nor replicate.", "wal_level = replica (requires a restart).", tgt)
        if ctl.get("available") and not ctl.get("data_checksums") and (st.get("wal_log_hints") or "off") != "on":
            add("info", "NO_CHECKSUMS", "Incremental backups cannot be enabled", "data_checksums or wal_log_hints is needed to tell changed pages apart; only full backups are possible now.", "wal_log_hints = on (restart) or pg_checksums --enable with the instance stopped.", tgt)
        if st.get("ssl") and st["ssl"] != "on":
            add("warning", "SSL_OFF", "TLS off", "Connections are not encrypted and hostssl rules cannot match.", "ssl = on with a certificate and key configured.", tgt)
        if (st.get("fsync") or "on") == "off" or (st.get("full_page_writes") or "on") == "off":
            add("critical", "UNSAFE_DURABILITY", "fsync / full_page_writes disabled", "A crash can corrupt the data and physical backups are not consistent.", "Turn fsync and full_page_writes back on.", tgt)
    for pc in scan.get("patroni_clusters") or []:
        if not pc.get("rest_reachable", True) and pc.get("restapi_url"):
            add("warning", "PATRONI_REST", "Patroni REST API unreachable", "Switchover, failover and HA changes are not possible from here.", "Check restapi.listen / credentials.", pc.get("scope", ""))
    for ec in scan.get("etcd_clusters") or []:
        n = len(ec.get("members") or [])
        if n and n % 2 == 0:
            add("warning", "ETCD_EVEN", "etcd with %d members" % n, "An even number of members does not increase fault tolerance.", "Use 3 or 5 members.", ec.get("name", ""))
        if n == 1:
            add("warning", "ETCD_SINGLE", "etcd with a single member", "If it stops, Patroni degrades the cluster.", "Use 3 members.", ec.get("name", ""))
    order = {"critical": 0, "warning": 1, "info": 2}
    out.sort(key=lambda f: order[f["severity"]])
    return out


class ClusterDiscoveryEngine:
    def __init__(self, search_paths: Optional[List[str]] = None, custom_variables: Optional[Dict[str, str]] = None,
                 pg_user: str = "postgres", patroni_cafiles: Optional[List[str]] = None, tls_insecure: bool = False):
        self.patroni_cafiles = [x for x in (patroni_cafiles or []) if x]      # the agent's own trust for Patroni (patroni_ca_file, tls_ca_file)
        self.tls_insecure = bool(tls_insecure)
        self.extra_paths = list(search_paths or [])
        self.variables = dict(custom_variables or {})
        self.pg_user = pg_user

    # ---- public --------------------------------------------------------
    def scan_all(self) -> Dict[str, Any]:
        t0 = time.time()
        procs = self._scan_processes()
        listeners = self._scan_listeners(procs)
        systemd = self._scan_systemd()

        patroni = self._discover_patroni(procs, listeners)
        instances = self._discover_postgres(procs, listeners, [pc.get("data_dir") for pc in patroni if isinstance(pc.get("data_dir"), str)])
        etcd = self._discover_etcd(procs, listeners)
        pgb = self._discover_pgbouncer(procs, listeners)
        backrest = self._discover_pgbackrest()
        self._link_patroni_to_instances(instances, patroni)

        out = {
            "schema_version": SCHEMA_VERSION,
            "node_hostname": socket.gethostname(),
            "fqdn": socket.getfqdn(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scan_duration_ms": int((time.time() - t0) * 1000),
            "run_as": {"uid": os.geteuid(), "is_root": os.geteuid() == 0},
            "toolchain": self._toolchain(),
            "summary": {
                "postgres_instances_found": len(instances),
                "patroni_clusters_found": len(patroni),
                "etcd_clusters_found": len(etcd),
                "pgbouncer_instances_found": len(pgb),
                "pgbackrest_stanzas_found": sum(len(b.get("stanzas", [])) for b in backrest),
            },
            "postgres_instances": instances,
            "patroni_clusters": patroni,
            "etcd_clusters": etcd,
            "pgbouncer_instances": pgb,
            "pgbackrest": backrest,
            "listening_ports": listeners,
            "systemd_services": systemd,
            "running_processes": [{k: p[k] for k in ("pid", "name", "uid", "cmdline")} for p in procs],
            "warnings": self._warnings(procs, instances),
        }
        out["findings"] = advise(out)
        out["summary"]["findings_critical"] = sum(1 for f in out["findings"] if f["severity"] == "critical")
        out["summary"]["findings_warning"] = sum(1 for f in out["findings"] if f["severity"] == "warning")
        return out

    # ---- tooling -------------------------------------------------------
    def _toolchain(self) -> Dict[str, Optional[str]]:
        names = ["psql", "pg_controldata", "pg_basebackup", "pg_waldump", "pg_amcheck",
                 "pg_ctl", "patronictl", "pgbackrest", "zstd", "systemctl"]
        found = {n: shutil.which(n) for n in names}
        # RHEL / PGDG keep binaries out of PATH: /usr/pgsql-NN/bin, Debian: /usr/lib/postgresql/NN/bin
        # newest major first by NUMBER (a text sort put /usr/pgsql-9.6 before /usr/pgsql-16)
        from pg_arca import pgaccess
        dirs = sorted({d for pat in pgaccess.VENDOR_GLOBS for d in glob.glob(pat)}, key=lambda d: (pgaccess._major_key(d), d), reverse=True)
        for d in dirs:
            for n in names:
                if not found.get(n) and os.path.exists(os.path.join(d, n)):
                    found[n] = os.path.join(d, n)
        try:
            import zstandard  # noqa: F401
            found["python_zstandard"] = "installed"
        except Exception:
            try:
                from compression import zstd  # noqa: F401           Python >= 3.14: in the standard library
                found["python_zstandard"] = "stdlib"
            except Exception:
                found["python_zstandard"] = None
        return found

    def _find_bin(self, name: str, bin_dirs: Optional[List[str]] = None) -> Optional[str]:
        for d in bin_dirs or []:
            p = os.path.join(d, name)
            if os.path.exists(p):
                return p
        return self._toolchain().get(name)

    # ---- processes -----------------------------------------------------
    @staticmethod
    def _classify(argv: List[str]) -> Optional[str]:
        """What a process is, from its command line. A Python program is named by its script or `-m` module after the interpreter's own options
        (`python3 -s /usr/bin/patroni`, `platform-python /usr/bin/patroni`, `python3 -m patroni`); PostgreSQL by the exact names of its server binary
        (postgres, postmaster, EDB's edb-postgres) or a server process title ('postgres: checkpointer') - not by a prefix, so postgres_exporter or
        postgresql-check scripts are not taken for a server (independent review)."""
        exe_name = os.path.basename(argv[0].split()[0]) if argv[0].split() else ""
        if exe_name in POSTMASTER_EXES or any(exe_name == t + ":" for t in POSTMASTER_EXES):
            return "postgres"
        script = ""
        if re.match(r"^(python[\d.]*|platform-python[\d.]*)$", exe_name):
            i = 1
            while i < len(argv):
                a = argv[i]
                if a == "-m" and i + 1 < len(argv):
                    script = argv[i + 1]
                    break
                if a.startswith("-m") and len(a) > 2:
                    script = a[2:]
                    break
                if a in ("-c",):
                    break
                if a in ("-W", "-X", "-Q"):
                    i += 2
                    continue
                if a.startswith("-"):
                    i += 1
                    continue
                script = os.path.basename(a)
                break
        for t in ("patroni", "etcd", "pgbouncer", "haproxy", "pgbackrest", "pg_arca", "pg-arca"):
            for n in (exe_name, script):
                if n and (n == t or n.startswith(t) or n.startswith(t.replace("_", "-"))):
                    return t
        return None

    def _scan_processes(self) -> List[Dict[str, Any]]:
        out = []
        for pid_s in os.listdir("/proc") if os.path.isdir("/proc") else []:
            if not pid_s.isdigit():
                continue
            base = "/proc/%s" % pid_s
            try:
                with open(base + "/cmdline", "rb") as f:
                    argv = [a for a in f.read().decode("utf-8", "replace").split("\x00") if a != ""]
            except Exception:
                continue
            if not argv:
                continue
            name = self._classify(argv)
            if name is None:
                continue
            joined = " ".join(argv)
            uid = -1
            status = _read(base + "/status", 4096) or ""
            m = re.search(r"^Uid:\s+(\d+)", status, re.M)
            ppid_m = re.search(r"^PPid:\s+(\d+)", status, re.M)
            if m:
                uid = int(m.group(1))
            try:
                cwd = os.readlink(base + "/cwd")
            except Exception:
                cwd = None
            out.append({
                "pid": int(pid_s), "ppid": int(ppid_m.group(1)) if ppid_m else 0,
                "name": name, "uid": uid, "argv": argv, "cwd": cwd, "cmdline": joined[:300],
            })
        return out

    # ---- listeners (/proc/net/tcp -> pid) ------------------------------
    def _scan_listeners(self, procs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        inode_to_pid = {}  # type: Dict[str, int]
        for p in procs:
            try:
                for fd in os.listdir("/proc/%d/fd" % p["pid"]):
                    try:
                        tgt = os.readlink("/proc/%d/fd/%s" % (p["pid"], fd))
                    except Exception:
                        continue
                    if tgt.startswith("socket:["):
                        inode_to_pid[tgt[8:-1]] = p["pid"]
            except Exception:
                continue
        pid_name = {p["pid"]: p["name"] for p in procs}
        known = {5432: "PostgreSQL", 6432: "PgBouncer", 8008: "Patroni REST", 2379: "etcd client",
                 2380: "etcd peer", 9898: "pg_arca agent", 5000: "HAProxy (rw)", 5001: "HAProxy (ro)"}
        out = []
        seen = set()
        for fname, v6 in (("/proc/net/tcp", False), ("/proc/net/tcp6", True)):
            text = _read(fname) or ""
            for line in text.splitlines()[1:]:
                f = line.split()
                if len(f) < 10 or f[3] != "0A":  # 0A = LISTEN
                    continue
                addr_hex, port_hex = f[1].rsplit(":", 1)
                port = int(port_hex, 16)
                inode = f[9]
                pid = inode_to_pid.get(inode)
                if (port, pid) in seen:
                    continue
                seen.add((port, pid))
                if pid is None and port not in known:
                    continue  # unrelated listener we cannot attribute
                loopback = addr_hex in ("0100007F", "00000000000000000000000001000000")
                out.append({"port": port, "pid": pid, "process": pid_name.get(pid),
                            "service_hint": known.get(port), "loopback_only": loopback, "ipv6": v6})
        return sorted(out, key=lambda x: x["port"])

    # ---- systemd -------------------------------------------------------
    def _scan_systemd(self) -> List[Dict[str, Any]]:
        if not shutil.which("systemctl"):
            return []
        ok, txt = _run(["systemctl", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager"], timeout=4)
        if not ok:
            return []
        out = []
        for line in txt.splitlines():
            parts = line.split(None, 4)
            if len(parts) >= 4 and SERVICE_PATTERN.search(parts[0]):
                out.append({"unit": parts[0], "load": parts[1], "active": parts[2] == "active",
                            "sub": parts[3], "description": parts[4] if len(parts) > 4 else ""})
        return out

    # ---- PostgreSQL ----------------------------------------------------
    @staticmethod
    def _is_pgdata(d: Optional[str]) -> bool:
        return bool(d) and os.path.isfile(os.path.join(d, "PG_VERSION"))

    def _postmaster_pgdata(self, p: Dict[str, Any]) -> Optional[str]:
        """The data directory of a running postmaster. Its working directory is the authority (the postmaster chdir()s into the data directory); then
        data_directory given on the command line (-c data_directory=, --data-directory=: -D is then only the configuration directory, Gentoo and
        Debian-like layouts); then -D / --pgdata, resolved against the process's own directory when relative - never the agent's (independent review:
        `pg_ctl -D data start` was reported as <agent cwd>/data). A -D that is a configuration directory leads to its postgresql.conf data_directory."""
        argv, cwd = p["argv"], p.get("cwd")
        if self._is_pgdata(cwd):
            return cwd

        def absolute(x):
            if os.path.isabs(x):
                return os.path.normpath(x)
            return os.path.normpath(os.path.join(cwd, x)) if cwd else None

        ddir, dopt = None, None
        for i, a in enumerate(argv):
            nxt = argv[i + 1] if i + 1 < len(argv) else ""
            if a == "-c" and re.match(r"^data[_-]directory=", nxt):
                ddir = nxt.split("=", 1)[1]
            elif re.match(r"^-cdata[_-]directory=", a):
                ddir = a.split("=", 1)[1]
            elif re.match(r"^--data[_-]directory=", a):
                ddir = a.split("=", 1)[1]
            elif a == "-D" and nxt:
                dopt = nxt
            elif a.startswith("-D") and len(a) > 2:
                dopt = a[2:]
            elif a.startswith("--pgdata="):
                dopt = a.split("=", 1)[1]
        for cand in (ddir, dopt):
            d = absolute(cand.strip("'\"")) if cand else None
            if not d:
                continue
            if self._is_pgdata(d):
                return d
            conf = parse_conf(_read(os.path.join(d, "postgresql.conf")) or "")
            if conf.get("data_directory") and self._is_pgdata(conf["data_directory"]):
                return os.path.normpath(conf["data_directory"])
            if os.path.isdir(d) and not os.access(d, os.R_OK | os.X_OK):
                return d                           # a directory the agent may not look into (not root, 0700): the command line is all there is
        return None

    def _discover_postgres(self, procs: List[Dict[str, Any]], listeners: List[Dict[str, Any]], extra: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        pgdatas = {}  # type: Dict[str, Dict[str, Any]]
        pids = {p["pid"] for p in procs if p["name"] == "postgres"}
        for p in procs:
            if p["name"] != "postgres":
                continue
            if p["ppid"] in pids:      # backend / worker, not the postmaster
                continue
            base = os.path.basename(p["argv"][0].split()[0])
            if base not in POSTMASTER_EXES:
                continue
            d = self._postmaster_pgdata(p)
            if d:
                pgdatas[os.path.realpath(d)] = {"pid": p["pid"], "running": True, "uid": p["uid"], "cmdline": p["cmdline"]}

        # well-known locations, Patroni's data_dir and the configured one: also report *stopped* clusters (and running ones the agent cannot see in /proc:
        # another PID namespace, hidepid)
        cands = []  # type: List[str]
        for pat in DATA_GLOBS:
            cands += sorted(glob.glob(pat))
        cands += [d for d in (extra or []) + self.extra_paths if d]
        for d in cands:
            if not self._is_pgdata(d):
                continue
            r = os.path.realpath(d)
            if r not in pgdatas:
                pgdatas[r] = {"pid": None, "running": self._pid_alive_from_file(r), "uid": None, "cmdline": None}

        out = []
        for d, ev in sorted(pgdatas.items()):
            out.append(self._inspect_pgdata(d, ev, listeners))
        return out

    @staticmethod
    def _pid_alive_from_file(pgdata: str) -> bool:
        """Is the postmaster that wrote postmaster.pid alive? A pid file survives a crash or a kill -9 and its pid is reused by any process after a reboot:
        the pid must be a PostgreSQL server working in THIS data directory. A pid outside our PID namespace (the server runs in a container, the agent on
        the host) is answered by its socket instead."""
        txt = _read(os.path.join(pgdata, "postmaster.pid"), 4096)
        if not txt:
            return False
        ls = txt.splitlines()
        try:
            pid = int(ls[0])
        except (ValueError, IndexError):
            return False
        cmd = None
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as f:
                cmd = [a for a in f.read().decode("utf-8", "replace").split("\x00") if a]
        except (OSError, IOError):
            cmd = None
        if cmd:
            exe = os.path.basename(cmd[0].split()[0]) if cmd[0].split() else ""
            if exe in POSTMASTER_EXES:
                try:
                    cwd = os.readlink("/proc/%d/cwd" % pid)
                except OSError:
                    return True                    # a postgres server we may not inspect further: take the pid file's word
                if os.path.realpath(cwd) == os.path.realpath(pgdata):
                    return True
        # not our postmaster (or not visible): does a server answer on the socket the pid file names?
        try:
            port = int(ls[3])
            sockdir = ls[4].strip() if len(ls) > 4 else ""
        except (ValueError, IndexError):
            return False
        if sockdir and os.path.isdir(sockdir):
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(1.0)
            try:
                s.connect(os.path.join(sockdir, ".s.PGSQL.%d" % port))
                return True
            except (OSError, socket.error):
                return False
            finally:
                s.close()
        return False

    def _inspect_pgdata(self, pgdata: str, ev: Dict[str, Any], listeners: List[Dict[str, Any]]) -> Dict[str, Any]:
        warn = []  # type: List[str]
        readable = os.access(pgdata, os.R_OK | os.X_OK)
        info = {
            "data_directory": pgdata,
            "readable_by_agent": readable,
            "running": ev["running"],
            "postmaster_pid": ev["pid"],
            "os_user_uid": ev["uid"],
        }  # type: Dict[str, Any]
        if not readable:
            warn.append("PGDATA is not readable by the agent user (run the agent as the postgres user or root)")

        ver = (_read(os.path.join(pgdata, "PG_VERSION"), 32) or "").strip()
        info["major_version"] = ver or None
        try:
            from pg_arca.pgcompat import Profile
            info["compat"] = Profile.from_text(ver).describe() if ver else None
        except Exception:
            info["compat"] = None
        info["system_identifier"] = read_system_identifier(pgdata)

        # postmaster.pid: line1 pid, 2 datadir, 3 start time, 4 port, 5 socket dir, 6 listen addr
        pidtxt = _read(os.path.join(pgdata, "postmaster.pid"), 4096)
        port = None
        sockdir = None
        if pidtxt:
            ls = pidtxt.splitlines()
            if len(ls) >= 5:
                port = int(ls[3]) if ls[3].strip().isdigit() else None
                sockdir = ls[4].strip() or None
            if len(ls) >= 6:
                info["listen_address"] = ls[5].strip()

        # configuration: main conf may live outside PGDATA (Debian) -> try cmdline -c config_file=, then PGDATA
        conf_candidates = [os.path.join(pgdata, "postgresql.conf")]
        if ev.get("cmdline"):
            m = re.search(r"config_file=(\S+)", ev["cmdline"])
            if m:
                conf_candidates.insert(0, m.group(1))
        for cand in glob.glob("/etc/postgresql/*/*/postgresql.conf"):
            txt = _read(cand) or ""
            dd = parse_conf(txt).get("data_directory", "")
            if dd and os.path.realpath(dd) == os.path.realpath(pgdata):          # pgdata is a real path now; the conf may name it through a symlink
                conf_candidates.insert(0, cand)
        conf = {}  # type: Dict[str, str]
        conf_file = None
        for c in conf_candidates:
            txt = _read(c)
            if txt is not None:
                conf = parse_conf(txt)
                conf_file = c
                break
        auto_txt = _read(os.path.join(pgdata, "postgresql.auto.conf")) or ""
        auto = parse_conf(auto_txt)
        # pg_arca's own instances: a recovery instance (scratch marker) or a restored copy (its configuration block). Never served by the agent
        # in place of production (regression review: a copy running while production was down for an hour took over the binding)
        info["pgarca_owned"] = os.path.exists(os.path.join(pgdata, ".pgarca-scratch")) or "# ==== pg_arca: restored instance" in auto_txt
        conf.update(auto)
        info["config_file"] = conf_file
        # the report goes to the console: no credential leaves the host (primary_conninfo password=, PGPASSWORD= in a command) - security review
        info["settings"] = {k: _scrub(conf[k]) for k in PG_INTERESTING_PARAMS if k in conf}

        if port is None and "port" in conf and conf["port"].isdigit():
            port = int(conf["port"])
        info["port"] = port
        if sockdir is None and "unix_socket_directories" in conf:
            dirs = [x.strip().strip("'\"") for x in conf["unix_socket_directories"].split(",") if x.strip()]
            sockdir = next((x for x in dirs if os.path.isdir(x)), dirs[0] if dirs else None)      # several are allowed: the first one that exists
        info["socket_directory"] = sockdir
        info["port_listening"] = any(l["port"] == port for l in listeners) if port else False

        # role hint without connecting
        has_standby = os.path.exists(os.path.join(pgdata, "standby.signal"))
        has_recovery = os.path.exists(os.path.join(pgdata, "recovery.signal"))
        info["role_hint"] = "standby" if has_standby else ("recovering" if has_recovery else "primary")
        info["role_hint_source"] = "signal files (confirm with pg_is_in_recovery())"

        # archive state
        arch_cmd = conf.get("archive_command", "")
        info["archiving"] = {
            "archive_mode": conf.get("archive_mode", "off"),
            "archive_command": arch_cmd,
            "wal_level": conf.get("wal_level"),
            "managed_by_pg_arca": "pg-arca" in arch_cmd or "pg_arca" in arch_cmd,
            "foreign_tool": ("pgbackrest" if "pgbackrest" in arch_cmd else
                             "wal-g" if "wal-g" in arch_cmd else
                             "barman" if "barman" in arch_cmd else None),
        }

        # tablespaces (real symlinks)
        tbs = []
        tsdir = os.path.join(pgdata, "pg_tblspc")
        try:
            for e in sorted(os.listdir(tsdir)):
                lp = os.path.join(tsdir, e)
                if os.path.islink(lp):
                    tbs.append({"oid": e, "location": os.path.realpath(lp), "exists": os.path.exists(lp)})
        except Exception:
            pass
        info["tablespaces"] = tbs

        # pg_controldata (authoritative: checksums, timeline, state, LSN)
        info["bin_dir"] = self._bin_dir(ev, ver)
        info["control"] = self._controldata(pgdata, ver, info["bin_dir"])
        if info["control"].get("data_checksums") is False and conf.get("wal_log_hints", "off") != "on":
            warn.append("data_checksums=off and wal_log_hints=off: page-level incrementals are NOT safe; only full backups allowed")

        # Postgres version from binary directory
        info["warnings"] = warn
        info["connect"] = {"host": self._connect_host(sockdir, info.get("listen_address") or conf.get("listen_addresses")), "port": port, "user": self.pg_user}
        return info

    @staticmethod
    def _connect_host(sockdir: Optional[str], listen: Optional[str]) -> str:
        """How the agent reaches this instance: its Unix socket when it has one the agent can see, else TCP on the address it listens on
        (unix_socket_directories = '' or a socket directory in another mount namespace: psql without -h looked for the default socket and never
        connected - independent review). A wildcard listen means the loopback of the same family."""
        if sockdir and os.path.isdir(sockdir):
            return sockdir
        first = (listen or "").split(",")[0].strip().strip("'\"")
        if first in ("", "*", "0.0.0.0"):
            return "127.0.0.1"
        if first in ("::", "[::]"):
            return "::1"
        return first

    @staticmethod
    def _bin_dir(ev: Dict[str, Any], major: str) -> Optional[str]:
        """Directory of the binaries that belong to this instance, whatever the installation layout: the RUNNING postmaster's own executable first (authoritative),
        then the absolute path it was started with, then a vendor directory whose version matches the data directory's major."""
        pid = ev.get("pid")
        if pid:
            try:
                exe = os.readlink("/proc/%d/exe" % int(pid))
                if exe.endswith(" (deleted)"):
                    exe = exe[: -len(" (deleted)")]
                if os.path.isfile(exe):
                    return os.path.dirname(exe)
            except (OSError, ValueError):
                pass
        cmd = (ev.get("cmdline") or "").split()
        if cmd and os.path.isabs(cmd[0]) and os.path.isfile(cmd[0]):
            return os.path.dirname(cmd[0])
        try:
            from pg_arca import pgaccess
            want = int(str(major).split(".")[0])
            hits = [d for pat in pgaccess.VENDOR_GLOBS for d in glob.glob(pat) if pgaccess._major_key(d) == want and os.path.isfile(os.path.join(d, "pg_ctl"))]
            return sorted(hits)[0] if hits else None
        except (ValueError, ImportError):
            return None

    def _controldata(self, pgdata: str, major: str, bin_dir: Optional[str] = None) -> Dict[str, Any]:
        bins = ([bin_dir] if bin_dir else []) + ["/usr/pgsql-%s/bin" % major, "/usr/lib/postgresql/%s/bin" % major, "/usr/edb/as%s/bin" % major,
                                                  "/usr/lib/edb-as/%s/bin" % major]
        exe = self._find_bin("pg_controldata", bins)
        if not exe:
            return {"available": False, "reason": "pg_controldata not found"}
        try:                                             # a pg_controldata of another major misreads pg_control (or refuses it): only the matching one
            from pg_arca.pgcompat import binary_profile
            prof = binary_profile(exe)
            if prof is not None and major and prof.label != str(major).strip():
                return {"available": False, "reason": "no pg_controldata of PostgreSQL %s (found %s, version %s)" % (major, exe, prof.label)}
        except Exception:
            pass
        ok, txt = _run([exe, "-D", pgdata], timeout=5, env=dict(os.environ, LC_ALL="C"))
        if not ok:
            return {"available": False, "reason": "pg_controldata failed (permissions?)"}
        kv = {}
        for line in txt.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                kv[k.strip()] = v.strip()
        cs = kv.get("Data page checksum version")
        return {
            "available": True,
            "system_identifier": kv.get("Database system identifier"),
            "cluster_state": kv.get("Database cluster state"),
            "timeline": int(kv["Latest checkpoint's TimeLineID"]) if kv.get("Latest checkpoint's TimeLineID", "").isdigit() else None,
            "checkpoint_lsn": kv.get("Latest checkpoint location"),
            "redo_lsn": kv.get("Latest checkpoint's REDO location"),
            "wal_level": kv.get("wal_level setting"),
            "data_checksums": (cs is not None and cs != "0"),
            "block_size": int(kv["Database block size"]) if kv.get("Database block size", "").isdigit() else None,
            "wal_segment_size": int(kv["Bytes per WAL segment"]) if kv.get("Bytes per WAL segment", "").isdigit() else None,
            "max_connections": int(kv["max_connections setting"]) if kv.get("max_connections setting", "").isdigit() else None,
        }

    # ---- Patroni -------------------------------------------------------
    def _discover_patroni(self, procs, listeners, instances=None) -> List[Dict[str, Any]]:
        yml_paths = []  # type: List[str]
        running = [p for p in procs if p["name"] == "patroni"]
        for p in running:
            for a in p["argv"][1:]:
                if re.search(r"\.ya?ml$", a) and os.path.exists(a):
                    yml_paths.append(a)
        for pat in EXTRA_CONFIG_GLOBS[:3]:
            for f in glob.glob(pat):
                txt = _read(f, 65536) or ""
                if re.search(r"^scope\s*:", txt, re.M) and re.search(r"^\s*postgresql\s*:", txt, re.M):
                    yml_paths.append(f)
        yml_paths = list(dict.fromkeys(yml_paths))
        if not yml_paths and running:
            yml_paths = [""]  # process seen but config unreadable: still report with live probe
        elif not yml_paths and any(l["port"] == 8008 for l in listeners):
            code, nd = _http_json("http://127.0.0.1:8008/patroni")   # only if it really answers like Patroni
            if isinstance(nd, dict) and "patroni" in nd:
                yml_paths = [""]

        out = []
        for path in yml_paths:
            cfg = parse_simple_yaml(_read(path) or "") if path else {}
            rest = cfg.get("restapi", {}) if isinstance(cfg.get("restapi"), dict) else {}
            pg = cfg.get("postgresql", {}) if isinstance(cfg.get("postgresql"), dict) else {}
            listen = str(rest.get("listen") or self._patroni_env(running, "PATRONI_RESTAPI_LISTEN") or self._patroni_listener(running, listeners) or "0.0.0.0:8008")
            rport = int(listen.rsplit(":", 1)[-1]) if listen.rsplit(":", 1)[-1].isdigit() else 8008
            scheme = "https" if (rest.get("certfile") or self._patroni_env(running, "PATRONI_RESTAPI_CERTFILE")) else "http"
            auth_hdr = {}  # type: Dict[str, str]
            ra = rest.get("authentication")
            if not (isinstance(ra, dict) and ra.get("username")) and self._patroni_env(running, "PATRONI_RESTAPI_USERNAME"):
                ra = {"username": self._patroni_env(running, "PATRONI_RESTAPI_USERNAME"), "password": self._patroni_env(running, "PATRONI_RESTAPI_PASSWORD") or ""}
            if isinstance(ra, dict) and ra.get("username"):
                import base64
                auth_hdr["Authorization"] = "Basic " + base64.b64encode(
                    ("%s:%s" % (ra.get("username"), ra.get("password", ""))).encode()).decode()
            tls = None
            if scheme == "https":
                ctl = cfg.get("ctl") if isinstance(cfg.get("ctl"), dict) else {}
                tls = _tls_context([str(x).strip() for x in (ctl.get("cacert"), rest.get("cafile"), self._patroni_env(running, "PATRONI_RESTAPI_CAFILE")) if x] + self.patroni_cafiles,
                                   str(ctl.get("certfile") or "").strip() or None, str(ctl.get("keyfile") or "").strip() or None)
                if self.tls_insecure:                       # the agent was told to skip verification (tls_insecure_skip_verify): the same for discovery
                    import ssl
                    tls.check_hostname = False
                    tls.verify_mode = ssl.CERT_NONE
            # where to reach it: over https the certificate names connect_address (what the other members use), rarely 127.0.0.1 - try it first then;
            # over http the listen address (a wildcard: loopback) first. The first one that answers like Patroni is the URL the agent keeps.
            hosts = [self._rest_host(listen)]
            ca_host = self._rest_host(str(rest.get("connect_address") or "")) if rest.get("connect_address") else None
            if ca_host and ca_host != hosts[0]:
                hosts = [ca_host] + hosts if scheme == "https" else hosts + [ca_host]
            cport = str(rest.get("connect_address") or "").rsplit(":", 1)[-1]
            bases = []
            for h in hosts:
                prt = int(cport) if (h == ca_host and cport.isdigit()) else rport
                bases.append("%s://%s:%d" % (scheme, h, prt))
            base, code, nd = bases[0], 0, None
            for b in bases:
                c2, n2 = _http_json(b + "/patroni", headers=auth_hdr, context=tls)
                if c2 in (200, 503) and isinstance(n2, dict):
                    base, code, nd = b, c2, n2
                    break
                if b == bases[0]:
                    code, nd = c2, n2

            dcs = None
            dcs_hosts = None
            for t in ("etcd3", "etcd", "consul", "zookeeper", "exhibitor", "kubernetes", "raft"):
                if t in cfg:
                    dcs = t
                    sect = cfg[t]
                    if isinstance(sect, dict):
                        dcs_hosts = sect.get("hosts") or sect.get("host") or sect.get("url") or sect.get("hosts_url")
                    break

            node = {}  # type: Dict[str, Any]
            members = []  # type: List[Dict[str, Any]]
            if isinstance(nd, dict):
                node = {"role": nd.get("role"), "state": nd.get("state"), "timeline": nd.get("timeline"),
                        "patroni_version": (nd.get("patroni") or {}).get("version"),
                        "server_version": nd.get("server_version"), "pending_restart": nd.get("pending_restart"),
                        "replication_state": nd.get("replication_state"),
                        "xlog": nd.get("xlog"), "tags": nd.get("tags")}
            ccode, cd = _http_json(base + "/cluster", headers=auth_hdr, context=tls)
            if isinstance(cd, dict):
                members = [{"name": m.get("name"), "role": m.get("role"), "state": m.get("state"),
                            "host": m.get("host"), "port": m.get("port"), "timeline": m.get("timeline"),
                            "lag": m.get("lag"), "api_url": m.get("api_url")} for m in cd.get("members", [])]
            leader = next((m["name"] for m in members if m["role"] in ("leader", "master", "primary")), None)
            dcfg = {}
            dcode, dd = _http_json(base + "/config", headers=auth_hdr, context=tls)
            if isinstance(dd, dict):
                dcfg = {"ttl": dd.get("ttl"), "loop_wait": dd.get("loop_wait"), "retry_timeout": dd.get("retry_timeout"),
                        "maximum_lag_on_failover": dd.get("maximum_lag_on_failover"),
                        "synchronous_mode": (dd.get("synchronous_mode") or False),
                        "use_pg_rewind": (dd.get("postgresql") or {}).get("use_pg_rewind"),
                        "parameters": (dd.get("postgresql") or {}).get("parameters", {}),
                        "recovery_conf": (dd.get("postgresql") or {}).get("recovery_conf") or {}}

            scope = cfg.get("scope") or (cd.get("scope") if isinstance(cd, dict) else None)
            out.append({
                "scope": scope,
                "namespace": cfg.get("namespace"),
                "node_name": cfg.get("name") or node.get("name"),
                "config_path": path or None,
                "restapi_port": rport,
                "restapi_url": base,
                "log_dir": (cfg.get("log") or {}).get("dir") if isinstance(cfg.get("log"), dict) else None,
                "restapi_authenticated": bool(auth_hdr),
                "rest_reachable": code in (200, 503) and isinstance(nd, dict),
                "dcs_type": dcs, "dcs_hosts": dcs_hosts,
                "data_dir": (str(pg.get("data_dir")).strip() or None) if pg.get("data_dir") else self._patroni_env(running, "PATRONI_POSTGRESQL_DATA_DIR"),
                "bin_dir": (str(pg.get("bin_dir")).strip() or None) if pg.get("bin_dir") else self._patroni_env(running, "PATRONI_POSTGRESQL_BIN_DIR"),
                "pg_connect_address": pg.get("connect_address"),
                "local_node": node, "members": members, "leader": leader,
                "dynamic_config": dcfg,
                "uses_pg_arca_replica_method": "pg_arca" in json.dumps(pg.get("create_replica_methods", "")),
            })
        return out

    @staticmethod
    def _rest_host(listen: str) -> str:
        """Address the agent should use to reach the LOCAL Patroni REST API given restapi.listen: a wildcard means loopback, a specific address (10.0.0.5:8008,
        [fe80::1]:8008) means exactly that address (the API is not reachable on 127.0.0.1 then)."""
        host = listen.rsplit(":", 1)[0].strip() if ":" in listen else ""
        host = host.strip("[]")
        if host in ("", "0.0.0.0", "::", "*", "0:0:0:0:0:0:0:0"):
            return "127.0.0.1"
        return "[%s]" % host if ":" in host else host

    @staticmethod
    def _patroni_env(running, var: str) -> Optional[str]:
        """Patroni can be configured entirely by environment (containers, Kubernetes): read it from the running process when we are allowed to."""
        for p in running:
            try:
                with open("/proc/%d/environ" % p["pid"], "rb") as f:
                    for kv in f.read().split(b"\0"):
                        if kv.startswith(var.encode() + b"="):
                            return kv.split(b"=", 1)[1].decode("utf-8", "replace")
            except OSError:
                continue
        return None

    @staticmethod
    def _patroni_listener(running, listeners) -> Optional[str]:
        """The port the Patroni process itself listens on, when its configuration cannot be read (a root-only patroni.yml): not an assumption of 8008."""
        pids = {p["pid"] for p in running}
        mine = sorted((l for l in listeners if l.get("pid") in pids), key=lambda l: (not l["loopback_only"], l["port"]))
        return ("127.0.0.1:%d" % mine[0]["port"]) if mine else None

    def _link_patroni_to_instances(self, instances, patroni):
        for inst in instances:
            for pc in patroni:
                dd = pc.get("data_dir")
                if dd and os.path.realpath(dd) == os.path.realpath(inst["data_directory"]):
                    inst["patroni"] = {"scope": pc["scope"], "node_name": pc["node_name"],
                                       "role": pc["local_node"].get("role"), "state": pc["local_node"].get("state"),
                                       "restapi_port": pc["restapi_port"]}
                    inst["cluster_key"] = "patroni:%s" % pc["scope"]
                    break
            else:
                if inst.get("system_identifier"):
                    inst["cluster_key"] = "sysid:%s" % inst["system_identifier"]

    # ---- etcd ----------------------------------------------------------
    def _discover_etcd(self, procs, listeners) -> List[Dict[str, Any]]:
        out = []
        for p in procs:
            if p["name"] != "etcd":
                continue
            args = " ".join(p["argv"])
            def opt(name):
                m = re.search(r"--%s[= ]([^\s]+)" % name, args)
                return m.group(1) if m else None
            out.append({"pid": p["pid"], "name": opt("name"), "data_dir": opt("data-dir"),
                        "client_urls": opt("listen-client-urls"), "advertise_client_urls": opt("advertise-client-urls"),
                        "initial_cluster": opt("initial-cluster"),
                        "client_port_listening": any(l["port"] == 2379 for l in listeners)})
        return out

    # ---- pgbouncer -----------------------------------------------------
    def _discover_pgbouncer(self, procs, listeners) -> List[Dict[str, Any]]:
        paths = []
        for p in procs:
            if p["name"] == "pgbouncer":
                paths += [a for a in p["argv"][1:] if a.endswith(".ini") and os.path.exists(a)]
        if os.path.exists("/etc/pgbouncer/pgbouncer.ini"):
            paths.append("/etc/pgbouncer/pgbouncer.ini")
        out = []
        for path in list(dict.fromkeys(paths)):
            txt = _read(path) or ""
            sect = None
            vals = {}   # type: Dict[str, str]
            dbs = {}    # type: Dict[str, str]
            for line in txt.splitlines():
                line = line.strip()
                if not line or line[0] in ";#":
                    continue
                if line.startswith("["):
                    sect = line.strip("[]").lower()
                    continue
                if "=" in line:
                    k, v = [x.strip() for x in line.split("=", 1)]
                    (vals if sect == "pgbouncer" else dbs if sect == "databases" else {})[k] = v
            out.append({"config_path": path, "listen_addr": vals.get("listen_addr"),
                        "listen_port": int(vals["listen_port"]) if vals.get("listen_port", "").isdigit() else 6432,
                        "pool_mode": vals.get("pool_mode"), "auth_type": vals.get("auth_type"),
                        "max_client_conn": vals.get("max_client_conn"), "databases": dbs,
                        "running": any(p["name"] == "pgbouncer" for p in procs)})
        return out

    # ---- pgBackRest (migration aid) ------------------------------------
    def _discover_pgbackrest(self) -> List[Dict[str, Any]]:
        out = []
        for path in ("/etc/pgbackrest/pgbackrest.conf", "/etc/pgbackrest.conf"):
            txt = _read(path)
            if txt is None:
                continue
            stanzas = []
            repo = None
            sect = None
            for line in txt.splitlines():
                line = line.strip()
                if line.startswith("[") and line.endswith("]"):
                    sect = line[1:-1]
                    if sect not in ("global", "global:archive-push", "global:archive-get"):
                        stanzas.append(sect)
                elif "=" in line and sect == "global" and line.startswith("repo1-path"):
                    repo = line.split("=", 1)[1].strip()
            out.append({"config_path": path, "repo1_path": repo, "stanzas": stanzas})
        return out

    # ---- warnings ------------------------------------------------------
    def _warnings(self, procs, instances) -> List[str]:
        w = []
        if os.geteuid() != 0 and any(p["uid"] not in (-1, os.geteuid()) for p in procs if p["name"] == "postgres"):
            w.append("Agent is not root and PostgreSQL runs as another user: some data may be hidden. "
                     "Run the agent as the postgres user (recommended) or root.")
        if not instances:
            w.append("No PostgreSQL data directory found on this host.")
        return w

    # ---- network scan (explicit, operator-triggered only) -------------
    def scan_network_cidr(self, target_cidr: str, ports: Optional[List[int]] = None, timeout_ms: int = 300) -> Dict[str, Any]:
        check_ports = ports or [5432, 8008, 2379, 6432, 9898]
        start = time.time()
        try:
            net = ipaddress.ip_network(target_cidr.strip(), strict=False)
        except ValueError as e:
            return {"error": "invalid target: %s" % e}
        if net.num_addresses > 1024:
            return {"error": "range too large (max /22, 1024 addresses)"}
        hosts = [str(h) for h in (net.hosts() if net.num_addresses > 2 else net)]
        names = {5432: "PostgreSQL", 8008: "Patroni REST API", 2379: "etcd client", 6432: "PgBouncer", 9898: "pg_arca agent"}

        def probe(hp):
            host, port = hp
            t = time.time()
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(timeout_ms / 1000.0)
            try:
                if s.connect_ex((host, port)) == 0:
                    return {"host": host, "port": port, "open": True, "service": names.get(port, "tcp/%d" % port),
                            "latency_ms": max(1, int((time.time() - t) * 1000))}
            except Exception:
                pass
            finally:
                s.close()
            return None

        with ThreadPoolExecutor(max_workers=64) as ex:
            found = [r for r in ex.map(probe, [(h, p) for h in hosts for p in check_ports]) if r]
        return {"target": target_cidr, "ips_scanned_count": len(hosts), "ports_checked": check_ports,
                "active_endpoints": found, "duration_ms": int((time.time() - start) * 1000)}


if __name__ == "__main__":
    print(json.dumps(ClusterDiscoveryEngine().scan_all(), indent=2))
