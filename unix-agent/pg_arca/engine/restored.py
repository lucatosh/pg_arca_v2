"""Restored instances: a whole-instance restore is finished only when the copy RUNS and the operator knows how to reach it.

The product picks where the copy goes (a suggestion per volume, with filesystem, free space and what else lives there), restores it, starts it on a free
port with the binaries of its major version, waits until it reached the target (promoted, or paused for inspection), and keeps it in a registry:
  * state_dir/restored-instances.json - one entry per copy: directory, port, socket, binaries, target, expiry, wanted state (running / stopped);
  * every copy is temporary by default: it expires (24 h unless the operator keeps it) and is then stopped and deleted by the agent itself;
  * the agent restarts a copy that should run but does not (agent restart: its processes live in the agent's service; host reboot);
  * stop / start / resume (end the pause) / keep / delete are operations of the console (restored_*), never a command the operator must type.
The copy starts with the same safety as restore_instance writes (no archiving into production's archive, no replication, no subscriptions, no
pg_cron...), plus: its own port and a private 0700 socket directory, its own log inside the copy, no pid file or statistics directory shared with
production (Debian's external_pid_file / stats_temp_directory), and a memory cap so it never competes with production for RAM."""
import fcntl
import json
import os
import pwd
import re
import shutil
import socket
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from pg_arca.engine import ephcfg
from pg_arca.engine.backup import _check_cancel, build_chain
from pg_arca.engine.destcheck import mount_of, mounts
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.safety import assert_writable_target
from pg_arca.engine.util import EngineError, human, iso, read_file, tail_file, write_file_atomic

REGISTRY = "restored-instances.json"
MARK = ".pgarca-restored"
LOG = "pgarca-restored.log"
DEFAULT_TTL_H = 24
_lock = threading.Lock()
# filesystems a restored copy must never be suggested on: memory, pseudo, read-only images
_SKIP_FS = {"tmpfs", "ramfs", "devtmpfs", "proc", "sysfs", "cgroup", "cgroup2", "devpts", "mqueue", "debugfs", "tracefs", "securityfs", "pstore",
            "bpf", "configfs", "fusectl", "hugetlbfs", "autofs", "squashfs", "iso9660", "nsfs", "binfmt_misc", "efivarfs", "rpc_pipefs", "fuse.lxcfs",
            "selinuxfs"}
_NET_FS = {"nfs", "nfs4", "cifs", "smb3", "fuse.sshfs", "glusterfs", "ceph", "fuse.s3fs", "9p"}


# ============================================================================================================== registry

def _parse_iso(s):
    """datetime.isoformat() output back to an aware datetime, on Python 3.6 too (no fromisoformat there, and %z wants +0000, not +00:00)."""
    import re as _re
    t = _re.sub(r"([+-]\d\d):(\d\d)$", r"\1\2", str(s).strip().replace("Z", "+00:00"))
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.strptime(t, fmt)
        except ValueError:
            pass
    raise ValueError("not an ISO timestamp: %r" % s)

def _reg_path(state_dir):
    return os.path.join(state_dir, REGISTRY)


def load(state_dir):
    try:
        data = json.loads(read_file(_reg_path(state_dir)))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save(state_dir, items):
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    write_file_atomic(_reg_path(state_dir), json.dumps(items, indent=1, sort_keys=True).encode(), mode=0o600)


class _Locked(object):
    """Registry read-modify-write: one thread at a time (operations and the housekeeping run in different threads) and one process (flock)."""

    def __init__(self, state_dir):
        self.state_dir = state_dir

    def __enter__(self):
        _lock.acquire()
        os.makedirs(self.state_dir, mode=0o700, exist_ok=True)
        self.fh = open(os.path.join(self.state_dir, REGISTRY + ".lock"), "a")
        fcntl.flock(self.fh, fcntl.LOCK_EX)
        self.items = load(self.state_dir)
        return self

    def save(self):
        _save(self.state_dir, self.items)

    def __exit__(self, *a):
        try:
            fcntl.flock(self.fh, fcntl.LOCK_UN)
            self.fh.close()
        finally:
            _lock.release()


def _find(items, rid):
    for it in items:
        if it.get("id") == rid:
            return it
    raise EngineError("PGA-RST-060", "restored instance %s is not in this agent's registry" % rid, "refresh the page: it may have expired or been deleted")


