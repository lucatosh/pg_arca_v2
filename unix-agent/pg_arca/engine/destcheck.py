"""Is this directory a safe home for the backup repository / WAL archive?

pg_arca writes to POSIX paths. A network share (NFS, SMB/CIFS) works as long as it is MOUNTED on the node: this module never mounts anything, it reports whether the path
is really on the expected kind of filesystem, whether it can be written the way the engine writes (exclusive create, fsync, atomic rename), how much room there is and what
already lives there. The classic disaster it prevents: the share is not mounted at backup time and the backups silently land on the local root disk.
Object stores (S3, Azure, GCS) and SFTP have no engine backend yet: they are not accepted here.
"""
import os
import re
import time
import uuid

from pg_arca.engine.util import EngineError

NETWORK_FS = ("nfs", "nfs4", "cifs", "smb3", "smbfs", "ceph", "glusterfs", "lustre", "gpfs", "beegfs", "panfs", "fuse.sshfs", "fuse.glusterfs", "afs", "9p")
FUSE_OBJECT = ("fuse.s3fs", "fuse.rclone", "fuse.gcsfuse", "fuse.goofys", "fuse.blobfuse", "fuse.blobfuse2", "fuse.mountpoint-s3")


def _unescape(s):
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)


def mounts(path="/proc/self/mountinfo"):
    """[(mountpoint, fstype, source)] from mountinfo (works in containers; /proc/mounts as a fallback)."""
    out = []
    try:
        with open(path) as f:
            for line in f:
                p = line.rstrip("\n").split(" ")
                if "-" not in p:
                    continue
                i = p.index("-")
                out.append((_unescape(p[4]), p[i + 1], _unescape(p[i + 2]) if len(p) > i + 2 else ""))
    except (IOError, OSError):
        try:
            with open("/proc/mounts") as f:
                for line in f:
                    p = line.split()
                    out.append((_unescape(p[1]), p[2], _unescape(p[0])))
        except (IOError, OSError):
            pass
    return out


def mount_of(path, table=None):
    """The mount that holds `path`: the longest mountpoint that is a prefix of the real path. Returns (mountpoint, fstype, source)."""
    real = os.path.realpath(path)
    best = ("/", "unknown", "")
    for mp, fs, src in (table if table is not None else mounts()):
        if real == mp or real.startswith(mp.rstrip("/") + "/") or mp == "/":
            if len(mp) >= len(best[0]):
                best = (mp, fs, src)
    return best


def _existing(path):
    p = path
    while p and not os.path.exists(p):
        p = os.path.dirname(p)
    return p or "/"


def _write_probe(directory):
    """Write the way the engine does: exclusive create, fsync, atomic rename, read back. Returns {ok, error, ms}."""
    t0 = time.time()
    name = ".pgarca-probe-%s" % uuid.uuid4().hex[:10]
    tmp, fin = os.path.join(directory, name + ".tmp"), os.path.join(directory, name)
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, b"pg_arca probe\n")
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
            return {"ok": False, "error": "exclusive create did not fail on an existing file: the filesystem does not honour O_EXCL (the WAL archive relies on it)"}
        except FileExistsError:
            pass
        os.rename(tmp, fin)
        dfd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
        with open(fin, "rb") as f:
            if f.read() != b"pg_arca probe\n":
                return {"ok": False, "error": "read back differs from what was written"}
        return {"ok": True, "ms": round((time.time() - t0) * 1000, 1)}
    except OSError as e:
        return {"ok": False, "error": "%s" % e}
    finally:
        for p in (tmp, fin):
            try:
                os.unlink(p)
            except OSError:
                pass


