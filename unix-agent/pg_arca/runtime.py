"""Resolves what this agent manages (PostgreSQL instance, Patroni) from config + real discovery, and builds telemetry."""

import glob
import logging
import os
import re
import shutil
import time

from pg_arca.db_client import PostgresClient
from pg_arca.discovery import ClusterDiscoveryEngine
from pg_arca.patroni_bridge import PatroniBridge
from pg_arca.pgcompat import Profile, VersionError, check_tools

logger = logging.getLogger("pg_arca.runtime")
AGENT_VERSION = "2.0.0"


class Runtime(object):
    def __init__(self, config):
        self.config = config
        self.engine = ClusterDiscoveryEngine(pg_user=config.get("pg_user", "postgres"))
        self.report = {}
        self.instance = None
        self.patroni_info = None
        self.db = PostgresClient(user=config.get("pg_user", "postgres"), port=config.get("pg_port") or 5432, host=config.get("pg_host", ""))
        self.patroni = PatroniBridge("")
        self.refresh()

    def refresh(self):
        """Re-run discovery and re-bind clients. Cheap enough to run every few minutes."""
        c = self.config
        rep = self.engine.scan_all()
        self.report = rep
        insts = rep.get("postgres_instances", [])
        pick = None
        if c.get("pg_data"):
            pick = next((i for i in insts if os.path.realpath(i["data_directory"]) == os.path.realpath(c["pg_data"])), None)
        if pick is None and c.get("pg_port"):
            pick = next((i for i in insts if int(i.get("port") or 0) == int(c["pg_port"])), None)
        if pick is None:
            pick = next((i for i in insts if i.get("running") and i.get("port_listening")), None) or next((i for i in insts if i.get("running")), None) or (insts[0] if insts else None)
        self.instance = pick
        if pick:
            sock = pick.get("socket_directory")
            self.db = PostgresClient(user=c.get("pg_user", "postgres"), port=c.get("pg_port") or pick.get("port") or 5432,
                                     host=c.get("pg_host") or "", socket_dir=None if c.get("pg_host") else (sock if sock and os.path.isdir(sock) else None))
        # Patroni: configured URL wins, else discovered local REST port
        url = c.get("patroni_url")
        pinfo = None
        for pc in rep.get("patroni_clusters", []):
            if pick and pc.get("data_dir") and os.path.realpath(pc["data_dir"]) == os.path.realpath(pick["data_directory"]):
                pinfo = pc
                break
        pinfo = pinfo or (rep.get("patroni_clusters") or [None])[0]
        self.patroni_info = pinfo
        if not url and pinfo:
            url = "http://127.0.0.1:%d" % pinfo["restapi_port"]
        user, pw = c.get("patroni_user", ""), c.get("patroni_password", "")
        self.patroni = PatroniBridge(url or "", user, pw, c.get("tls_ca_file", ""), c.get("tls_insecure_skip_verify", False))
        return rep

    # ------------------------------------------------------------------ telemetry
    def system_metrics(self, paths):
        out = {"cpu_count": os.cpu_count() or 1}
        try:
            out["load_avg_1m"] = os.getloadavg()[0]
        except OSError:
            out["load_avg_1m"] = 0.0
        try:
            mem = {}
            with open("/proc/meminfo") as f:
                for line in f:
                    k, v = line.split(":", 1)
                    mem[k] = int(v.split()[0]) * 1024
            out["memory_total_bytes"] = mem.get("MemTotal", 0)
            out["memory_used_percent"] = round((1 - mem.get("MemAvailable", 0) / float(mem["MemTotal"])) * 100, 1) if mem.get("MemTotal") else 0
        except Exception:
            out["memory_used_percent"] = 0
        disks = {}
        for label, p in paths.items():
            if p and os.path.exists(p):
                try:
                    st = os.statvfs(p)
                    disks[label] = {"path": p, "total_bytes": st.f_blocks * st.f_frsize, "free_bytes": st.f_bavail * st.f_frsize}
                except OSError:
                    pass
        out["disks"] = disks
        out["timestamp"] = time.time()
        return out

    def patroni_view(self):
        if not self.patroni.configured:
            return {"configured": False, "accessible": False}
        st, node = self.patroni.get_node_status()
        accessible = st in (200, 503) and isinstance(node, dict) and "state" in node
        view = {"configured": True, "accessible": accessible}
        pi = self.patroni_info or {}
        view.update({"scope": pi.get("scope"), "dcs_type": pi.get("dcs_type"), "dcs_hosts": pi.get("dcs_hosts")})
        if accessible:
            view["local_node"] = {"role": node.get("role"), "state": node.get("state"), "timeline": node.get("timeline"),
                                  "pending_restart": node.get("pending_restart"), "tags": node.get("tags"), "xlog": node.get("xlog")}
            s2, cl = self.patroni.get_cluster_topology()
            if s2 == 200 and isinstance(cl, dict):
                view["members"] = [{k: m.get(k) for k in ("name", "role", "state", "host", "port", "timeline", "lag", "api_url")} for m in cl.get("members", [])]
                view["paused"] = bool(cl.get("pause", False))
                view["scope"] = cl.get("scope") or view.get("scope")
        return view

    def compat(self, pg, inst):
        """Version profile of this instance for the console: what is supported, what is end-of-life, and whether the binaries in use match the server."""
        try:
            prof = Profile.from_text(pg.get("version")) if pg.get("alive") and pg.get("version") else Profile.from_text(inst.get("major_version") or inst.get("version") or "")
        except VersionError:
            return None
        d = prof.describe()
        bindir = self.config.get("pg_bin_dir") or inst.get("bin_dir") or ""
        d["tool_problems"] = [{"severity": sv, "code": c, "text": t} for sv, c, t in check_tools(prof, bindir)] if bindir else []
        return d

    def build_snapshot(self, wal, cas):
        inst = self.instance or {}
        pg = self.db.get_snapshot() if inst else {"alive": False, "error": "no PostgreSQL instance found on this host"}
        pg["data_directory"] = inst.get("data_directory")
        pg["tablespaces"] = inst.get("tablespaces", [])
        pg["checksums"] = (inst.get("control") or {}).get("data_checksums")
        pg["archiving"] = inst.get("archiving")
        pg["compat"] = self.compat(pg, inst)
        return {
            "node_name": self.config["node_name"], "agent_version": AGENT_VERSION,
            "postgres": pg, "patroni": self.patroni_view(),
            "wal": wal.verify_continuity() if wal else None,
            "backup": cas.get_stats() if cas else None,
            "system": self.system_metrics({"pgdata": inst.get("data_directory"), "repo": self.config.get("repo_path"), "wal_archive": self.config.get("wal_archive_dir")}),
            "toolchain": self.report.get("toolchain"),
            "storage": {"repo_id": storage_id(self.config.get("repo_path")), "wal_id": storage_id(self.config.get("wal_archive_dir"))},
            "cluster_key": inst.get("cluster_key") or (("patroni:%s" % self.patroni_info["scope"]) if (self.patroni_info or {}).get("scope") else None),
        }


