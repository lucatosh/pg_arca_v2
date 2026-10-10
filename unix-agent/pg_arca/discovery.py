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
    "hba_file", "ident_file", "cluster_name", "ssl", "log_directory", "logging_collector",
)

EXTRA_CONFIG_GLOBS = [
    "/etc/patroni*.y*ml", "/etc/patroni/*.y*ml", "/opt/patroni/*.y*ml",
    "/etc/postgresql*/**/postgresql.conf", "/var/lib/pgsql/**/postgresql.conf",
    "/etc/pgbouncer/pgbouncer.ini", "/etc/pgbackrest/pgbackrest.conf",
    "/etc/pgbackrest.conf", "/etc/etcd/etcd.conf*", "/etc/default/etcd",
]

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
                           universal_newlines=True, timeout=timeout, env=env)
        return p.returncode == 0, (p.stdout or "").strip()
    except Exception:
        return False, ""


def _http_json(url: str, timeout: float = 1.5, headers: Optional[Dict[str, str]] = None) -> Tuple[int, Any]:
    req = urllib.request.Request(url, headers=dict({"User-Agent": "pg_arca-agent"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:  # Patroni answers 503 for non-leader health endpoints, body is still JSON
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return e.code, None
    except Exception:
        return 0, None


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


def parse_simple_yaml(text: str) -> Dict[str, Any]:
    """
    Minimal YAML reader sufficient for patroni.yml (maps, nested maps, scalars,
    '- item' lists, inline [a, b] lists). Falls back to PyYAML when installed.
    """
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(text)
        return data if isinstance(data, dict) else {}
    except Exception:
        pass

    def scalar(v: str) -> Any:
        v = v.strip()
        if " #" in v:
            v = v.split(" #", 1)[0].strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            return v[1:-1]
        if v.startswith("[") and v.endswith("]"):
            return [scalar(x) for x in v[1:-1].split(",") if x.strip()]
        low = v.lower()
        if low in ("true", "yes"):
            return True
        if low in ("false", "no"):
            return False
        if re.match(r"^-?\d+$", v):
            return int(v)
        return v

    root = {}  # type: Dict[str, Any]
    stack = [(-1, root)]  # (indent, container)
    last_key = {}  # id(container) -> key awaiting value
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        container = stack[-1][1]
        if line.startswith("- "):
            key = last_key.get(id(container))
            if key is not None:
                if not isinstance(container.get(key), list):
                    container[key] = []
                container[key].append(scalar(line[2:]))
            continue
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k = k.strip().strip("'\"")
        v = v.strip()
        if v == "" or v.startswith("#"):
            child = {}  # type: Dict[str, Any]
            container[k] = child
            last_key[id(container)] = k
            stack.append((indent, child))
        else:
            container[k] = scalar(v)
            last_key[id(container)] = k
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
        add("critical", "NO_PSQL", "psql non trovato", "L'agent usa psql per interrogare PostgreSQL ed eseguire backup e ripristini.", "Installa il pacchetto client di PostgreSQL.", "host")
    if not tc.get("pg_waldump"):
        add("info", "NO_WALDUMP", "pg_waldump non trovato", "Senza pg_waldump non si possono cercare DROP/TRUNCATE nei WAL.", "Installa i binari del server PostgreSQL (postgresql-NN).", "host")
    if not tc.get("python_zstandard") and not tc.get("zstd"):
        add("info", "NO_ZSTD", "Compressione zstd non disponibile", "I blocchi verranno compressi con zlib (più grandi e più lenti).", "pip install zstandard (o installa il comando zstd).", "host")
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
            add("critical", "UNREADABLE", "Data directory non leggibile dall'agent", "Senza accesso ai file l'agent non può fare backup.", "Esegui l'agent come utente postgres (o root).", tgt)
        if 0 < major < 14:
            add("critical", "PG_EOL", "PostgreSQL %d è fuori supporto" % major, "Non riceve più correzioni di sicurezza.", "Pianifica l'aggiornamento a una versione supportata (16 o superiore).", tgt)
        if not i.get("running"):
            add("warning", "NOT_RUNNING", "Istanza non in esecuzione", "I backup richiedono PostgreSQL attivo (i ripristini su cartella no).", "Avvia PostgreSQL.", tgt)
        mode = (ar.get("archive_mode") or "off").lower()
        if mode == "off":
            add("warning", "ARCHIVE_OFF", "Archiviazione WAL spenta", "Senza WAL archiviati non esiste il ripristino a un istante preciso.", "archive_mode = on; archive_command = '/usr/local/bin/pg-arca-wal archive %p %f' (richiede un riavvio).", tgt)
        elif ar.get("foreign_tool"):
            add("warning", "ARCHIVE_FOREIGN", "L'archiviazione è gestita da %s" % ar["foreign_tool"], "Sostituire archive_command interrompe quella catena di backup.", "Valuta una migrazione guidata: non cambiare archive_command a caldo.", tgt)
        if (ctl.get("wal_level") or ar.get("wal_level")) == "minimal":
            add("critical", "WAL_MINIMAL", "wal_level = minimal", "Con wal_level minimal non si può archiviare né replicare.", "wal_level = replica (richiede un riavvio).", tgt)
        if ctl.get("available") and not ctl.get("data_checksums") and (st.get("wal_log_hints") or "off") != "on":
            add("info", "NO_CHECKSUMS", "Backup incrementali non abilitabili", "Servono data_checksums o wal_log_hints per distinguere le pagine cambiate; ora sono possibili solo backup completi.", "wal_log_hints = on (riavvio) oppure pg_checksums --enable a istanza ferma.", tgt)
        if st.get("ssl") and st["ssl"] != "on":
            add("warning", "SSL_OFF", "TLS spento", "Le connessioni non sono cifrate e le regole hostssl non possono corrispondere.", "ssl = on con certificato e chiave configurati.", tgt)
        if (st.get("fsync") or "on") == "off" or (st.get("full_page_writes") or "on") == "off":
            add("critical", "UNSAFE_DURABILITY", "fsync / full_page_writes disattivati", "Un crash può corrompere i dati e i backup fisici non sono consistenti.", "Riattiva fsync e full_page_writes.", tgt)
    for pc in scan.get("patroni_clusters") or []:
        if not pc.get("rest_accessible", True) and pc.get("rest_url"):
            add("warning", "PATRONI_REST", "API REST di Patroni non raggiungibile", "Switchover, failover e modifiche HA non sono possibili da qui.", "Controlla restapi.listen / credenziali.", pc.get("scope", ""))
    for ec in scan.get("etcd_clusters") or []:
        n = len(ec.get("members") or [])
        if n and n % 2 == 0:
            add("warning", "ETCD_EVEN", "etcd con %d membri" % n, "Un numero pari di membri non aumenta la tolleranza ai guasti.", "Usa 3 o 5 membri.", ec.get("name", ""))
        if n == 1:
            add("warning", "ETCD_SINGLE", "etcd con un solo membro", "Se si ferma, Patroni degrada il cluster.", "Usa 3 membri.", ec.get("name", ""))
    order = {"critical": 0, "warning": 1, "info": 2}
    out.sort(key=lambda f: order[f["severity"]])
    return out


class ClusterDiscoveryEngine:
    def __init__(self, search_paths: Optional[List[str]] = None, custom_variables: Optional[Dict[str, str]] = None,
                 pg_user: str = "postgres"):
        self.extra_paths = list(search_paths or [])
        self.variables = dict(custom_variables or {})
        self.pg_user = pg_user

    # ---- public --------------------------------------------------------
    def scan_all(self) -> Dict[str, Any]:
        t0 = time.time()
        procs = self._scan_processes()
        listeners = self._scan_listeners(procs)
        systemd = self._scan_systemd()

        instances = self._discover_postgres(procs, listeners)
        patroni = self._discover_patroni(procs, listeners, instances)
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
        for pat in ("/usr/pgsql-*/bin", "/usr/lib/postgresql/*/bin", "/opt/pgsql*/bin", "/usr/local/pgsql*/bin"):
            for d in sorted(glob.glob(pat), reverse=True):
                for n in names:
                    if not found.get(n) and os.path.exists(os.path.join(d, n)):
                        found[n] = os.path.join(d, n)
        try:
            import zstandard  # noqa: F401
            found["python_zstandard"] = "installed"
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
    def _scan_processes(self) -> List[Dict[str, Any]]:
        out = []
        interesting = ("postgres", "postmaster", "patroni", "etcd", "pgbouncer", "haproxy", "pgbackrest", "pg_arca", "pg-arca")
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
            exe_name = os.path.basename(argv[0].split()[0]) if argv[0] else ""
            joined = " ".join(argv)
            name = None
            for t in interesting:
                script = os.path.basename(argv[1]) if (exe_name.startswith("python") and len(argv) > 1) else ""
                if exe_name == t or exe_name.startswith(t) or script.startswith(t) or script.startswith(t.replace("_", "-")):
                    name = "postgres" if t == "postmaster" else t
                    break
            if name is None:
                continue
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
    def _postmaster_pgdata(self, p: Dict[str, Any]) -> Optional[str]:
        argv = p["argv"]
        for i, a in enumerate(argv):
            if a == "-D" and i + 1 < len(argv):
                return os.path.abspath(argv[i + 1])
            if a.startswith("-D") and len(a) > 2:
                return os.path.abspath(a[2:])
            if a.startswith("--pgdata="):
                return os.path.abspath(a.split("=", 1)[1])
        if p["cwd"] and os.path.exists(os.path.join(p["cwd"], "PG_VERSION")):
            return p["cwd"]  # postmaster chdir()s into PGDATA
        return None

    def _discover_postgres(self, procs: List[Dict[str, Any]], listeners: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        pgdatas = {}  # type: Dict[str, Dict[str, Any]]
        pids = {p["pid"] for p in procs if p["name"] == "postgres"}
        for p in procs:
            if p["name"] != "postgres":
                continue
            if p["ppid"] in pids:      # backend / worker, not the postmaster
                continue
            base = os.path.basename(p["argv"][0].split()[0])
            if base not in ("postgres", "postmaster", "postgres:"):
                continue
            d = self._postmaster_pgdata(p)
            if d:
                pgdatas[d] = {"pid": p["pid"], "running": True, "uid": p["uid"], "cmdline": p["cmdline"]}

        # Patroni `data_dir` and well-known locations: also report *stopped* clusters
        for pat in ("/var/lib/pgsql/*/data", "/var/lib/pgsql/data", "/var/lib/postgresql/*/*", "/var/lib/postgresql/data"):
            for d in glob.glob(pat):
                if os.path.exists(os.path.join(d, "PG_VERSION")) and d not in pgdatas:
                    pgdatas[d] = {"pid": None, "running": self._pid_alive_from_file(d), "uid": None, "cmdline": None}
        for d in self.extra_paths:
            if os.path.exists(os.path.join(d, "PG_VERSION")):
                pgdatas.setdefault(d, {"pid": None, "running": self._pid_alive_from_file(d), "uid": None, "cmdline": None})

        out = []
        for d, ev in sorted(pgdatas.items()):
            out.append(self._inspect_pgdata(d, ev, listeners))
        return out

    @staticmethod
    def _pid_alive_from_file(pgdata: str) -> bool:
        txt = _read(os.path.join(pgdata, "postmaster.pid"), 2048)
        if not txt:
            return False
        try:
            return os.path.exists("/proc/%d" % int(txt.splitlines()[0]))
        except Exception:
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
            if parse_conf(txt).get("data_directory", "").rstrip("/") == pgdata.rstrip("/"):
                conf_candidates.insert(0, cand)
        conf = {}  # type: Dict[str, str]
        conf_file = None
        for c in conf_candidates:
            txt = _read(c)
            if txt is not None:
                conf = parse_conf(txt)
                conf_file = c
                break
        auto = parse_conf(_read(os.path.join(pgdata, "postgresql.auto.conf")) or "")
        conf.update(auto)
        info["config_file"] = conf_file
        info["settings"] = {k: conf[k] for k in PG_INTERESTING_PARAMS if k in conf}

        if port is None and "port" in conf and conf["port"].isdigit():
            port = int(conf["port"])
        info["port"] = port
        if sockdir is None and "unix_socket_directories" in conf:
            sockdir = conf["unix_socket_directories"].split(",")[0].strip() or None
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
        info["control"] = self._controldata(pgdata, ver)
        if info["control"].get("data_checksums") is False and conf.get("wal_log_hints", "off") != "on":
            warn.append("data_checksums=off and wal_log_hints=off: page-level incrementals are NOT safe; only full backups allowed")

        # Postgres version from binary directory
        info["warnings"] = warn
        info["connect"] = {"host": sockdir or "127.0.0.1", "port": port, "user": self.pg_user}
        return info

    def _controldata(self, pgdata: str, major: str) -> Dict[str, Any]:
        bins = ["/usr/pgsql-%s/bin" % major, "/usr/lib/postgresql/%s/bin" % major]
        exe = self._find_bin("pg_controldata", bins)
        if not exe:
            return {"available": False, "reason": "pg_controldata not found"}
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
    def _discover_patroni(self, procs, listeners, instances) -> List[Dict[str, Any]]:
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
            listen = str(rest.get("listen", "0.0.0.0:8008"))
            rport = int(listen.rsplit(":", 1)[-1]) if listen.rsplit(":", 1)[-1].isdigit() else 8008
            connect = str(rest.get("connect_address", "")) or "127.0.0.1:%d" % rport
            scheme = "https" if rest.get("certfile") else "http"
            base = "%s://127.0.0.1:%d" % (scheme, rport)
            auth_hdr = {}  # type: Dict[str, str]
            ra = rest.get("authentication")
            if isinstance(ra, dict) and ra.get("username"):
                import base64
                auth_hdr["Authorization"] = "Basic " + base64.b64encode(
                    ("%s:%s" % (ra.get("username"), ra.get("password", ""))).encode()).decode()

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
            code, nd = _http_json(base + "/patroni", headers=auth_hdr)
            if isinstance(nd, dict):
                node = {"role": nd.get("role"), "state": nd.get("state"), "timeline": nd.get("timeline"),
                        "patroni_version": (nd.get("patroni") or {}).get("version"),
                        "server_version": nd.get("server_version"), "pending_restart": nd.get("pending_restart"),
                        "replication_state": nd.get("replication_state"),
                        "xlog": nd.get("xlog"), "tags": nd.get("tags")}
            ccode, cd = _http_json(base + "/cluster", headers=auth_hdr)
            if isinstance(cd, dict):
                members = [{"name": m.get("name"), "role": m.get("role"), "state": m.get("state"),
                            "host": m.get("host"), "port": m.get("port"), "timeline": m.get("timeline"),
                            "lag": m.get("lag"), "api_url": m.get("api_url")} for m in cd.get("members", [])]
            leader = next((m["name"] for m in members if m["role"] in ("leader", "master", "primary")), None)
            dcfg = {}
            dcode, dd = _http_json(base + "/config", headers=auth_hdr)
            if isinstance(dd, dict):
                dcfg = {"ttl": dd.get("ttl"), "loop_wait": dd.get("loop_wait"), "retry_timeout": dd.get("retry_timeout"),
                        "maximum_lag_on_failover": dd.get("maximum_lag_on_failover"),
                        "synchronous_mode": (dd.get("synchronous_mode") or False),
                        "use_pg_rewind": (dd.get("postgresql") or {}).get("use_pg_rewind"),
                        "parameters": (dd.get("postgresql") or {}).get("parameters", {})}

            scope = cfg.get("scope") or (cd.get("scope") if isinstance(cd, dict) else None)
            out.append({
                "scope": scope,
                "namespace": cfg.get("namespace"),
                "node_name": cfg.get("name") or node.get("name"),
                "config_path": path or None,
                "restapi_port": rport,
                "restapi_authenticated": bool(auth_hdr),
                "rest_reachable": code in (200, 503) and isinstance(nd, dict),
                "dcs_type": dcs, "dcs_hosts": dcs_hosts,
                "data_dir": pg.get("data_dir"),
                "bin_dir": pg.get("bin_dir"),
                "pg_connect_address": pg.get("connect_address"),
                "local_node": node, "members": members, "leader": leader,
                "dynamic_config": dcfg,
                "uses_pg_arca_replica_method": "pg_arca" in json.dumps(pg.get("create_replica_methods", "")),
            })
        return out

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
