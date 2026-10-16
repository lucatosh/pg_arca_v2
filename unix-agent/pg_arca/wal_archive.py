"""
Minimal entry point for archive_command / restore_command (fast startup, no agent import chain).
   archive_command = 'python3 -m pg_arca.wal_archive archive %p %f'
   restore_command = 'python3 -m pg_arca.wal_archive get %f %p'
Reads WAL_ARCHIVE_DIR / PG_ARCA_COMPRESSION from the environment or /etc/pg-arca/agent.conf.
"""
import json
import os
import sys


class ConfError(Exception):
    pass


def _conf():
    """The agent's effective settings as the archiver sees them: agent.conf, then the console-managed agent.local.json next to it (same precedence as the agent itself:
    file < overrides < environment). Without the second step a WAL directory changed from the console would be used by the agent but NOT by archive_command."""
    path = os.environ.get("PG_ARCA_CONF", "/etc/pg-arca/agent.conf")
    c = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            c = json.load(f)
    except Exception as e:
        if os.environ.get("PG_ARCA_CONF") and not os.environ.get("WAL_ARCHIVE_DIR"):
            # an instance agent's configuration named explicitly (archive_command = env PG_ARCA_CONF=/etc/pg-arca/<inst>/agent.conf ...) is gone or
            # unreadable: the defaults would put this cluster's WAL into ANOTHER cluster's archive (independent review). Fail: PostgreSQL retries.
            raise ConfError("cannot read %s (%s)" % (path, e))
        c = {}
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(path)), "agent.local.json"), "r", encoding="utf-8") as f:
            ov = json.load(f)
        from pg_arca.overrides import KINDS
        c.update({k: v for k, v in ov.items() if k in KINDS and v not in (None, "")})
    except Exception:
        pass
    return c


def _settings():
    c = _conf()
    d = os.environ.get("WAL_ARCHIVE_DIR") or c.get("wal_archive_dir")
    comp = os.environ.get("PG_ARCA_COMPRESSION") or c.get("compression")
    return d or "/var/lib/pgarca/wal", comp or "zstd", c.get("compression_level", 3), c.get("wal_segment_size", 16 * 1024 * 1024)


def _previous():
    """Earlier WAL archive locations (destination changed, content not migrated yet): restore_command reads there too."""
    if os.environ.get("PG_ARCA_WAL_PREVIOUS"):
        return [x for x in os.environ["PG_ARCA_WAL_PREVIOUS"].split(os.pathsep) if x.startswith("/")]
    v = _conf().get("wal_previous") or []
    return [x for x in v if isinstance(x, str) and x.startswith("/")] if isinstance(v, list) else []


LAST_ERROR = ".last_archive_error.json"


def _last_error(wal_dir, name, message):
    """Why archiving fails, where the agent can read it (PostgreSQL only counts failures): written on failure, removed on the next success. Best effort:
    on a full or read-only volume it cannot be written, and the agent then falls back to pg_stat_archiver alone."""
    p = os.path.join(wal_dir, LAST_ERROR)
    try:
        if message is None:
            if os.path.exists(p):
                os.unlink(p)
            return
        import time
        tmp = "%s.%d" % (p, os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"segment": name, "error": message[:600], "at": time.time()}, f)
        os.rename(tmp, p)
    except Exception:
        pass


