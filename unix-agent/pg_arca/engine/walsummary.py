"""Incremental backups that read only what changed, with PostgreSQL 17+ WAL summaries.

Without this, an incremental backup reads EVERY relation file of the cluster and keeps the 64 KiB chunks holding a page whose LSN is newer
than the parent backup: correct, but a 500 GB cluster with 1 % daily churn is still 500 GB of reads per incremental. PostgreSQL 17 can keep
WAL summaries (`summarize_wal = on`): per checkpoint cycle, the set of (relation, fork, block) a WAL record touched — exactly what
`pg_basebackup --incremental` uses. With a summary chain covering [parent start LSN, this backup's start LSN]:
  - a relation file no summary mentions, with the same size as in the parent backup, is not read at all (manifest entry with no chunks);
  - a mentioned file is read only at the chunks holding a changed block; the page-LSN test still applies inside them;
  - a truncated relation (is_limit_block), a new file, a file whose size changed, and every non-relation or non-main-fork file are read as before.
Safety: the summaries must cover the range contiguously, else everything is scanned as before (PGA-INC-01x in the log); a sample of the files
the summaries would skip is scanned in full first, and any changed chunk found there disables the summaries for this backup.
"""

import os
import random
import re
import time

from pg_arca.engine.util import CHUNK_SIZE, EngineError, lsn_to_int

ALL = "ALL"                                   # every chunk of the file must be examined
WAIT_SUMMARIZER_SEC = 90                      # the summarizer finishes the cycle ending at the backup's checkpoint shortly after it
RE_TBLSPC = re.compile(r"^pg_tblspc/(\d+)/([^/]+)/")
FORK_SUFFIX = {0: "", 1: "_fsm", 2: "_vm", 3: "_init"}


def enabled():
    return os.environ.get("PG_ARCA_WAL_SUMMARIES", "1") not in ("0", "off", "no")


def available(sess, log=None):
    """(True, "") when this server can give summaries for this backup; (False, why) otherwise."""
    if not enabled():
        return False, "disabled (PG_ARCA_WAL_SUMMARIES=0)"
    if sess.version_num < 170000:
        return False, "PostgreSQL %s has no WAL summaries (17+)" % sess.version
    try:
        if sess.scalar("SHOW summarize_wal") != "on":
            return False, "summarize_wal is off: set summarize_wal = on (reload) so that incrementals read only changed files"
    except EngineError as e:
        return False, "summarize_wal unreadable (%s)" % e
    return True, ""


def _covering_chain(rows, lo, hi):
    """rows: [(start, end)] of one timeline; a contiguous run start <= lo < end ... end >= hi, or None."""
    rows = sorted(set(rows))
    for i, (s, e) in enumerate(rows):
        if not (s <= lo < e or (s <= lo and lo == hi)):
            continue
        chain = [(s, e)]
        for s2, e2 in rows[i + 1:]:
            if chain[-1][1] >= hi:
                break
            if s2 == chain[-1][1]:
                chain.append((s2, e2))
            elif s2 > chain[-1][1]:
                break                                          # a hole: a summary file expired or is missing
        if chain[-1][1] >= hi:
            return chain
    return None


def summaries_for(sess, tli, prev_lsn, start_lsn, wait=WAIT_SUMMARIZER_SEC, cancel=None, log=None):
    """The summary ranges [(start, end)] covering [prev_lsn, start_lsn] on timeline `tli`, waiting for the summarizer to reach start_lsn.
    None (with the reason logged) when the range cannot be covered."""
    lo, hi = lsn_to_int(prev_lsn), lsn_to_int(start_lsn)
    t0 = time.time()
    last_top = -1
    while True:
        rows = []
        for r in sess.query("SELECT start_lsn, end_lsn FROM pg_available_wal_summaries() WHERE tli = %d" % int(tli)):
            rows.append((lsn_to_int(r[0]), lsn_to_int(r[1])))
        chain = _covering_chain(rows, lo, hi)
        if chain:
            return chain
        top = max((e for _, e in rows), default=0)
        if top < hi and time.time() - t0 < wait:              # the summarizer has not reached our start LSN yet: it will, after the backup checkpoint
            if cancel and cancel():
                return None
            if log and top != last_top:
                log("info", "waiting for WAL summarization to reach %s (at %X/%08X)" % (start_lsn, top >> 32, top & 0xFFFFFFFF))
                last_top = top
            time.sleep(1)
            continue
        if log:
            if top < hi:
                log("warn", "PGA-INC-011: WAL summarization did not reach %s within %ds: this incremental scans every page" % (start_lsn, wait))
            else:
                log("warn", "PGA-INC-012: WAL summaries do not cover %s..%s contiguously (expired by wal_summary_keep_time?): this incremental scans every page" % (prev_lsn, start_lsn))
        return None