# ============================================================================================================== where: destination suggestions
def _statvfs(path):
    try:
        st = os.statvfs(path)
        return st.f_bavail * st.f_frsize, st.f_blocks * st.f_frsize
    except OSError:
        return None, None


def _dev(path):
    p = path
    while p and not os.path.exists(p):
        p = os.path.dirname(p)
    try:
        return os.stat(p or "/").st_dev
    except OSError:
        return None


def _writable_dir(path):
    """The agent can create a directory here (the directory exists and is writable+searchable by the agent's OS user, or it can be created)."""
    p = path
    while p and not os.path.exists(p):
        p = os.path.dirname(p)
    return bool(p) and os.path.isdir(p) and os.access(p, os.W_OK | os.X_OK)


# configuration, programs, logs and runtime state: a writable mount there (a container's /etc/postgresql volume, /var/log) is never a place for data
_SYSTEM = ("/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/proc", "/sys", "/dev", "/run", "/snap", "/boot", "/var/log", "/var/run", "/var/cache",
           "/var/spool", "/var/mail", "/var/lib/docker", "/var/lib/containers", "/var/lib/kubelet", "/var/lib/pgarca", "/var/lib/apt", "/var/lib/dpkg", "/var/lib/rpm")


def _system_path(p):
    p = os.path.realpath(p)
    return any(p == x or p.startswith(x + "/") for x in _SYSTEM)


def default_name(label):
    """pgarca-restore-<cluster name as the operator knows it>-<date-time>; an internal stanza (sysid-...) says nothing to a person: left out."""
    lab = re.sub(r"[^A-Za-z0-9_.-]+", "-", label or "").strip("-.")[:40]
    if not lab or lab.startswith("sysid-"):
        return "pgarca-restore-%s" % datetime.now().strftime("%Y%m%d-%H%M")
    return "pgarca-restore-%s-%s" % (lab, datetime.now().strftime("%Y%m%d-%H%M"))


def suggest(ctx, need_bytes, roots=(), name=None, label=None):
    """Where a restored copy of `need_bytes` can go on this host: one proposal per volume, best first.
    Each: {path, root, mountpoint, fstype, source, free, total, free_after, fits, shares[], level ok|warn|bad, why, recommended}."""
    name = name or default_name(label or ctx.stanza)
    need = int(need_bytes * 1.10) + (512 << 20)               # data + WAL replayed/recycled during recovery + the copy's own log
    cands = []                                                    # (priority, root, origin)
    for r in roots or ():
        cands.append((0, r, "configured"))
    try:
        table = mounts()
    except Exception:
        table = []
    pg_dev = _dev(ctx.pgdata) if ctx.pgdata else None
    for mp, fs, _src in table:
        if fs in _SKIP_FS or mp in ("/", "/boot", "/boot/efi") or _system_path(mp):
            continue
        if os.path.isdir(mp) and os.access(mp, os.W_OK | os.X_OK):
            # a volume the agent may write to at its root: an admin prepared it (e.g. /restore). On the volume of the live data it is not "dedicated":
            # the directory next to the data directory is the clearer place there
            cands.append((1 if _dev(mp) != pg_dev else 2.5, mp, "volume"))
    if ctx.pgdata:
        cands.append((2, os.path.dirname(ctx.pgdata.rstrip("/")), "next to the data directory"))
    if ctx.scratch_dir:
        cands.append((3, ctx.scratch_dir, "agent scratch"))
    try:
        cands.append((4, pwd.getpwuid(os.geteuid()).pw_dir, "home of the agent user"))
    except KeyError:
        pass
    cands.append((5, "/var/tmp", "temporary files"))
    shares = {}
    for label, p in (("production data (PGDATA)", ctx.pgdata), ("WAL archive", getattr(ctx, "wal_dir", None)), ("backup repository", getattr(ctx.repo, "path", None))):
        if p:
            d = _dev(p)
            if d is not None:
                shares.setdefault(d, []).append(label)
    seen, out = set(), []
    for prio, root, origin in sorted(cands, key=lambda c: c[0]):
        root = os.path.realpath(root)
        if origin != "configured" and _system_path(root):
            continue
        dev = _dev(root)
        if dev is None or dev in seen or not _writable_dir(root):
            continue
        path = os.path.join(root, name)
        try:
            assert_writable_target(ctx, path, "restore destination")
        except EngineError:
            continue
        free, total = _statvfs(root if os.path.exists(root) else os.path.dirname(root))
        if free is None:
            continue
        mp, fs, src = mount_of(root, table or None)
        if fs in _SKIP_FS:
            continue
        seen.add(dev)
        sh = shares.get(dev, [])
        free_after = free - need
        margin = max(2 << 30, int(total * 0.10))
        if free < need:
            level, why = "bad", "not enough space: %s free, about %s needed" % (human(free), human(need))
        elif "production data (PGDATA)" in sh and free_after < margin:
            level, why = "bad", "same volume as the production data: only %s would be left for production" % human(max(free_after, 0))
        elif "production data (PGDATA)" in sh:
            level, why = "warn", "same volume as the production data: the copy takes %s of its free space (%s left afterwards)" % (human(need), human(free_after))
        elif sh:
            level, why = "warn", "same volume as the %s" % " and the ".join(sh)
        elif fs in _NET_FS:
            level, why = "warn", "network filesystem (%s): restore and recovery are slower" % fs
        else:
            level, why = "ok", "separate volume, %s left afterwards" % human(free_after)
        out.append({"path": path, "root": root, "origin": origin, "mountpoint": mp, "fstype": fs, "source": src, "free": free, "total": total,
                    "free_after": free_after, "need": need, "fits": free >= need, "shares": sh, "level": level, "why": why, "_prio": prio})
    rank = {"ok": 0, "warn": 1, "bad": 2}
    out.sort(key=lambda c: (rank[c["level"]], 0 if c["origin"] == "configured" else 1, -c["free_after"]))
    for i, c in enumerate(out):
        c.pop("_prio", None)
        c["recommended"] = i == 0 and c["level"] != "bad"
    return {"name": name, "need": need, "candidates": out, "recommended": out[0]["path"] if out and out[0]["level"] != "bad" else None}


