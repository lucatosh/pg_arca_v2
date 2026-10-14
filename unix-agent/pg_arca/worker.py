"""Worker hosts: hosts that run the pg_arca agent WITHOUT a database of their own - a backup server holding repositories,
a host dedicated to the ephemeral recovery instances, a machine that runs restore drills.

On such a host the agent must not look for a PostgreSQL to manage (there is none, and a local test instance would be mistaken for a cluster); it reports
instead what matters for its job: the PostgreSQL server binaries installed per major version (what recoveries it can run), the filesystems with their free
space and type (local disk, NFS, SMB...), the pg_arca directories (scratch, repository, WAL archive), CPU and memory.

The role comes from the agent configuration (node_role = worker, or PG_ARCA_ROLE=worker at install time) or from the console (a node enrolled with a
"worker host" token, or approved as one): the console tells the agent in every heartbeat answer and the agent remembers it in its credentials.
Python 3.6+, stdlib only.
"""
import os
import time

ROLES = ("auto", "database", "worker")
# filesystems worth showing: real storage, local or remote. Pseudo filesystems (proc, sysfs, cgroup, tmpfs of /run...) are not.
REAL_FS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "jfs", "reiserfs", "f2fs", "nfs", "nfs4", "cifs", "smb3", "smbfs", "ceph", "cephfs", "glusterfs",
           "fuse.glusterfs", "gpfs", "lustre", "ocfs2", "gfs2", "vfat", "exfat", "ntfs", "fuse.sshfs", "overlay"}
REMOTE_FS = {"nfs", "nfs4", "cifs", "smb3", "smbfs", "ceph", "cephfs", "glusterfs", "fuse.glusterfs", "gpfs", "lustre", "fuse.sshfs"}


def is_worker(config, creds=None):
    role = str((config or {}).get("node_role") or "auto").lower()
    if role == "worker":
        return True
    if role == "database":
        return False
    return str((creds or {}).get("node_kind") or "") == "worker"


def _unescape(s):
    return s.replace("\\040", " ").replace("\\011", "\t").replace("\\012", "\n").replace("\\134", "\\")


def mounts(path="/proc/mounts", limit=40):
    """Mounted filesystems that hold data, with free space. Bind mounts of the same device are listed once (the shortest mount point)."""
    out, seen = [], {}
    try:
        with open(path) as f:
            lines = f.read().splitlines()
    except (IOError, OSError):
        return out
    for line in lines:
        parts = line.split()
        if len(parts) < 3:
            continue
        dev, mnt, fstype = parts[0], _unescape(parts[1]), parts[2]
        if fstype not in REAL_FS:
            continue
        if fstype == "overlay" and mnt != "/":
            continue                                             # container layers: only the root is meaningful
        try:
            st = os.statvfs(mnt)
            did = os.stat(mnt).st_dev
        except OSError:
            continue
        if did in seen and len(seen[did]["mount"]) <= len(mnt):
            continue
        rec = {"mount": mnt, "fstype": fstype, "device": dev[:120], "remote": fstype in REMOTE_FS, "total_bytes": st.f_blocks * st.f_frsize,
               "free_bytes": st.f_bavail * st.f_frsize, "dev": did, "readonly": bool(os.statvfs(mnt).f_flag & os.ST_RDONLY) if hasattr(os, "ST_RDONLY") else False}
        if did in seen:
            out.remove(seen[did])
        seen[did] = rec
        out.append(rec)
    out.sort(key=lambda r: r["mount"])
    return out[:limit]


def _dir_info(p):
    if not p:
        return None
    d = {"path": p, "exists": os.path.isdir(p)}
    probe = p
    while probe and not os.path.exists(probe):
        probe = os.path.dirname(probe)
    try:
        st = os.statvfs(probe or "/")
        d.update(free_bytes=st.f_bavail * st.f_frsize, total_bytes=st.f_blocks * st.f_frsize, dev=os.stat(probe or "/").st_dev,
                 writable=os.access(p if d["exists"] else (probe or "/"), os.W_OK))
    except OSError:
        pass
    return d


class Inventory(object):
    """What an operational machine can do. The expensive part (PostgreSQL installations, host facts with a sudo probe) is cached for `ttl` seconds;
    disks and directories are cheap and always fresh."""

    def __init__(self, config, ttl=600):
        self.config, self.ttl, self._at, self._slow = config, ttl, 0.0, None

    def refresh(self):
        self._at = 0.0

    def get(self):
        from pg_arca.engine import ephcfg
        if self._slow is None or time.time() - self._at > self.ttl:
            try:
                inst = ephcfg.scan_installations({"bin_dir": self.config.get("pg_bin_dir") or None})
            except Exception as e:                                   # never let an inventory problem stop the heartbeat
                inst = [{"error": str(e)[:200]}]
            try:
                facts = ephcfg.host_facts()
            except Exception as e:
                facts = {"error": str(e)[:200]}
            self._slow = {"pg_installations": [{k: i.get(k) for k in ("major", "version", "bindir", "source", "missing_tools")} for i in inst],
                          "host": facts}
            self._at = time.time()
        out = dict(self._slow)
        out["mounts"] = mounts()
        out["dirs"] = {k: _dir_info(self.config.get(v)) for k, v in (("scratch", "scratch_dir"), ("repo", "repo_path"), ("wal_archive", "wal_archive_dir"))}
        out["role"] = "worker"
        return out
