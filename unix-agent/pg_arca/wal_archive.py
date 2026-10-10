"""
Minimal entry point for archive_command / restore_command (fast startup, no agent import chain).
   archive_command = 'python3 -m pg_arca.wal_archive archive %p %f'
   restore_command = 'python3 -m pg_arca.wal_archive get %f %p'
Reads WAL_ARCHIVE_DIR / PG_ARCA_COMPRESSION from the environment or /etc/pg-arca/agent.conf.
"""
import json
import os
import sys


def _settings():
    d, comp, lvl, seg = os.environ.get("WAL_ARCHIVE_DIR"), os.environ.get("PG_ARCA_COMPRESSION"), 3, 16 * 1024 * 1024
    try:
        with open(os.environ.get("PG_ARCA_CONF", "/etc/pg-arca/agent.conf"), "r", encoding="utf-8") as f:
            c = json.load(f)
        d = d or c.get("wal_archive_dir")
        comp = comp or c.get("compression")
        lvl = c.get("compression_level", 3)
        seg = c.get("wal_segment_size", seg)
    except Exception:
        pass
    return d or "/var/lib/pgarca/wal", comp or "zstd", lvl, seg


def main(argv):
    from pg_arca.wal_manager import WalManager, WalArchiveError
    if len(argv) != 4 or argv[1] not in ("archive", "get"):
        sys.stderr.write("usage: wal_archive archive <%p> <%f> | get <%f> <%p>\n")
        return 2
    d, comp, lvl, seg = _settings()
    crypto = None
    kf = os.environ.get("PG_ARCA_KEY_FILE")
    if not kf:
        try:
            with open(os.environ.get("PG_ARCA_CONF", "/etc/pg-arca/agent.conf"), "r", encoding="utf-8") as f:
                kf = json.load(f).get("encryption_key_file")
        except Exception:
            kf = None
    if kf:
        try:
            from pg_arca.engine.crypt import from_settings
            crypto = from_settings(kf)
        except Exception as e:
            sys.stderr.write("pg_arca %s FAILED: %s\n" % (argv[1], e))
            return 1 if argv[1] == "archive" else 126        # for restore_command 1 means "end of archive": a key error must ABORT recovery, not end it early
    wm = WalManager(d, comp, lvl, seg, crypto=crypto)
    if argv[1] == "archive":
        try:
            ok, dest, sha, msg = wm.archive_segment(argv[2], argv[3])
        except WalArchiveError as e:
            sys.stderr.write("pg_arca archive FAILED: %s\n" % e)
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
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