def probe(directory, token):
    """Run BY POSTGRESQL (COPY ... TO PROGRAM, same user and environment as archive_command): can the server's OS user read what the agent wrote in
    `directory` and write there the way the archive does? Writes .pgarca-srvprobe-<token> (JSON: identity + results) for the agent to read back."""
    import json
    import pwd
    import grp
    try:
        sys.stdin.read()                                # COPY writes its rows to our stdin: drain it, or COPY may fail with a broken pipe
    except Exception:
        pass
    if not token.isalnum() or len(token) > 40:
        sys.stderr.write("probe: bad token\n")
        return 2
    res = {"uid": os.getuid(), "gid": os.getgid(), "groups": sorted(set(os.getgroups())), "umask": None}
    try:
        res["user"] = pwd.getpwuid(os.getuid()).pw_name
    except KeyError:
        res["user"] = str(os.getuid())
    try:
        res["group"] = grp.getgrgid(os.getgid()).gr_name
        res["group_names"] = sorted(set(grp.getgrgid(g).gr_name for g in res["groups"] if g is not None))
    except KeyError:
        res["group"] = str(os.getgid())
    um = os.umask(0)
    os.umask(um)
    res["umask"] = "%04o" % um
    try:
        with open(os.path.join(directory, ".pgarca-agentprobe-" + token), "rb") as f:
            res["read_agent_file"] = f.read().startswith(b"pg_arca agent probe")
    except OSError as e:
        res["read_agent_file"] = False
        res["read_error"] = str(e)
    tmp = os.path.join(directory, ".pgarca-srvprobe-%s.tmp" % token)
    fin = os.path.join(directory, ".pgarca-srvprobe-%s" % token)
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
        try:
            os.write(fd, json.dumps(res).encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(tmp, fin)
    except OSError as e:
        sys.stderr.write("pg_arca probe: the PostgreSQL server user %s cannot write in %s: %s\n" % (res.get("user"), directory, e))
        return 1
    return 0


def main(argv):
    if len(argv) == 4 and argv[1] == "probe":
        return probe(argv[2], argv[3])
    if len(argv) != 4 or argv[1] not in ("archive", "get", "prefetch"):
        sys.stderr.write("usage: wal_archive archive <%p> <%f> | get <%f> <%p>\n")
        return 2
    spool = os.environ.get("PG_ARCA_SPOOL") if argv[1] == "get" else None
    if spool:                                                # read-ahead (pg_arca/walprefetch.py): a segment already prepared is served without importing anything else
        from pg_arca import walprefetch
        if walprefetch.take(spool, argv[2], argv[3]):
            walprefetch.kick(spool, argv[2])
            return 0
    from pg_arca.wal_manager import WalManager, WalArchiveError
    try:
        d, comp, lvl, seg = _settings()
    except ConfError as e:
        sys.stderr.write("pg_arca %s FAILED: %s\n" % (argv[1], e))
        return 1 if argv[1] == "archive" else 126
    crypto = None
    kf = os.environ.get("PG_ARCA_KEY_FILE")
    if not kf:
        kf = _conf().get("encryption_key_file") or None
    if kf:
        try:
            from pg_arca.engine.crypt import from_settings
            crypto = from_settings(kf)
        except Exception as e:
            sys.stderr.write("pg_arca %s FAILED: %s\n" % (argv[1], e))
            return 1 if argv[1] == "archive" else 126        # for restore_command 1 means "end of archive": a key error must ABORT recovery, not end it early
    wm = WalManager(d, comp, lvl, seg, crypto=crypto, previous=_previous() if argv[1] in ("get", "prefetch") else None)
    if argv[1] == "prefetch":                                # detached read-ahead worker: pg-arca-wal prefetch <spool> <segments ahead>
        from pg_arca import walprefetch
        walprefetch.run(wm, argv[2], argv[3])
        return 0
    if argv[1] == "archive":
        c = _conf()
        if c.get("wal_archive_async") and not os.environ.get("PG_ARCA_WAL_SYNC"):
            from pg_arca import wal_spool
            sp = wal_spool.spool_dir(c.get("state_dir"))
            if wal_spool.accept(sp, argv[2], argv[3]):     # parked locally, the agent pushes it; otherwise (pusher dead, spool full) synchronous as below
                return 0
        try:
            ok, dest, sha, msg = wm.archive_segment(argv[2], argv[3])
        except WalArchiveError as e:
            sys.stderr.write("pg_arca archive FAILED: %s\n" % e)
            _last_error(d, argv[3], str(e))
            return 1
        except OSError as e:
            import errno
            if e.errno in (errno.ENOSPC, getattr(errno, "EDQUOT", -1)):
                sys.stderr.write("pg_arca archive FAILED: PGA-WAL-098 the WAL archive volume is full (%s): free space or enlarge it; PostgreSQL keeps the WAL in pg_wal until archiving works again, so its own disk fills up too\n" % d)
            elif e.errno == errno.EROFS:
                sys.stderr.write("pg_arca archive FAILED: PGA-WAL-097 the WAL archive volume is mounted read-only (%s)\n" % d)
            else:
                sys.stderr.write("pg_arca archive FAILED: PGA-WAL-099 %s\n" % e)
            return 1
        except Exception as e:
            sys.stderr.write("pg_arca archive FAILED: PGA-WAL-099 %s\n" % e)
            _last_error(d, argv[3], "PGA-WAL-099 %s" % e)
            return 1
        _last_error(d, None, None)
        return 0
    try:
        code, msg = wm.retrieve_segment(argv[2], argv[3])
    except Exception as e:                                # EIO/EACCES/ENOSPC/...: never answer "not found" (1) for an error
        sys.stderr.write("pg_arca restore FAILED: PGA-WAL-098 %s\n" % e)
        return 126
    if code not in (0, 1):
        sys.stderr.write("pg_arca restore FAILED: %s\n" % msg)
    if code == 0 and spool:
        from pg_arca import walprefetch
        walprefetch.kick(spool, argv[2])
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