def instance_bytes(ctx, set_spec, t):
    """Size of the data a whole-instance restore writes (the backup chain merged), without touching anything."""
    from pg_arca.engine.backup import build_chain
    from pg_arca.engine.restore import choose_set, estimate, merge_chain, parse_target_time
    target = choose_set(ctx.repo, set_spec, parse_target_time(t.get("target_time")), t.get("target_lsn"), t.get("target_xid"), t.get("target_name"))
    merged, _tbs = merge_chain(ctx.repo, build_chain(ctx.repo, target))
    return estimate(merged)


# ============================================================================================================== start / wait
def _port_free(p):
    for host in ("0.0.0.0", "127.0.0.1"):
        s = socket.socket()
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, p))
        except OSError:
            return False
        finally:
            s.close()
    return True


def pick_port(eph=None, taken=()):
    """A port operators can remember: 5433..5499 first (or the configured range of the ephemeral instance on a firewalled host)."""
    eph = eph or {}
    if eph.get("port_min"):
        return ephcfg.free_port(eph)
    for p in range(5433, 5500):
        if p not in taken and _port_free(p):
            return p
    return ephcfg.free_port(eph)


def _major(dest):
    v = read_file(os.path.join(dest, "PG_VERSION"), first_line=True).strip()
    return int(v.split(".")[0])


def _postgres_ok(bindir, major):
    i = ephcfg._inst(bindir, "check") if bindir else None
    return bool(i and i.get("major") == major and i.get("complete"))


