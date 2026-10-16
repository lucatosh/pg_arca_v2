"""Processes without assuming /proc (FreeBSD has none by default; a hardened Linux may hide other users' entries).

Used wherever the agent must know whether a postmaster is alive before it stops, replaces or deletes something: when the answer cannot be
told, the callers that would DELETE or OVERWRITE treat the process as alive (fail closed). Portability review 16/10: without /proc a running
restored copy read as "dead" and its directory was deleted under it.
"""
import errno
import os
import subprocess

POSTMASTER_NAMES = ("postgres", "postmaster", "edb-postgres")
HAVE_PROC = os.path.isdir("/proc/self")


def exists(pid):
    """True / False: a process with this pid exists (EPERM: it exists, it belongs to someone else)."""
    try:
        os.kill(int(pid), 0)
        return True
    except OSError as e:
        return e.errno == errno.EPERM
    except (ValueError, TypeError):
        return False


def cmdline(pid):
    """[argv] of a process, [] when it does not exist, None when it exists but cannot be read."""
    try:
        pid = int(pid)
    except (ValueError, TypeError):
        return []
    if HAVE_PROC:
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as f:
                raw = f.read()
            return [a for a in raw.decode("utf-8", "replace").split("\x00") if a]
        except (IOError, OSError) as e:
            if e.errno == errno.ENOENT:
                return []
    try:                                                     # POSIX ps: Linux procps, busybox, FreeBSD, macOS
        r = subprocess.run(["ps", "-o", "args=", "-p", str(pid)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
                           encoding="utf-8", errors="replace", timeout=10)
        line = r.stdout.strip()
        if r.returncode == 0 and line:
            return line.split()
        return [] if not exists(pid) else None
    except (OSError, subprocess.SubprocessError):
        return None if exists(pid) else []


def is_postmaster(pid):
    """True when pid is a PostgreSQL server process, False when it is not or does not exist, None when it exists but cannot be told."""
    if not exists(pid):
        return False
    cmd = cmdline(pid)
    if cmd is None:
        return None
    if not cmd:
        return False
    first = os.path.basename(cmd[0].split()[0]) if cmd[0].split() else ""
    return first in POSTMASTER_NAMES or any(first == n + ":" for n in POSTMASTER_NAMES) or "postgres" in " ".join(cmd[:2])


def cwd(pid):
    """Working directory of a process, None when it cannot be told (no /proc, another user's process)."""
    if HAVE_PROC:
        try:
            return os.readlink("/proc/%d/cwd" % int(pid))
        except (OSError, ValueError):
            return None
    return None