def changed_chunks(sess, tli, chain, files, seg_blocks, default_spc_oid=1663, global_spc_oid=1664):
    """{relation file path -> set(chunk index) | ALL} from the summary chain. `files` = relative paths of the data directory walk (gives the
    pg_tblspc/<oid>/<version dir> prefixes). Chunk index = (block within the 1 GB segment) // 8."""
    spc_dirs = {}
    for rel in files:
        m = RE_TBLSPC.match(rel)
        if m:
            spc_dirs.setdefault(m.group(1), set()).add(m.group(2))
    # a tablespace directory can hold more than one version directory (PG_15_… left behind by pg_upgrade next to PG_16_…): the server's own is
    # the one named after its major version; when that cannot be told, every file of that tablespace is scanned in full (never skipped by mistake)
    try:
        major = int(sess.scalar("SELECT current_setting('server_version_num')")) // 10000
    except Exception:
        major = None
    spc_prefix, spc_unsure = {}, set()
    for oid, dirs in spc_dirs.items():
        mine = [d for d in dirs if major and d.startswith("PG_%d_" % major)] if len(dirs) > 1 else list(dirs)
        if len(mine) == 1:
            spc_prefix[oid] = "pg_tblspc/%s/%s" % (oid, mine[0])
        else:
            spc_unsure.add(oid)
    out = {}
    for oid in spc_unsure:
        for rel in files:
            if rel.startswith("pg_tblspc/%s/" % oid):
                out[rel] = ALL
    pages_per_chunk = CHUNK_SIZE // 8192
    limited = set()
    for s, e in chain:
        sql = ("SELECT relfilenode, reltablespace, reldatabase, relforknumber, relblocknumber, is_limit_block "
               "FROM pg_wal_summary_contents(%d, '%X/%08X', '%X/%08X')" % (int(tli), s >> 32, s & 0xFFFFFFFF, e >> 32, e & 0xFFFFFFFF))
        for r in sess.query(sql):
            relfilenode, spc, db, fork, block, limit = int(r[0]), int(r[1]), int(r[2]), int(r[3]), int(r[4]), r[5] in ("t", "true", "1", True)
            if fork != 0:
                continue                                       # FSM/VM/init forks are not page-level files: always read whole
            if spc == global_spc_oid or db == 0:
                base = "global/%d" % relfilenode
            elif spc == default_spc_oid or spc == 0:
                base = "base/%d/%d" % (db, relfilenode)
            else:
                p = spc_prefix.get(str(spc))
                if not p:
                    continue                                   # dropped tablespace (not in the walk any more), or one marked ALL above
                base = "%s/%d/%d" % (p, db, relfilenode)
            if limit:                                          # truncated: every segment of the relation is examined in full
                out[base] = ALL
                limited.add(base)
                for k in list(out):
                    if k.startswith(base + "."):
                        out[k] = ALL
                continue
            seg = block // seg_blocks
            path = base if seg == 0 else "%s.%d" % (base, seg)
            cur = out.get(path)
            if cur is ALL:
                continue
            if base in limited:
                # a segment of a truncated relation met AFTER its limit block: in full too (it used to be left out, then skipped as unchanged
                # when its size matched the parent's - independent engine review)
                out[path] = ALL
                continue
            if cur is None:
                cur = out[path] = set()
            cur.add((block % seg_blocks) // pages_per_chunk)
    return out


def plan_files(files, changes, parent_files):
    """Split the relation files (paged) into: skip (not read at all), partial {rel: chunk set}, full (scanned as before).
    files: [(rel, full path, stat)] of main-fork relation files."""
    skip, partial, full = [], {}, []
    for rel, path, st in files:
        c = changes.get(rel)
        if c is ALL:
            full.append(rel)
        elif c:
            pe = parent_files.get(rel)
            if pe is not None and int(pe.get("size", -1)) == st.st_size:
                partial[rel] = c
            else:
                full.append(rel)                               # new or resized: the summary does not tell what else is new
        else:
            pe = parent_files.get(rel)
            if pe is not None and int(pe.get("size", -1)) == st.st_size:
                skip.append(rel)
            else:
                full.append(rel)
    return skip, partial, full


def contradiction(path, prev_lsn, start_lsn):
    """First page of `path` whose LSN lies in [prev_lsn, start_lsn): a change inside the summarized range the summaries did not report.
    Pages newer than start_lsn are writes made after this backup started (covered by WAL replay) and say nothing about the summaries.
    Returns the page number or None (also None when the file vanished)."""
    from pg_arca.engine.pgdata import ZEROPAGE, page_lsn
    try:
        with open(path, "rb") as f:
            n = 0
            while True:
                buf = f.read(4 * 1048576)
                if not buf:
                    return None
                for j in range(0, len(buf), 8192):
                    pg = buf[j:j + 8192]
                    if len(pg) == 8192 and pg != ZEROPAGE:
                        l = page_lsn(pg)
                        if prev_lsn <= l < start_lsn:
                            return n
                    n += 1
    except (IOError, OSError):
        return None


def sample(skip, k=None, sizes=None, budget=None):
    """Files to scan in full as a check of the summaries: 1 % of the skipped ones, between 3 and 50 - and, when sizes are known, no more bytes
    than `budget` (default: 1 % of their total, at least 256 MiB): the check must stay a small fraction of what the summaries save."""
    if not skip:
        return []
    k = k if k is not None else max(3, min(50, len(skip) // 100))
    k = min(k, len(skip))
    picked = random.sample(skip, k)
    if sizes:
        total = sum(sizes.get(r, 0) for r in skip)
        budget = budget if budget is not None else max(256 * 1048576, total // 100)
        out, used = [], 0
        for r in sorted(picked, key=lambda r: sizes.get(r, 0)):      # small files first: more files checked for the same bytes
            if out and used + sizes.get(r, 0) > budget:
                break
            out.append(r)
            used += sizes.get(r, 0)
        return out
    return picked
