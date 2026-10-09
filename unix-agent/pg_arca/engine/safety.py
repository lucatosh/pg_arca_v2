"""Safety barriers: protected paths, writable-target checks, symlink audit. Never disabled, never optional."""

import os

from pg_arca.engine.util import EngineError


def collect_protected_paths(ctx):
    """(device, inode) -> path for every PGDATA that is configured or has a live postmaster, plus their tablespaces."""
    paths = set()
    if ctx.pgdata:
        paths.add(ctx.pgdata)
    try:
        pids = [p for p in os.listdir("/proc") if p.isdigit()]
    except OSError:
        pids = []
    for pid in pids:
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as f:
                cmd = f.read().decode(errors="replace").split("\x00")
            if not cmd or "postgres" not in os.path.basename(cmd[0]):
                continue
            for i, a in enumerate(cmd):
                if a == "-D" and i + 1 < len(cmd):
                    paths.add(os.path.realpath(cmd[i + 1]))
                elif a.startswith("-D") and len(a) > 2:
                    paths.add(os.path.realpath(a[2:]))
            cwd = os.path.realpath("/proc/%s/cwd" % pid)
            if os.path.exists(os.path.join(cwd, "PG_VERSION")):
                paths.add(cwd)
        except (OSError, IOError, IndexError):
            continue
    for p in list(paths):
        tb = os.path.join(p, "pg_tblspc")
        if os.path.isdir(tb):
            for e in os.listdir(tb):
                try:
                    paths.add(os.path.realpath(os.path.join(tb, e)))
                except OSError:
                    pass
    for p in ctx.protected_extra:
        if p:
            paths.add(os.path.realpath(p))
    ids = {}
    for p in paths:
        try:
            st = os.stat(p)
            ids[(st.st_dev, st.st_ino)] = p
        except OSError:
            pass
    return ids


def _inside_protected(target, protected):
    """True if target IS or lies INSIDE a protected path (compared by real path AND by inode chain)."""
    t = os.path.realpath(target)
    for p in protected.values():
        rp = os.path.realpath(p)
        if t == rp or t.startswith(rp + os.sep) or rp.startswith(t + os.sep):
            return p
    cur = t
    while True:
        try:
            st = os.stat(cur)
            if (st.st_dev, st.st_ino) in protected:
                return protected[(st.st_dev, st.st_ino)]
        except OSError:
            pass
        nxt = os.path.dirname(cur)
        if nxt == cur:
            break
        cur = nxt
    return None


def assert_writable_target(ctx, target, what="destination"):
    """The engine NEVER writes into a configured/active PGDATA (or tablespace), nor above/below one."""
    target = os.path.realpath(target)
    hit = _inside_protected(target, collect_protected_paths(ctx))
    if hit:
        raise EngineError("PGA-SEC-003", "%s '%s' overlaps the protected path '%s'" % (what, target, hit),
                          "stop that cluster and use a different directory; the engine never writes into a live data directory")
    pid_file = os.path.join(target, "postmaster.pid")
    if os.path.exists(pid_file):
        try:
            pid = int(open(pid_file).readline().strip())
            os.kill(pid, 0)
            raise EngineError("PGA-SEC-004", "%s '%s' contains a running postmaster (pid %d)" % (what, target, pid), "stop PostgreSQL first")
        except (ValueError, ProcessLookupError, OSError):
            pass
    return target


def audit_symlinks(root):
    """INV-08: no symlink may point outside root."""
    root = os.path.realpath(root)
    bad = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        for name in dirnames + filenames:
            p = os.path.join(dirpath, name)
            if os.path.islink(p):
                tgt = os.path.realpath(p)
                if not (tgt == root or tgt.startswith(root + os.sep)):
                    bad.append((p, tgt))
    return bad
