"""PGDATA walking (incl. tablespaces), file classification and page helpers."""

import os
import re
import stat
import struct

from pg_arca.engine.util import BLCKSZ

ZEROPAGE = b"\x00" * BLCKSZ

# directories whose CONTENT is never backed up (the directory itself is recreated on restore)
EXCLUDE_CONTENT = {"pg_wal", "pg_xlog", "pg_replslot", "pg_dynshmem", "pg_notify", "pg_serial", "pg_snapshots", "pg_stat_tmp",
                   "pg_subtrans", "pg_logical/snapshots", "pg_logical/mappings", "log"}
EXCLUDE_FILES = {"postmaster.pid", "postmaster.opts", "backup_label", "backup_label.old", "tablespace_map", "tablespace_map.old",
                 "recovery.signal", "standby.signal", "current_logfiles", "pg_internal.init", "recovery.conf", "recovery.done"}
RE_MAIN_FORK = re.compile(r"^(?:base/\d+|global|pg_tblspc/\d+/[^/]+/\d+)/(\d+)(?:\.(\d+))?$")
RE_ANY_FORK = re.compile(r"^(?:base/\d+|global|pg_tblspc/\d+/[^/]+/\d+)/(\d+)(?:_(fsm|vm|init))?(?:\.(\d+))?$")


def page_lsn(page):
    if len(page) < 8:
        return 0
    hi, lo = struct.unpack_from("<II", page, 0)
    return (hi << 32) | lo


def is_main_fork(rel):
    """Relation main fork => eligible for page-level incrementals (FSM/VM are not reliably LSN-stamped)."""
    return RE_MAIN_FORK.match(rel) is not None


def _is_excluded_dir(rel):
    return rel in EXCLUDE_CONTENT or rel.startswith("pgsql_tmp") or "/pgsql_tmp" in rel


def tablespace_links(pgdata):
    """{oid: absolute target} from pg_tblspc symlinks."""
    out = {}
    d = os.path.join(pgdata, "pg_tblspc")
    if not os.path.isdir(d):
        return out
    for e in sorted(os.listdir(d)):
        p = os.path.join(d, e)
        if os.path.islink(p):
            out[e] = os.path.realpath(p)
    return out


def _walk_tree(root, rel_prefix, exclude_top=True):
    for cur, dirs, files in os.walk(root, topdown=True, followlinks=False):
        rel_root = os.path.relpath(cur, root)
        rel_root = "" if rel_root == "." else rel_root
        keep = []
        for d in dirs:
            rp = (rel_root + "/" + d) if rel_root else d
            if exclude_top and _is_excluded_dir(rp):
                continue
            if os.path.islink(os.path.join(cur, d)) and not rel_prefix:
                continue                                           # pg_tblspc/<oid> symlinks are handled separately
            keep.append(d)
        dirs[:] = keep
        # unlogged relations: if <fn>_init exists the main/fsm/vm forks are skipped (PostgreSQL does the same in basebackup)
        inits = set()
        for f in files:
            m = re.match(r"^(\d+)_init$", f)
            if m:
                inits.add(m.group(1))
        for f in files:
            if f in EXCLUDE_FILES or f.startswith("pgsql_tmp") or f.endswith(".tmp"):
                continue
            if inits:
                m = re.match(r"^(\d+)(?:_(?:fsm|vm))?(?:\.\d+)?$", f)
                if m and m.group(1) in inits:
                    continue
            full = os.path.join(cur, f)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            rp = (rel_root + "/" + f) if rel_root else f
            yield (rel_prefix + rp), full, st


def list_directories(pgdata):
    """Empty directories that must exist after restore (pg_wal/archive_status, pg_notify, ...)."""
    return ["pg_wal", "pg_wal/archive_status", "pg_notify", "pg_serial", "pg_snapshots", "pg_stat", "pg_stat_tmp", "pg_subtrans",
            "pg_replslot", "pg_dynshmem", "pg_logical", "pg_logical/snapshots", "pg_logical/mappings", "pg_commit_ts", "pg_twophase",
            "pg_tblspc", "pg_multixact", "pg_multixact/members", "pg_multixact/offsets", "pg_xact"]


def walk_pgdata(pgdata):
    """Yields (relpath, fullpath, stat). Tablespace content appears as pg_tblspc/<oid>/<version dir>/..."""
    for item in _walk_tree(pgdata, ""):
        yield item
    for oid, target in tablespace_links(pgdata).items():
        if os.path.isdir(target):
            for item in _walk_tree(target, "pg_tblspc/%s/" % oid, exclude_top=False):
                yield item