def storage_id(path):
    """Identity of a storage area, proven rather than guessed: a random id stored IN the directory. Nodes that report the same id see the SAME files (NFS, CephFS,
    a shared volume, a bind mount...); different ids mean each node has its own copy, so after a switchover/failover the WAL archive and the backups would be
    split between nodes and point-in-time recovery would silently break. None when the directory does not exist yet or cannot be written."""
    if not path or not os.path.isdir(path):
        return None
    f = os.path.join(path, ".pgarca-id")
    try:
        with open(f) as h:
            v = h.read().strip()
            if v:
                return v[:64]
    except (IOError, OSError):
        pass
    try:
        import uuid
        v = uuid.uuid4().hex
        fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)      # O_EXCL: two nodes racing on a shared directory end up with ONE id
        with os.fdopen(fd, "w") as h:
            h.write(v + "\n")
        return v
    except FileExistsError:
        try:
            with open(f) as h:
                return h.read().strip()[:64] or None
        except (IOError, OSError):
            return None
    except (IOError, OSError):
        return None


LEVEL_RE = re.compile(r"\b(DEBUG\d?|INFO|NOTICE|LOG|WARNING|WARN|ERROR|FATAL|PANIC|CRITICAL)\b")


class LogShipper(object):
    """Tails real log files and ships new lines (never replays history on start). Offsets tracked per inode."""

    def __init__(self, config, runtime):
        self.config = config
        self.rt = runtime
        self.pos = {}

    def _files(self):
        files = list(self.config.get("log_files") or [])
        if not files:
            inst = self.rt.instance or {}
            pgdata = inst.get("data_directory")
            st = inst.get("settings") or {}
            cands = []
            dirs = []
            ld = st.get("log_directory")
            if ld and pgdata:
                dirs.append(ld if os.path.isabs(ld) else os.path.join(pgdata, ld))      # the instance's own setting wins (relative paths are inside PGDATA)
            if pgdata:
                dirs.append(os.path.join(pgdata, "log"))
            dirs += ["/var/log/postgresql", "/var/log/pgsql"]
            for d in dict.fromkeys(dirs):
                found = [f for f in glob.glob(os.path.join(d, "*.log")) if os.path.isfile(f)]
                if found:
                    cands.append(max(found, key=os.path.getmtime))
                    break
            pat = self.rt.patroni_info or {}
            pdirs = ["/var/log/patroni"]
            for d in pdirs:
                found = [f for f in glob.glob(os.path.join(d, "*.log*")) if os.path.isfile(f) and not f.endswith((".gz", ".zst"))]
                if found:
                    cands.append(max(found, key=os.path.getmtime))
            cands += [p for p in ("/var/log/pgarca/agent.log", "/var/log/pgarca/agent.out") if os.path.exists(p)]
            files = cands
        return files

    @staticmethod
    def _service(path):
        return "patroni" if "patroni" in path else ("agent" if "pgarca" in path or "pg-arca" in path else "postgres")

    def collect(self, limit=200):
        out = []
        for path in self._files():
            try:
                st = os.stat(path)
            except OSError:
                continue
            key = (path, st.st_ino)
            if key not in self.pos:
                # first sight: show the recent tail (so the Logs page is useful immediately), then follow
                self.pos[key] = max(0, st.st_size - 16 * 1024)
                if self.pos[key]:
                    try:
                        with open(path, "rb") as f:
                            f.seek(self.pos[key]); f.readline(); self.pos[key] = f.tell()      # start on a line boundary
                    except OSError:
                        pass
            if st.st_size < self.pos[key]:
                self.pos[key] = 0                     # truncated / rotated in place
            if st.st_size == self.pos[key]:
                continue
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    f.seek(self.pos[key])
                    chunk = f.read(256 * 1024)
                    self.pos[key] = f.tell()
            except OSError:
                continue
            for line in chunk.splitlines():
                if not line.strip():
                    continue
                m = LEVEL_RE.search(line)
                lv = (m.group(1) if m else "INFO").upper()
                lv = {"WARNING": "WARN", "LOG": "INFO", "NOTICE": "INFO", "PANIC": "FATAL", "CRITICAL": "FATAL"}.get(lv, lv)
                lv = "DEBUG" if lv.startswith("DEBUG") else lv
                out.append({"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "service": self._service(path),
                            "level": lv, "message": line[:1000], "raw": line[:2000]})
                if len(out) >= limit:
                    return out
        return out