def _bench(directory, mb=32):
    """Sequential write + fsync of `mb` MiB, then read: measured numbers, not claims."""
    path = os.path.join(directory, ".pgarca-bench-%s" % uuid.uuid4().hex[:10])
    buf = os.urandom(1024 * 1024)
    try:
        t0 = time.time()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            for _ in range(mb):
                os.write(fd, buf)
            os.fsync(fd)
        finally:
            os.close(fd)
        w = time.time() - t0
        t0 = time.time()
        with open(path, "rb") as f:
            while f.read(1024 * 1024):
                pass
        r = time.time() - t0
        return {"mb": mb, "write_mb_s": round(mb / max(w, 1e-6), 1), "read_mb_s": round(mb / max(r, 1e-6), 1), "note": "read may be served from the page cache"}
    except OSError as e:
        return {"error": str(e)}
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _inventory(kind, path, stanza):
    """What already lives there (read-only)."""
    out = {}
    try:
        if kind == "repo":
            base = os.path.join(path, "stanza", stanza) if stanza else path
            bk = os.path.join(base, "backup")
            out["sets"] = len([d for d in os.listdir(bk) if os.path.isdir(os.path.join(bk, d))]) if os.path.isdir(bk) else 0
            out["has_repository"] = os.path.isdir(os.path.join(path, "cas")) or os.path.isdir(os.path.join(path, "stanza"))
        else:
            out["wal_files"] = sum(1 for n in os.listdir(path) if not n.startswith(".")) if os.path.isdir(path) else 0
    except OSError:
        pass
    return out