def _mem_cap_mb():
    try:
        with open("/proc/meminfo") as f:
            kv = dict((l.split(":")[0], int(l.split()[1])) for l in f if l.split()[1:2] and l.split()[1].isdigit())
        avail = kv.get("MemAvailable", kv.get("MemTotal", 0)) // 1024
        return max(128, min(1024, avail // 8))
    except (OSError, ValueError):
        return 256


def _conf_block(it):
    """Appended to postgresql.auto.conf (read last, so it wins). Re-written on every start (the port may change)."""
    lines = ["port = %d" % it["port"], "unix_socket_directories = '%s'" % it["sockdir"].replace("'", "''"), "unix_socket_permissions = 0700",
             "external_pid_file = ''", "cluster_name = 'pgarca-restore'", "logging_collector = off", "log_destination = 'stderr'",
             "huge_pages = 'try'", "shared_buffers = '%dMB'" % it.get("shared_buffers_mb", 256), "hba_file = '%s'" % os.path.join(it["dest"], "pg_hba.conf").replace("'", "''"),
             "ident_file = '%s'" % os.path.join(it["dest"], "pg_ident.conf").replace("'", "''")]
    if it.get("major", 16) < 15:
        lines.append("stats_temp_directory = 'pg_stat_tmp'")
    if it.get("major", 16) >= 18:
        lines.append("io_method = 'worker'")                         # production's io_uring may not be available on this host       # Debian points it at /var/run/postgresql/<ver>-<name>.pg_stat_tmp: shared with production
    for k, v in (it.get("conf_fixes") or {}).items():
        lines.append("%s = %s" % (k, v))
    return "\n# ==== pg_arca: restored instance %s (%s) - own port, private socket, own log; rewritten at every start by the agent ====\n%s\n# ==== end pg_arca restored instance ====\n" % (
        it["id"], iso(), "\n".join(lines))


_BLOCK = re.compile(r"\n# ==== pg_arca: restored instance .*?# ==== end pg_arca restored instance ====\n", re.S)


def _write_conf(it):
    path = os.path.join(it["dest"], "postgresql.auto.conf")
    txt = read_file(path, errors="surrogateescape") if os.path.exists(path) else ""
    txt = _BLOCK.sub("", txt) + _conf_block(it)
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write(txt)
    hba = os.path.join(it["dest"], "pg_hba.conf")
    body = read_file(hba, errors="surrogateescape") if os.path.exists(hba) else ""
    if "# pg_arca restored instance: agent access" not in body:
        # the agent reaches the copy only through its PRIVATE socket directory (0700, agent user): trust there gives it access whatever the copied rules say.
        # TCP access keeps the copied rules of production.
        with open(hba, "w", encoding="utf-8", errors="surrogateescape") as f:
            f.write("# pg_arca restored instance: agent access through the private socket directory (0700)\nlocal all all trust\n" + body)
    ident = os.path.join(it["dest"], "pg_ident.conf")
    if not os.path.exists(ident):
        with open(ident, "w") as f:
            f.write("# pg_arca: empty\n")


def _alive(it):
    """pid of the copy's running postmaster, or None. Without /proc (FreeBSD) the process is asked through ps; a process that exists but cannot
    be identified counts as alive - deleting a running copy's directory is the error to avoid (portability review)."""
    from pg_arca import procs
    pidf = os.path.join(it["dest"], "postmaster.pid")
    try:
        pid = int(read_file(pidf, first_line=True).strip())
    except (OSError, ValueError):
        return None
    v = procs.is_postmaster(pid)
    return pid if v or v is None else None


def _session(it, db="postgres"):
    return PgSession(PgConn(host=it["sockdir"], port=it["port"], user=it.get("user") or "postgres", dbname=db, bindir=it["bindir"]), read_only=False)


# log lines -> automatic fix of the copy's configuration (the copy must start whatever the original host had: huge pages, SSL files, libraries...)
_FIXES = [
    (re.compile(r"could not map anonymous shared memory|huge pages", re.I), "huge_pages", "off", "huge pages not available: started without them"),
    (re.compile(r"could not (load|access) (server certificate|private key|root certificate)|SSL", re.I), "ssl", "off", "SSL files of the original server not usable here: started without SSL (TCP connections unencrypted)"),
    (re.compile(r"could not create (shared memory|semaphores)|shmget|out of memory", re.I), "shared_buffers", "'128MB'", "not enough shared memory: started with shared_buffers 128MB"),
    (re.compile(r"could not bind|Address already in use", re.I), "__port__", None, "port taken in the meantime: started on another port"),
    (re.compile(r"could not create listen socket for \"([^\"]+)\"|Cannot assign requested address", re.I), "listen_addresses", "'localhost'", "the original listen addresses do not exist on this host: listening on localhost only"),
]
_LIB = re.compile(r"could not access file \"(?:\$libdir/)?([^\"]+)\"|could not load library \"[^\"]*/([A-Za-z0-9_.-]+)\.so\"", re.I)


def _start_once(it, timeout=120):
    log = os.path.join(it["dest"], LOG)
    pg_ctl = os.path.join(it["bindir"], "pg_ctl")
    os.makedirs(it["sockdir"], mode=0o700, exist_ok=True)
    _write_conf(it)
    size0 = os.path.getsize(log) if os.path.exists(log) else 0
    r = subprocess.run([pg_ctl, "-D", it["dest"], "-l", log, "-W", "start"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    return r.returncode, (r.stdout or b"").decode("utf-8", "replace"), log, size0


def _new_log(log, size0):
    try:
        with open(log, "rb") as f:
            f.seek(size0)
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def start(it, progress=None, cancel=None, wait=6 * 3600, notes=None):
    """Start the copy and wait until it is usable: promoted (action promote / end of archive), paused at the target (action pause) or cleanly
    shut down at the target (action shutdown). Configuration problems that come from the ORIGINAL host are fixed and retried (at most 5 times)."""
    notes = notes if notes is not None else []
    for attempt in range(6):
        if _alive(it):
            break
        _check_cancel(cancel)
        rc, out, log, size0 = _start_once(it)
        t0 = time.time()
        died = None
        while time.time() - t0 < 20:                      # the usual start-up failures show within seconds
            if _alive(it):
                break
            time.sleep(0.5)
            txt = _new_log(log, size0)
            if "database system is shut down" in txt or "FATAL" in txt or "PANIC" in txt:
                if not _alive(it):
                    died = txt
                    break
        if died is None and _alive(it):
            break
        txt = died if died is not None else (_new_log(log, size0) + out)
        if "shutdown at recovery target" in txt:
            it["state"] = "stopped"
            return {"state": "stopped", "note": "recovery reached the target and shut the copy down (action shutdown)"}
        fixed = False
        m = _LIB.search(txt)
        if m:
            lib = os.path.basename(m.group(1) or m.group(2)).replace(".so", "")
            cur = it.setdefault("conf_fixes", {}).get("shared_preload_libraries")
            libs = [x for x in (cur.strip("'").split(",") if cur else _preload(it)) if x.strip() and x.strip() != lib]
            it["conf_fixes"]["shared_preload_libraries"] = "'%s'" % ",".join(x.strip() for x in libs)
            notes.append("library %s is not installed on this host: the copy started without it (objects that need it will not work)" % lib)
            fixed = True
        else:
            for rx, key, val, msg in _FIXES:
                if rx.search(txt) and not (key in (it.get("conf_fixes") or {}) and key != "__port__"):
                    if key == "__port__":
                        it["port"] = pick_port(it.get("eph"), taken={it["port"]})
                    else:
                        it.setdefault("conf_fixes", {})[key] = val
                    notes.append(msg)
                    fixed = True
                    break
        if not fixed:
            raise EngineError("PGA-RST-051", "the restored copy did not start:\n%s" % _tail_text(txt or tail_file(log, 30)),
                              "the copy is complete in %s: fix the cause shown above, then press Start (or delete the copy)" % it["dest"])
    else:
        raise EngineError("PGA-RST-052", "the restored copy did not start after %d automatic corrections" % len(notes), "see %s" % os.path.join(it["dest"], LOG))
    return _wait_ready(it, progress, cancel, wait, notes)


def _preload(it):
    for fn in ("postgresql.auto.conf", "postgresql.conf"):
        try:
            for line in reversed(read_file(os.path.join(it["dest"], fn)).splitlines()):
                m = re.match(r"\s*shared_preload_libraries\s*=\s*'([^']*)'", line)
                if m:
                    return m.group(1).split(",")
        except OSError:
            pass
    return []


def _tail_text(txt, n=25):
    lines = [l for l in txt.splitlines() if l.strip()]
    return "\n".join(lines[-n:])


_RESTORED_SEG = re.compile(r"restored log file \"([0-9A-F]{24})\"")


def _wait_ready(it, progress, cancel, wait, notes):
    log = os.path.join(it["dest"], LOG)
    t0 = time.time()
    last_seg, s = None, None
    try:
        while time.time() - t0 < wait:
            _check_cancel(cancel)
            if not _alive(it):
                txt = tail_file(log, 40)
                if "shutdown at recovery target" in txt:
                    it["state"] = "stopped"
                    return {"state": "stopped", "notes": notes}
                raise EngineError("PGA-RST-053", "the restored copy stopped during recovery:\n%s" % _tail_text(txt),
                                  "common causes: a WAL segment missing from the archive, a target before the end of the backup; the copy stays in %s" % it["dest"])
            if s is None:
                try:
                    s = _session(it)
                except EngineError:
                    s = None
            if s is None:
                m = _RESTORED_SEG.findall(tail_file(log, 20))
                if m and m[-1] != last_seg:
                    last_seg = m[-1]
                if progress:
                    progress({"phase": "recovery", "msg": "WAL replay up to consistency%s" % (" (segment %s)" % last_seg if last_seg else "")})
                time.sleep(1)
                continue
            try:
                inrec = s.scalar("SELECT pg_is_in_recovery()")
                if inrec == "f":
                    it["state"] = "running"
                    return {"state": "running", "notes": notes}
                lsn = s.scalar("SELECT COALESCE(pg_last_wal_replay_lsn()::text,'-')")
                paused = s.scalar(s.profile.replay_paused_sql()) == "1"           # 14+: pause state; 12/13: pg_is_wal_replay_paused()
            except EngineError as e:
                if "not in progress" in (e.message or ""):
                    continue
                s.close()
                s = None
                time.sleep(1)
                continue
            if paused:
                it["state"] = "paused"
                return {"state": "paused", "replay_lsn": lsn, "notes": notes}
            if progress:
                progress({"phase": "recovery", "msg": "replay at %s" % lsn})
            time.sleep(1)
    finally:
        if s is not None:
            s.close()
    raise EngineError("PGA-RST-054", "the restored copy did not reach the target within %d s" % wait, "it keeps recovering: follow it from the restored instances list")


def info(it):
    """What the console shows: state now, how to connect, expiry."""
    pid = _alive(it)
    out = {k: it.get(k) for k in ("id", "name", "dest", "port", "sockdir", "major", "set", "target", "action", "created", "expires_at", "want", "size_bytes",
                                   "listen_addresses", "user", "op_id", "error", "notes", "databases", "bindir", "extra_dirs", "keep")}
    out["running"] = bool(pid)
    st = it.get("state")
    if not pid and st in ("running", "paused", "recovering"):
        st = "down"
    out["state"] = st
    return out


def _listen(it):
    for fn in ("postgresql.auto.conf", "postgresql.conf"):
        try:
            for line in reversed(read_file(os.path.join(it["dest"], fn)).splitlines()):
                m = re.match(r"\s*listen_addresses\s*=\s*'([^']*)'", line)
                if m:
                    return m.group(1)
        except OSError:
            pass
    return "localhost"


def _databases(it):
    try:
        s = _session(it)
        try:
            out = s.query("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1")
            return [r[0] for r in out]
        finally:
            s.close()
    except EngineError:
        return None


# ============================================================================================================== lifecycle (called by the executor)
def register_and_start(ctx, state_dir, dest, plan, action="promote", ttl_hours=DEFAULT_TTL_H, op_id="", progress=None, cancel=None):
    """After restore_instance wrote the copy: register it and start it. Returns the registry entry as the console shows it."""
    dest = os.path.realpath(dest)
    major = _major(dest)
    eph = getattr(ctx, "eph", None) or {}
    bindir, src = ephcfg.pick_bindir(major, eph, ctx.conn.bindir)
    rid = "rst-" + uuid.uuid4().hex[:8]
    now = datetime.now(timezone.utc)
    it = {"id": rid, "name": os.path.basename(dest), "dest": dest, "major": major, "bindir": bindir, "set": plan.get("set"), "target": plan.get("target"),
          "action": action, "created": iso(), "op_id": op_id, "stanza": ctx.stanza, "user": ctx.conn.user, "size_bytes": plan.get("bytes"),
          "expires_at": (now + timedelta(hours=ttl_hours)).isoformat() if ttl_hours else None, "keep": not ttl_hours,
          "extra_dirs": [v for k, v in (plan.get("tablespaces") or {}).items() if k in (plan.get("tablespaces_relocated") or [])],
          "shared_buffers_mb": int(eph.get("shared_buffers_mb") or _mem_cap_mb()), "want": "running", "state": "starting", "eph": {k: eph.get(k) for k in ("port_min", "port_max") if eph.get(k)}}
    with open(os.path.join(dest, MARK), "w") as f:
        json.dump({"id": rid, "created": it["created"], "stanza": ctx.stanza}, f)
    with _Locked(state_dir) as L:
        it["port"] = pick_port(it["eph"], taken={x.get("port") for x in L.items})
        it["sockdir"] = _sockdir(dest, rid)
        L.items.append(it)
        L.save()
    if not _postgres_ok(bindir, major):
        _update(state_dir, rid, state="failed", want="stopped", error="PostgreSQL %d binaries are not installed on this host" % major)
        raise EngineError("PGA-RST-050", "the copy is restored in %s, but PostgreSQL %d is not installed on this host, so it cannot be started here" % (dest, major),
                          "install PostgreSQL %d (Storage & recovery -> Recovery instance -> Install the binaries), then press Start on the restored copy" % major)
    notes = []
    # the copy fetches WAL from the archive while it recovers: retention keeps the WAL from its base on until it is ready (independent review)
    pin = None
    try:
        chain = [c["id"] for c in build_chain(ctx.repo, ctx.repo.resolve_set(plan.get("set")))] if plan.get("set") else []
        if chain:
            pin = ctx.repo.pinned(chain, ctx.repo.resolve_set(chain[0]).get("start_lsn"), name="copy-" + rid)
            pin.__enter__()
    except Exception:
        pin = None
    try:
        res = start(it, progress, cancel, notes=notes)
    except EngineError as e:
        _update(state_dir, rid, state="failed", error=e.message[:2000], port=it["port"], conf_fixes=it.get("conf_fixes"), notes=notes)
        raise
    except Exception:
        _stop(it)                                           # cancelled (or broken) while recovering: the copy stays on disk, stopped, and expires as usual
        _update(state_dir, rid, state="stopped", want="stopped", port=it["port"], conf_fixes=it.get("conf_fixes"), notes=notes)
        raise
    finally:
        if pin is not None:
            pin.__exit__(None, None, None)
    it.update(state=res["state"], notes=notes, listen_addresses=_listen(it), databases=_databases(it) if res["state"] != "stopped" else None, error=None)
    if res["state"] == "stopped":
        it["want"] = "stopped"
    _update(state_dir, rid, **{k: it.get(k) for k in ("state", "notes", "listen_addresses", "databases", "error", "port", "conf_fixes", "want")})
    return info(it)


def _sockdir(dest, rid):
    from pg_arca.engine.ephemeral import short_socket_dir
    return short_socket_dir(os.path.join(dest, ".s"))


def _update(state_dir, rid, **kw):
    with _Locked(state_dir) as L:
        it = _find(L.items, rid)
        it.update(kw)
        L.save()
        return dict(it)


def _stop(it, mode="fast"):
    if not _alive(it):
        return False
    subprocess.run([os.path.join(it["bindir"], "pg_ctl"), "-D", it["dest"], "-m", mode, "-w", "-t", "120", "stop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
    if _alive(it) and mode != "immediate":
        return _stop(it, "immediate")
    return True


def list_all(state_dir):
    return [info(it) for it in load(state_dir)]


def op_stop(state_dir, rid):
    with _Locked(state_dir) as L:
        it = _find(L.items, rid)
        it["want"] = "stopped"
        L.save()
    _stop(it)
    return info(_update(state_dir, rid, state="stopped"))


def op_start(state_dir, rid, progress=None, cancel=None):
    with _Locked(state_dir) as L:
        it = dict(_find(L.items, rid))
    if not os.path.isdir(it["dest"]):
        raise EngineError("PGA-RST-061", "the directory of the restored copy is gone: %s" % it["dest"], "delete the entry")
    if not _postgres_ok(it["bindir"], it["major"]):
        bd, _src = ephcfg.pick_bindir(it["major"], it.get("eph") or {}, "")
        if not _postgres_ok(bd, it["major"]):
            raise EngineError("PGA-RST-050", "PostgreSQL %d is not installed on this host" % it["major"], "install the binaries of that version, then start again")
        it["bindir"] = bd
    if not _alive(it) and not _port_free(it["port"]):
        it["port"] = pick_port(it.get("eph"), taken={it["port"]})
    notes = list(it.get("notes") or [])
    try:
        res = start(it, progress, cancel, notes=notes)
    except EngineError as e:
        _update(state_dir, rid, state="failed", error=e.message[:2000], port=it["port"], bindir=it["bindir"], conf_fixes=it.get("conf_fixes"))
        raise
    it.update(state=res["state"], want="running" if res["state"] != "stopped" else "stopped", error=None, notes=notes, listen_addresses=_listen(it))
    if res["state"] != "stopped":
        it["databases"] = _databases(it)
    return info(_update(state_dir, rid, **{k: it.get(k) for k in ("state", "want", "error", "notes", "listen_addresses", "databases", "port", "bindir", "conf_fixes")}))


def op_resume(state_dir, rid, progress=None, cancel=None):
    """A copy paused at the target: end the recovery (it becomes a normal read-write server, still isolated from production)."""
    it = dict(_find(load(state_dir), rid))
    if not _alive(it):
        raise EngineError("PGA-RST-062", "the restored copy is not running", "start it first")
    s = _session(it)
    try:
        if s.scalar("SELECT pg_is_in_recovery()") == "t":
            s.scalar("SELECT pg_promote(true, 120)")
    finally:
        s.close()
    res = _wait_ready(it, progress, cancel, 300, list(it.get("notes") or []))
    return info(_update(state_dir, rid, state=res["state"], action="promote"))


def op_keep(state_dir, rid, hours=None):
    """hours=None or 0: keep until deleted by hand; otherwise expire that many hours from now."""
    exp = (datetime.now(timezone.utc) + timedelta(hours=float(hours))).isoformat() if hours else None
    return info(_update(state_dir, rid, expires_at=exp, keep=not hours))


def op_drop(ctx, state_dir, rid, confirm=None):
    with _Locked(state_dir) as L:
        it = dict(_find(L.items, rid))
    if confirm is not None and confirm != it["name"]:
        raise EngineError("PGA-RST-063", "confirmation does not match the name of the copy (%s)" % it["name"], "type the name shown in the list")
    _drop_files(ctx, it)
    with _Locked(state_dir) as L:
        L.items = [x for x in L.items if x.get("id") != rid]
        L.save()
    return {"deleted": rid, "name": it["name"], "freed_bytes": it.get("size_bytes")}


def _drop_files(ctx, it):
    _stop(it, "immediate")
    dest = it["dest"]
    if os.path.isdir(dest):
        mark = os.path.join(dest, MARK)
        try:
            ok = json.loads(read_file(mark)).get("id") == it["id"]
        except (OSError, ValueError):
            ok = False
        if not ok:
            raise EngineError("PGA-RST-064", "refusing to delete %s: it is not marked as restored copy %s" % (dest, it["id"]), "delete it by hand if it is really unused")
        if ctx is not None:
            assert_writable_target(ctx, dest, "restored copy")             # never a live data directory, whatever the registry says
        shutil.rmtree(dest, ignore_errors=True)
    for d in it.get("extra_dirs") or []:
        if d and os.path.realpath(d).startswith(os.path.realpath(dest) + "_tblspc"):
            shutil.rmtree(d, ignore_errors=True)
    tb = os.path.realpath(dest) + "_tblspc"
    if os.path.isdir(tb) and not os.listdir(tb):
        os.rmdir(tb)
    sd = it.get("sockdir")
    if sd and not sd.startswith(dest + os.sep):
        shutil.rmtree(sd, ignore_errors=True)


# ============================================================================================================== housekeeping (agent runtime)
_hk = {"at": 0.0, "restarted": {}}


def housekeeping(state_dir, ctx=None, log=None, every=60):
    """Expired copies are stopped and deleted; copies that should run but do not (agent restart, host reboot) are started again, at most once every
    10 minutes each. Returns the list for the snapshot (cheap: reads the registry and checks pids)."""
    items = load(state_dir)
    if not items:
        return []
    now = time.time()
    if now - _hk["at"] >= every:
        _hk["at"] = now
        for it in items:
            try:
                exp = it.get("expires_at")
                if exp and _parse_iso(exp) < datetime.now(timezone.utc):
                    threading.Thread(target=_expire, args=(state_dir, ctx() if callable(ctx) else ctx, it, log), daemon=True).start()
                    continue
                if it.get("want") == "running" and it.get("state") in ("running", "paused") and not _alive(it):
                    if now - _hk["restarted"].get(it["id"], 0) > 600:
                        _hk["restarted"][it["id"]] = now
                        threading.Thread(target=_restart, args=(state_dir, it, log), daemon=True).start()
            except Exception as e:
                if log:
                    log("warning", "restored instance %s housekeeping: %s" % (it.get("id"), e))
    return [info(it) for it in items]


def _expire(state_dir, ctx, it, log):
    try:
        _drop_files(ctx, it)
        with _Locked(state_dir) as L:
            L.items = [x for x in L.items if x.get("id") != it["id"]]
            L.save()
        if log:
            log("info", "restored copy %s (%s) expired and was deleted" % (it["name"], it["dest"]))
    except Exception as e:
        if log:
            log("warning", "restored copy %s could not be deleted at expiry: %s" % (it.get("name"), e))


def _restart(state_dir, it, log):
    try:
        op_start(state_dir, it["id"])
        if log:
            log("info", "restored copy %s started again (it was not running)" % it["name"])
    except Exception as e:
        if log:
            log("warning", "restored copy %s could not be started again: %s" % (it.get("name"), e))
