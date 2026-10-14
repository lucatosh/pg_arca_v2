"""Old primary site back after a failover: it may carry the SAME TIMELINE NUMBER as the new primary with a DIFFERENT history.

How it happens (seen on the lab): the old site's Patroni restarts PostgreSQL and promotes it before pg_arca can turn the site into a replica; with no
access to the new primary's history file it picks the next free number - the very number the new primary took at the failover. Patroni compares only
timeline numbers ("same timeline: no rewind needed"), so the old site then streams from the new primary from ITS OWN position: everything the new
primary wrote between the failover and that position never reaches it - a replica with a hole in its data that looks healthy.

Detected from the timeline history files (each lists the ancestors and the exact switch points), fixed with pg_rewind under Patroni maintenance mode
(pg_rewind compares the histories entry by entry, so it finds the real divergence point). Nothing here changes Patroni parameters: only the pause flag
and standby_cluster go through the DCS, the rest is the server's own data directory."""
import os
import re
import subprocess
import tempfile

from pg_arca.engine.util import EngineError

_LINE = re.compile(r"^\s*(\d+)\s+([0-9A-Fa-f]+/[0-9A-Fa-f]+)")


def lsn_int(s):
    hi, lo = str(s).split("/")
    return (int(hi, 16) << 32) + int(lo, 16)


def parse_history(text):
    """[(parent timeline, switch point)] of a timeline history file, in order."""
    out = []
    for ln in (text or "").splitlines():
        m = _LINE.match(ln)
        if m:
            out.append((int(m.group(1)), lsn_int(m.group(2))))
    return out


def read_history(pgdata, tli):
    if not tli or int(tli) <= 1:
        return ""
    p = os.path.join(pgdata, "pg_wal", "%08X.history" % int(tli))
    try:
        with open(p, "r", errors="replace") as f:
            return f.read()
    except OSError:
        return None                                     # unknown (not readable): never conclude "diverged" from it


def diverged_same_timeline(local, source):
    """True when both sides are on the same timeline NUMBER but did not get there the same way (different ancestors or switch points)."""
    try:
        if int(local.get("timeline") or 0) != int(source.get("timeline") or 0) or int(local.get("timeline") or 0) <= 1:
            return False
    except (TypeError, ValueError):
        return False
    a, b = local.get("history"), source.get("history")
    if a is None or b is None:
        return False
    return parse_history(a) != parse_history(b)


def patroni_auth(config_path):
    """(user, password) pg_rewind connects with: Patroni's rewind role, else its superuser (read from the DBA's patroni.yml, never written)."""
    from pg_arca.discovery import parse_simple_yaml
    try:
        with open(config_path, "r", errors="replace") as f:
            cfg = parse_simple_yaml(f.read())
    except (OSError, TypeError):
        raise EngineError("PGA-GEO-020", "cannot read the Patroni configuration %s (needed for pg_rewind's credentials)" % config_path,
                          "make it readable by the agent's user, or rebuild the old site's members by hand (patronictl reinit)")
    auth = ((cfg.get("postgresql") or {}).get("authentication") or {})
    for k in ("rewind", "superuser"):
        a = auth.get(k) or {}
        if a.get("username"):
            return str(a["username"]), str(a.get("password") or "")
    raise EngineError("PGA-GEO-021", "no rewind / superuser credentials in %s" % config_path)


def force_rewind(pgdata, bindir, host, port, user, password, state_dir, progress=None):
    """Stop the local PostgreSQL (the caller paused Patroni) and pg_rewind it from the new primary. Returns the tail of pg_rewind's output."""
    ctl = os.path.join(bindir, "pg_ctl") if bindir else "pg_ctl"
    rew = os.path.join(bindir, "pg_rewind") if bindir else "pg_rewind"
    if progress:
        progress({"phase": "geo-rewind", "msg": "stopping PostgreSQL of the old primary (Patroni paused)"})
    r = subprocess.run([ctl, "stop", "-D", pgdata, "-m", "fast", "-w", "-t", "300"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, timeout=360)
    if r.returncode != 0 and os.path.exists(os.path.join(pgdata, "postmaster.pid")) and "not running" not in (r.stdout or ""):
        raise EngineError("PGA-GEO-022", "pg_ctl stop failed: %s" % (r.stdout or "")[-300:])
    fd, passfile = tempfile.mkstemp(prefix=".pgpass-rewind-", dir=state_dir if state_dir and os.path.isdir(state_dir) else None)
    try:
        with os.fdopen(fd, "w") as f:
            f.write("%s:%s:*:%s:%s\n" % (host.replace(":", "\\:"), port, user.replace(":", "\\:"), password.replace("\\", "\\\\").replace(":", "\\:")))
        os.chmod(passfile, 0o600)
        if progress:
            progress({"phase": "geo-rewind", "msg": "pg_rewind from the new primary (%s:%s): only what differs since the divergence is copied" % (host, port)})
        env = dict(os.environ, PGPASSFILE=passfile, PGCONNECT_TIMEOUT="15")
        src = "host=%s port=%s user=%s dbname=postgres" % (host, port, user)
        r = subprocess.run([rew, "--target-pgdata=%s" % pgdata, "--source-server=%s" % src, "--progress"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           universal_newlines=True, timeout=6 * 3600, env=env, cwd="/")
    finally:
        try:
            os.unlink(passfile)
        except OSError:
            pass
    out = (r.stdout or "").strip()
    if r.returncode != 0:
        raise EngineError("PGA-GEO-023", "pg_rewind failed (exit %d): %s" % (r.returncode, out[-600:]),
                          "the old site's members must be rebuilt from the new primary (patronictl reinit, or remove the data directory and let Patroni clone it)")
    return out.splitlines()[-3:]
