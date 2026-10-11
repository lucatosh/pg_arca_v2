"""
Minimal entry point for archive_command / restore_command (fast startup, no agent import chain).
   archive_command = 'python3 -m pg_arca.wal_archive archive %p %f'
   restore_command = 'python3 -m pg_arca.wal_archive get %f %p'
Reads WAL_ARCHIVE_DIR / PG_ARCA_COMPRESSION from the environment or /etc/pg-arca/agent.conf.
"""
import json
import os
import sys


def _conf():
    """The agent's effective settings as the archiver sees them: agent.conf, then the console-managed agent.local.json next to it (same precedence as the agent itself:
    file < overrides < environment). Without the second step a WAL directory changed from the console would be used by the agent but NOT by archive_command."""
    path = os.environ.get("PG_ARCA_CONF", "/etc/pg-arca/agent.conf")
    c = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            c = json.load(f)
    except Exception:
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


def main(argv):
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
    d, comp, lvl, seg = _settings()
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
    wm = WalManager(d, comp, lvl, seg, crypto=crypto)
    if argv[1] == "prefetch":                                # detached read-ahead worker: pg-arca-wal prefetch <spool> <segments ahead>
        from pg_arca import walprefetch
        walprefetch.run(wm, argv[2], argv[3])
        return 0
    if argv[1] == "archive":
        try:
            ok, dest, sha, msg = wm.archive_segment(argv[2], argv[3])
        except WalArchiveError as e:
            sys.stderr.write("pg_arca archive FAILED: %s\n" % e)
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
            return 1
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