def check_path(kind, path, dtype="local", require_mount=False, min_free_gb=None, stanza=None, current=None, protected=(), bench=False, table=None):
    """One path (kind 'repo' or 'wal'). Returns {path, checks:[{id, level, text, fix}], ok, mount:{...}, free_bytes, inventory}."""
    from pg_arca import overrides
    checks = []

    def add(cid, level, text, fix=None):
        d = {"id": cid, "level": level, "text": text}
        if fix:
            d["fix"] = fix
        checks.append(d)
    res = {"kind": kind, "path": path, "checks": checks}
    try:
        norm = overrides._abs_dir(path)
        rl = os.path.realpath(norm)
        if norm in overrides._FORBIDDEN_WRITE or rl in overrides._FORBIDDEN_WRITE or any(rl == f or rl.startswith(f + "/") for f in overrides._FORBIDDEN_UNDER):
            raise overrides.OverrideError("cartella di sistema non ammessa: usa una sottocartella dedicata (per esempio /mnt/backup/pgarca)")
    except overrides.OverrideError as e:
        add("path", "bad", str(e))
        res["ok"] = False
        return res
    real = os.path.realpath(path)
    for pr in protected:
        if pr and (real == os.path.realpath(pr) or real.startswith(os.path.realpath(pr).rstrip("/") + "/") or os.path.realpath(pr).startswith(real.rstrip("/") + "/")):
            add("protected", "bad", "%s overlaps %s (the data directory, the other archive or the agent's own state): choose a dedicated directory" % (path, pr))
            res["ok"] = False
            return res
    ex = _existing(real)
    mp, fs, src = mount_of(ex, table)
    res["mount"] = {"mountpoint": mp, "fstype": fs, "source": src}
    network = fs in NETWORK_FS
    # ---- is it on the filesystem the destination says it is?
    if fs in FUSE_OBJECT:
        add("fs", "warn", "%s is a FUSE mount of an object store (%s): rename and fsync semantics are not those of a filesystem, so backups may be slow or inconsistent after a failure" % (path, fs),
            "use a real filesystem or NFS/SMB; native object storage support is not available yet")
    elif dtype in ("nfs", "smb"):
        want = ("nfs", "nfs4") if dtype == "nfs" else ("cifs", "smb3", "smbfs")
        if fs in want:
            add("fs", "ok", "%s is on %s (%s)" % (path, fs, src))
        elif network:
            add("fs", "warn", "%s is on %s but the destination says %s" % (path, fs, dtype.upper()))
        else:
            add("fs", "bad", "%s is NOT on a %s share: it is on %s (%s). The share is not mounted here, and backups would fill the local disk" % (path, dtype.upper(), fs, mp),
                "mount the share first (for example with an /etc/fstab entry), then check again")
    else:
        add("fs", "ok", "%s is on %s%s" % (path, fs, " (a network filesystem)" if network else ""))
    if require_mount:
        if mp == "/":
            add("mount", "bad", "%s is on the root filesystem, but a separate mount is required for this destination" % path, "mount the backup volume or share before enabling backups")
        else:
            add("mount", "ok", "separate mount %s" % mp)
    # ---- create / write / space (never creates anything when the mount is wrong: that would put the directory on the local disk)
    if any(c["level"] == "bad" for c in checks):
        add("write", "warn", "not tested: fix the problems above first (nothing was created)")
        res["inventory"] = _inventory(kind, real, stanza)
        res["ok"] = False
        return res
    try:
        os.makedirs(real, mode=0o700, exist_ok=True)
        creatable = True
    except OSError as e:
        creatable = False
        add("write", "bad", "cannot create %s: %s" % (path, e), "create it with the agent's OS user as owner, or fix the permissions on the parent")
    if creatable:
        probe = _write_probe(real)
        if probe["ok"]:
            add("write", "ok", "writable: exclusive create, fsync and atomic rename work (%s ms)" % probe["ms"])
        else:
            add("write", "bad", "write test failed: %s" % probe["error"], "check ownership, the mount options (no 'ro', root squash on NFS) and free space")
        try:
            st = os.statvfs(real)
            free = st.f_bavail * st.f_frsize
            total = st.f_blocks * st.f_frsize
            res["free_bytes"], res["total_bytes"] = free, total
            gb = free / float(1 << 30)
            if min_free_gb and gb < float(min_free_gb):
                add("space", "bad", "only %.1f GiB free, the minimum is %s GiB" % (gb, min_free_gb), "free space or choose a bigger volume")
            else:
                add("space", "ok", "%.1f GiB free of %.1f GiB" % (gb, total / float(1 << 30)))
        except OSError:
            pass
        if bench and probe["ok"]:
            res["bench"] = _bench(real)
    res["inventory"] = _inventory(kind, real, stanza)
    if current and os.path.realpath(current) != real:
        inv = _inventory(kind, os.path.realpath(current), stanza)
        n = inv.get("sets") if kind == "repo" else inv.get("wal_files")
        if n:
            add("existing", "warn", "the current location %s holds %d %s that are NOT moved to the new one" % (current, n, "backup set(s)" if kind == "repo" else "WAL file(s)"),
                "keep the old location until the new chain has a full backup; restores of old backups still read from the old path")
    res["ok"] = not any(c["level"] == "bad" for c in checks)
    return res


def check_destination(p, protected=(), current_repo=None, current_wal=None, table=None):
    """p = {type, repo_path, wal_path, require_mount, min_free_gb, stanza, bench}. Checks both paths and that they are different."""
    dtype = p.get("type") or "local"
    if dtype not in ("local", "nfs", "smb"):
        raise EngineError("PGA-DST-001", "destination type %r is not supported by the engine yet" % dtype, "supported: a local directory, or a mounted NFS/SMB share; object storage needs a native backend")
    out = {"type": dtype, "paths": []}
    repo, wal = p.get("repo_path"), p.get("wal_path")
    if not repo and not wal:
        raise EngineError("PGA-DST-002", "nothing to check: give repo_path and/or wal_path")
    if repo and wal and os.path.realpath(repo) == os.path.realpath(wal):
        raise EngineError("PGA-DST-003", "the repository and the WAL archive must be different directories")
    for kind, path, cur in (("repo", repo, current_repo), ("wal", wal, current_wal)):
        if path:
            out["paths"].append(check_path(kind, path, dtype, bool(p.get("require_mount")), p.get("min_free_gb"), p.get("stanza"), cur, protected, bool(p.get("bench")), table))
    out["ok"] = all(x["ok"] for x in out["paths"])
    return out
