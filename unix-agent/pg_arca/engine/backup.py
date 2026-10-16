"""Backup: physical, page-aware, deduplicated, parallel; full / differential / incremental (page-LSN)."""

import json
import re
import base64
import errno
import os
import socket
import stat
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from pg_arca.engine import ENGINE_VERSION
from pg_arca.engine.catalog import snapshot_catalog
from pg_arca.engine.pgdata import ZEROPAGE, is_main_fork, page_lsn, skipped_links, tablespace_links, walk_pgdata
from pg_arca.pgcompat import check_tools, require_supported
from pg_arca.engine.pgsession import PgSession
from pg_arca.engine.util import (BLCKSZ, CHUNK_SIZE, Cancelled, EngineError, human, iso, lsn_to_int, now_utc, read_json, sql_lit,
                                 wal_name, wal_segno, last_wal_segno, write_file_atomic, write_json)

READ_BLOCK = 4 * 1024 * 1024
TYPE_LETTER = {"full": "F", "diff": "D", "incr": "I"}


class ReadLimiter(object):
    """Ceiling on the bytes read from the data directory per second, shared by every worker thread (a token bucket: at most one second of
    credit, so a pause never turns into a burst). rate <= 0 = unlimited."""

    def __init__(self, mb_s):
        self.rate = float(mb_s or 0) * 1048576
        self.lock = threading.Lock()
        self.allowance = self.rate
        self.last = time.time()
        self.total = 0

    def take(self, nbytes):
        self.total += nbytes
        if self.rate <= 0:
            return
        while True:
            with self.lock:
                now = time.time()
                self.allowance = min(self.rate, self.allowance + (now - self.last) * self.rate)
                self.last = now
                if self.allowance >= nbytes or self.allowance >= self.rate:
                    self.allowance -= nbytes
                    return
                wait = (nbytes - self.allowance) / self.rate
            time.sleep(min(wait, 1.0))


_NO_LIMIT = ReadLimiter(0)


def build_chain(repo, target):
    """full -> ... -> target, validated (no cycles, no missing parent, only COMPLETE parents)."""
    chain, seen, cur = [], set(), target
    while cur:
        if cur["id"] in seen:
            raise EngineError("PGA-VRF-020", "cycle in backup chain at %s" % cur["id"])
        seen.add(cur["id"])
        chain.insert(0, cur)
        if not cur.get("parent"):
            break
        p = repo.set_meta(cur["parent"])
        if p is None or p.get("status") != "COMPLETE":
            raise EngineError("PGA-VRF-021", "broken chain: parent '%s' of '%s' is missing or not complete" % (cur["parent"], cur["id"]),
                              "this set is not restorable; take a new full backup")
        cur = p
    if chain[0]["type"] != "full":
        raise EngineError("PGA-VRF-022", "chain does not start with a full backup")
    return chain


def _check_cancel(cancel):
    if cancel and cancel():
        raise Cancelled()


def _empty_stats():
    return {"bytes_logical": 0, "bytes_written": 0, "chunks_new": 0, "chunks_dedup": 0, "pages_read": 0, "pages_kept": 0, "skipped": 0, "bytes_not_read": 0}


def unread_entry(st):
    """Manifest entry of a relation file the WAL summaries prove unchanged since the parent backup: same size, no chunk, nothing read."""
    stats = _empty_stats()
    stats["bytes_logical"] = stats["bytes_not_read"] = st.st_size
    return {"size": st.st_size, "mode": stat.S_IMODE(st.st_mode), "mtime": int(st.st_mtime), "kind": "pages", "chunks": []}, stats


def backup_file_sparse(repo, rel, full, st, prev_lsn, chunk_idx, fadvise=True, limiter=_NO_LIMIT):
    """Store only the chunks of a relation file the WAL summaries flag (chunk_idx: set of chunk indexes); the page-LSN test still applies."""
    stats = _empty_stats()
    try:
        fd = os.open(full, os.O_RDONLY)
    except OSError as e:
        if e.errno == errno.ENOENT:
            stats["skipped"] = 1
            return None, stats
        if e.errno == errno.EACCES:
            raise EngineError("PGA-GEN-043", "cannot read %s: permission denied" % full, "the agent user must be able to read the whole data directory (owner postgres, or ACL)")
        raise
    chunks = []
    try:
        size = os.fstat(fd).st_size
        with os.fdopen(fd, "rb", closefd=False) as f:
            for ci in sorted(chunk_idx):
                off = ci * CHUNK_SIZE
                if off >= size:
                    continue
                f.seek(off)
                buf = f.read(CHUNK_SIZE)
                if not buf:
                    continue
                limiter.take(len(buf))
                npages = (len(buf) + BLCKSZ - 1) // BLCKSZ
                stats["pages_read"] += npages
                keep = len(buf) % BLCKSZ != 0
                if not keep:
                    for j in range(0, len(buf), BLCKSZ):
                        pg = buf[j:j + BLCKSZ]
                        if pg != ZEROPAGE and page_lsn(pg) >= prev_lsn:
                            keep = True
                            break
                if keep:
                    stats["pages_kept"] += npages
                    h, w, dedup = repo.put_chunk(buf)
                    chunks.append([off, len(buf), h])
                    stats["bytes_written"] += w
                    stats["chunks_dedup" if dedup else "chunks_new"] += 1
            if fadvise:
                try:
                    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
                except (AttributeError, OSError):
                    pass
    finally:
        os.close(fd)
    stats["bytes_logical"] = size
    stats["bytes_not_read"] = max(0, size - stats["pages_read"] * BLCKSZ)
    return {"size": size, "mode": stat.S_IMODE(st.st_mode), "mtime": int(st.st_mtime), "kind": "pages", "chunks": chunks}, stats


def backup_file(repo, rel, full, st, prev_lsn, incremental, fadvise=True, limiter=_NO_LIMIT):
    """Store one file. Returns (entry or None, stats dict)."""
    stats = _empty_stats()
    try:
        fd = os.open(full, os.O_RDONLY)
    except OSError as e:
        if e.errno == errno.ENOENT:                       # dropped while we were copying: fine
            stats["skipped"] = 1
            return None, stats
        if e.errno == errno.EACCES:                       # a file we cannot read must NOT silently vanish from a 'COMPLETE' backup
            raise EngineError("PGA-GEN-043", "cannot read %s: permission denied" % full, "the agent user must be able to read the whole data directory (owner postgres, or ACL)")
        raise
    chunks = []
    total = 0
    paged = is_main_fork(rel)
    try:
        with os.fdopen(fd, "rb", closefd=False) as f:
            offset = 0
            while True:
                block = f.read(READ_BLOCK)
                if not block:
                    break
                limiter.take(len(block))
                for i in range(0, len(block), CHUNK_SIZE):
                    buf = block[i:i + CHUNK_SIZE]
                    keep = True
                    if paged:
                        npages = (len(buf) + BLCKSZ - 1) // BLCKSZ
                        stats["pages_read"] += npages
                        if incremental:
                            keep = len(buf) % BLCKSZ != 0           # torn tail: always keep
                            if not keep:
                                for j in range(0, len(buf), BLCKSZ):
                                    pg = buf[j:j + BLCKSZ]
                                    if pg != ZEROPAGE and page_lsn(pg) >= prev_lsn:
                                        keep = True
                                        break
                        if keep:
                            stats["pages_kept"] += npages
                    if keep:
                        h, w, dedup = repo.put_chunk(buf)
                        chunks.append([offset + i, len(buf), h])
                        stats["bytes_written"] += w
                        stats["chunks_dedup" if dedup else "chunks_new"] += 1
                offset += len(block)
                total += len(block)
            if fadvise:
                try:
                    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
                except (AttributeError, OSError):
                    pass
    finally:
        os.close(fd)
    stats["bytes_logical"] = total
    return {"size": total, "mode": stat.S_IMODE(st.st_mode), "mtime": int(st.st_mtime), "kind": "pages" if paged else "whole", "chunks": chunks}, stats


def _start_backup(ctx, sess, start_sql, fast_on, progress, cancel):
    """pg_backup_start() waits for a checkpoint. A spread checkpoint (fast=false) lasts up to checkpoint_timeout * checkpoint_completion_target, i.e. MINUTES on a
    busy server, and the call blocks. It runs in a worker thread so that (a) the operator sees what is going on and (b) a cancel request really stops it: the
    checkpoint wait is interrupted from a second connection with pg_cancel_backend()."""
    pid = sess.scalar("SELECT pg_backend_pid()")
    box = {}

    def work():
        try:
            box["lsn"] = sess.scalar(start_sql)
        except BaseException as e:                       # EngineError, session errors...
            box["err"] = e
    th = threading.Thread(target=work, daemon=True)
    t0 = time.time()
    th.start()
    cancelled = False
    while th.is_alive():
        th.join(1.0)
        if not th.is_alive():
            break
        if progress:
            progress({"phase": "checkpoint", "elapsed_sec": int(time.time() - t0), "fast": fast_on})
        if not cancelled and cancel and cancel():
            cancelled = True
            try:
                killer = PgSession(ctx.conn)
                try:
                    killer.scalar("SELECT pg_cancel_backend(%s)" % int(pid))
                finally:
                    killer.close()
            except Exception:
                pass
    if "err" in box:
        if cancelled:
            raise Cancelled()
        raise box["err"]
    if cancelled:
        raise Cancelled()
    return box.get("lsn")


def _chain_base(repo, s):
    """The full at the root of set s's chain."""
    try:
        return build_chain(repo, s)[0]
    except EngineError:
        return s


def current_timeline(sess, in_recovery, ctx=None, lsn=None):
    """The timeline new WAL is being written on RIGHT NOW. pg_control_checkpoint() lags after a promotion (it only moves when the first checkpoint of the new timeline
    completes), so a backup started just after a failover would be labelled with the OLD timeline: wrong WAL names to wait for and an incremental chained onto a
    parent from another timeline. On a primary the WAL insert position says it exactly; a standby only has the control file."""
    if not in_recovery:
        try:
            return int(sess.scalar("SELECT ('x' || substr(pg_walfile_name(pg_current_wal_insert_lsn()), 1, 8))::bit(32)::int"))
        except EngineError:
            pass
    ctl = int(sess.scalar("SELECT timeline_id FROM pg_control_checkpoint()"))
    if in_recovery and ctx is not None:
        # a standby's control file lags until a restartpoint on the new timeline (independent review: the first standby backup after the
        # upstream's failover was labelled with the old timeline and waited for segment names that never exist): the timeline histories
        # (the standby's pg_wal and the archive) say which timeline the replay position is on
        try:
            if lsn is None:
                v = sess.scalar("SELECT pg_last_wal_replay_lsn()::text")
                lsn = lsn_to_int(v) if v else None
            if lsn is not None:
                return _standby_tli(ctx, ctl, lsn)
        except (EngineError, ValueError):
            pass
    return ctl


def _standby_tli(ctx, ctl_tli, lsn):
    """The newest timeline of this server's lineage (its history lists ctl_tli) that had begun at `lsn`; ctl_tli when there is none."""
    seen = []
    for d in (os.path.join(ctx.pgdata, "pg_wal") if getattr(ctx, "pgdata", None) else None, None):
        try:
            names = os.listdir(d or ctx.wal.wal_dir)
        except (OSError, AttributeError, TypeError):
            continue
        for f in names:
            m = re.match(r"^([0-9A-F]{8})\.history$", f)
            if m and int(m.group(1), 16) > ctl_tli:
                seen.append((int(m.group(1), 16), d))
    for n, d in sorted(seen, key=lambda x: -x[0]):
        forks = ctx.wal._history_forks(n, directory=d) or {}
        if ctl_tli in forks and forks and lsn >= forks[max(forks)]:
            return n
    return ctl_tli


def _stop_time(sess, in_recovery):
    """The set's end on the clock of the commit timestamps a time target is compared with. The agent's clock is used, unless the server says
    a later time: on a standby, the last replayed commit carries the PRIMARY's clock - a standby whose clock is behind would otherwise date
    the end too early and a time target inside that gap could pick this set although it ends after the target (independent review)."""
    t = now_utc()
    try:
        v = sess.scalar("SELECT to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS')" % ("pg_last_xact_replay_timestamp()" if in_recovery else "now()"))
        if v:
            from datetime import datetime, timezone
            srv = datetime.strptime(v, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
            if srv > t:
                t = srv
    except Exception:
        pass
    return iso(t)


def _stop_backup(sess):
    r = sess.query(sess.profile.backup_stop_sql())
    if not r or len(r[0]) < 3:
        raise EngineError("PGA-GEN-042", "pg_backup_stop returned nothing")
    return r[0][0], base64.b64decode(r[0][1]).decode("utf-8"), (base64.b64decode(r[0][2]).decode("utf-8") if r[0][2] else "")


def _external_conf(sess, pgdata):
    """postgresql.conf / pg_hba.conf / pg_ident.conf living outside PGDATA (Debian layout) are part of the backup."""
    out = {}
    for guc, name in (("config_file", "postgresql.conf"), ("hba_file", "pg_hba.conf"), ("ident_file", "pg_ident.conf")):
        path = sess.one("SHOW %s" % guc)
        if path and os.path.isfile(path) and not os.path.realpath(path).startswith(pgdata + os.sep):
            out[name] = path
    return out


def run_backup(ctx, btype="incr", archive_timeout=120, progress=None, cancel=None, owner="", note="", start_fast=None, read_limit_mb_s=0):
    repo = ctx.repo
    repo.init()
    repo.check_writable()
    if not ctx.pgdata or not os.path.exists(os.path.join(ctx.pgdata, "PG_VERSION")):
        raise EngineError("PGA-CFG-014", "%s is not a PGDATA (PG_VERSION missing)" % ctx.pgdata)
    with repo.lock("stanza", owner or "backup"):
        with repo.gc_lock(shared=True):                            # no garbage collection in the repository (any stanza, any node) while this run deduplicates
            return _run_locked(ctx, btype, archive_timeout, progress, cancel, note, start_fast, ReadLimiter(read_limit_mb_s))


def _run_locked(ctx, btype, archive_timeout, progress, cancel, note, start_fast=None, limiter=_NO_LIMIT):
    repo, log = ctx.repo, ctx.log
    requested = btype
    sess = PgSession(ctx.conn)
    meta = None
    started_backup = False
    try:
        require_supported(sess.profile, "backup")
        for sev, code, text in sess.profile.problems() + check_tools(sess.profile, ctx.conn.bindir):
            log("warn", "compat: " + text)
        sysid = sess.scalar("SELECT system_identifier FROM pg_control_system()")
        in_recovery = sess.scalar("SELECT pg_is_in_recovery()") == "t"
        tli = current_timeline(sess, in_recovery, ctx)
        data_dir = sess.scalar("SHOW data_directory")
        if os.path.realpath(data_dir) != ctx.pgdata:
            raise EngineError("PGA-CFG-015", "connected instance uses data_directory %s but the agent is configured for %s" % (data_dir, ctx.pgdata),
                              "the agent would back up the wrong cluster; fix pg_data / port")
        if int(sess.scalar("SHOW block_size")) != BLCKSZ:
            raise EngineError("PGA-CFG-016", "block_size != 8192 is not supported")
        if sess.scalar("SHOW full_page_writes") != "on":
            raise EngineError("PGA-VRF-011", "full_page_writes=off: a backup taken while the cluster runs cannot be repaired by WAL replay",
                              "set full_page_writes=on")
        if sess.scalar("SHOW archive_mode") not in ("on", "always"):
            raise EngineError("PGA-WAL-021", "archive_mode is off: without WAL archiving the backup cannot be made consistent nor used for PITR",
                              "run the 'archive setup' step (archive_mode=on, archive_command=pg-arca-wal archive %p %f)")
        seg_size = _wal_seg_size(sess)
        checksums = sess.scalar("SHOW data_checksums") == "on"
        hints = sess.scalar("SHOW wal_log_hints") == "on"

        sj = repo.sp("stanza.json")
        if os.path.exists(sj):
            sm = read_json(sj)
            if sm.get("system_identifier") not in (None, sysid):
                raise EngineError("PGA-CFG-021", "stanza '%s' belongs to system_identifier %s but this cluster has %s" % (ctx.stanza, sm.get("system_identifier"), sysid),
                                  "configuration copied from another host or PGDATA re-created; use another stanza")
        else:
            write_json(sj, {"stanza": ctx.stanza, "system_identifier": sysid, "version": sess.version, "version_num": sess.version_num,
                            "created": iso(), "pgdata": ctx.pgdata})

        # ---- crashed earlier runs (we hold the lock, so nobody is really running)
        suspect = None
        for s in repo.own_sets():
            if s.get("status") == "PENDING_WAL" and _finish_pending_wal(ctx, s):
                continue                                    # died while waiting for its WAL, which arrived since: the set is good
            if s.get("status") == "UNRECOVERABLE" and s.get("wal_timeout") and _finish_pending_wal(ctx, s):
                continue                                    # its WAL was late (archiver blocked, then repaired): the data was always good
            if s.get("status") in ("RUNNING", "PENDING", "PENDING_WAL"):
                s["status"] = "FAILED"
                s["reason"] = "interrupted (agent or host died before commit)"
                repo.write_meta(s)
                suspect = min(suspect or 1e18, s.get("started_ts", 0) or 0)
        repo.suspect_since = (suspect - 5) if suspect else None

        # ---- type & parent
        parent, prev_lsn = None, 0
        if btype in ("incr", "diff"):
            done = repo.own_complete_sets()                 # a new location starts its own chain: never an incremental on top of a set left behind
            cand = None
            if btype == "diff":
                fulls = [s for s in done if s["type"] == "full"]
                cand = fulls[-1] if fulls else None
            else:
                cand = done[-1] if done else None
            if cand is not None:
                try:
                    build_chain(repo, cand)
                except EngineError as e:
                    log("warn", "parent chain unusable (%s): promoting to full" % e.message)
                    cand = None
            if cand is None:
                log("warn", "no usable parent: promoting %s to full" % btype)
                btype = "full"
            elif cand.get("system_identifier") != sysid:
                btype = "full"
            elif bool(_chain_base(repo, cand).get("from_standby")) != bool(in_recovery):
                # a restore installs the BASE full's backup_label next to the LAST set's pg_control: a label "BACKUP FROM: standby" with a
                # primary's control file (or the reverse) is refused by PostgreSQL ("backup_label contains data inconsistent with control file").
                # Each chain therefore stays on one side (independent review: a full on the standby, then incrementals on the primary)
                log("warn", "the parent chain was taken on a %s and this backup runs on a %s: promoting %s to full"
                    % ("standby" if not in_recovery else "primary", "standby" if in_recovery else "primary", btype))
                btype = "full"
            elif int(cand.get("timeline") or 0) != tli:
                # after a failover/PITR the new timeline's LSNs can be LOWER than the parent's start LSN (promoted replica that lagged): the LSN page filter
                # would silently skip pages changed since the switch. A full backup is the only safe answer.
                log("warn", "timeline changed since the parent backup (%s -> %s): promoting %s to full" % (cand.get("timeline"), tli, btype))
                btype = "full"
            else:
                if not (checksums or hints):
                    raise EngineError("PGA-VRF-010", "page-level incrementals are unsafe: data_checksums=off and wal_log_hints=off "
                                      "(hint-bit changes could modify a page without advancing its LSN)", "enable wal_log_hints=on (restart) or run full backups only")
                parent, prev_lsn = cand, lsn_to_int(cand["start_lsn"])

        for attempt in range(3):                                       # ids have a one-second resolution: a retry right after a failed start waits a second
            set_id = now_utc().strftime("%Y%m%d-%H%M%S") + TYPE_LETTER[btype]
            if parent:
                set_id = parent["id"].split("_")[0] + "_" + set_id
            sdir = repo.own_path("backup", set_id)
            if not os.path.exists(sdir) and repo.claim_set_dir(set_id, "backup"):
                break
            if attempt == 2:
                raise EngineError("PGA-REPO-040", "backup set %s already exists" % set_id)
            time.sleep(1.05)
        t_start = time.time()
        meta = {"id": set_id, "type": btype, "parent": parent["id"] if parent else None, "stanza": ctx.stanza, "system_identifier": sysid,
                "pg_version": sess.version, "pg_version_num": sess.version_num, "timeline": tli, "status": "RUNNING", "started_ts": t_start,
                "start_time": iso(), "host": socket.gethostname(), "pgdata": ctx.pgdata, "from_standby": in_recovery, "engine": ENGINE_VERSION,
                "wal_segment_size": seg_size, "data_checksums": checksums, "note": note}
        if requested != btype:
            # an incremental the agent had to take as a full (other side of the chain, new timeline, broken parent): retention does not count it
            # as one of the N chains to keep, or two unplanned fulls would push the planned history out (independent review)
            meta["promoted_from"] = requested
        if limiter.rate > 0:
            meta["read_limit_mb_s"] = limiter.rate / 1048576.0
        repo.write_meta(meta)
        log("info", "backup %s (%s) started on timeline %d%s" % (set_id, btype, tli, " [standby]" if in_recovery else ""))
        if progress:
            progress({"phase": "catalog", "set": set_id, "type": btype})
        cat = snapshot_catalog(ctx.conn, log)
        _check_cancel(cancel)

        label = "pg_arca:%s" % set_id
        fast_on = ctx.start_fast if start_fast is None else bool(start_fast)
        fast = "true" if fast_on else "false"
        start_sql = sess.profile.backup_start_sql(sql_lit(label), fast_on)
        start_lsn = _start_backup(ctx, sess, start_sql, fast_on, progress, cancel)
        if not start_lsn:
            raise EngineError("PGA-GEN-040", "pg_backup_start failed", "the backup role needs pg_backup_start privileges (superuser or pg_write_all_data/EXECUTE grants)")
        started_backup = True
        meta["start_lsn"] = start_lsn
        links = skipped_links(ctx.pgdata)
        if links:
            meta["skipped_links"] = [{"path": a, "target": b} for a, b in links]
            log("warn", "symbolic links inside PGDATA are not followed and are NOT in this backup (same as pg_basebackup): %s" % "; ".join("%s -> %s" % x for x in links[:5]))

        # ---- copy files in parallel
        files = list(walk_pgdata(ctx.pgdata))
        control = [x for x in files if x[0] == "global/pg_control"]
        files = [x for x in files if x[0] != "global/pg_control"]
        files.sort(key=lambda x: -x[2].st_size)                       # big first: better parallel tail
        totals = {"files": 0, "bytes_logical": 0, "bytes_written": 0, "chunks_new": 0, "chunks_dedup": 0, "pages_read": 0, "pages_kept": 0, "skipped_files": 0,
                  "bytes_not_read": 0, "files_not_read": 0}
        manifest_files = {}
        lock = threading.Lock()
        planned = sum(x[2].st_size for x in files)
        last = [0.0]

        # ---- PostgreSQL 17+ WAL summaries: which relation files changed since the parent (see engine/walsummary.py)
        unread, partial = set(), {}
        if parent is not None:
            unread, partial, ws_info = _plan_with_summaries(ctx, sess, repo, parent, tli, prev_lsn, start_lsn, files, progress, cancel)
            if ws_info:
                meta["wal_summaries"] = ws_info

        def one(item):
            rel, full, st = item
            _check_cancel(cancel)
            if rel in unread:
                return rel, unread_entry(st)
            if rel in partial:
                return rel, backup_file_sparse(repo, rel, full, st, prev_lsn, partial[rel], limiter=limiter)
            return rel, backup_file(repo, rel, full, st, prev_lsn, parent is not None, limiter=limiter)

        def absorb(rel, entry, st):
            totals["files"] += 1
            totals["skipped_files"] += st["skipped"]
            totals["files_not_read"] += 1 if rel in unread else 0
            for k in ("bytes_logical", "bytes_written", "chunks_new", "chunks_dedup", "pages_read", "pages_kept", "bytes_not_read"):
                totals[k] += st.get(k, 0)
            if entry is not None:
                manifest_files[rel] = entry

        def tick():
            if progress and time.time() - last[0] > 1.0:
                last[0] = time.time()
                progress({"phase": "copy", "set": set_id, "files": totals["files"], "files_total": len(files) + 1,
                          "bytes_logical": totals["bytes_logical"], "bytes_written": totals["bytes_written"], "bytes_total": planned,
                          "pct": int(100.0 * totals["bytes_logical"] / max(planned, 1))})
        with ThreadPoolExecutor(max_workers=ctx.process_max) as pool:
            for rel, (entry, st) in _stream(pool, files, one, ctx.process_max * 4, tick):
                absorb(rel, entry, st)
        for item in control:                                           # pg_control last, as pg_basebackup does
            rel, (entry, st) = one(item)
            absorb(rel, entry, st)

        extra = {}
        for name, path in _external_conf(sess, ctx.pgdata).items():
            with open(path, "rb") as fh:
                data = fh.read()
            chunks = []
            for i in range(0, max(len(data), 1), CHUNK_SIZE):
                h, w, _ = repo.put_chunk(data[i:i + CHUNK_SIZE])
                chunks.append([i, len(data[i:i + CHUNK_SIZE]), h])
            extra["_conf/" + name] = {"size": len(data), "mode": 0o600, "mtime": int(time.time()), "kind": "whole", "chunks": chunks, "origin": path}
        manifest_files.update(extra)

        # ---- stop
        if progress:
            progress({"phase": "finalize", "set": set_id})
        stop_lsn, labelfile, spcmap = _stop_backup(sess)
        started_backup = False
        tli_stop = current_timeline(sess, in_recovery, ctx, lsn_to_int(stop_lsn))
        lt = re.search(r"START TIMELINE: (\d+)", labelfile or "")
        if in_recovery and lt and int(lt.group(1)) != tli:
            # PostgreSQL's own label is the authority on where this backup started
            if parent is not None:
                raise EngineError("PGA-CLU-014", "this standby was on timeline %s when the backup started, not %d as estimated: the incremental's parent may be "
                                  "on another timeline" % (lt.group(1), tli), "retry: the next run starts from the right timeline")
            tli = meta["timeline"] = int(lt.group(1))
        if tli_stop != tli:
            raise EngineError("PGA-CLU-014", "timeline changed during the backup (%d -> %d): failover happened" % (tli, tli_stop), "retry; copied chunks are reused")
        meta["stop_lsn"] = stop_lsn
        tbs = tablespace_links(ctx.pgdata)
        manifest = {"set": set_id, "type": btype, "parent": meta["parent"], "files": manifest_files, "tablespaces": tbs}

        repo.flush()                                                   # packs sealed and indexed (fsync) before the manifest that references them exists
        repo.sync()                                                    # one global sync: format-1 files and set directories are durable before the set can be COMPLETE
        write_file_atomic(os.path.join(sdir, "backup_label"), labelfile.encode("utf-8"), 0o640)
        repo.write_zjson(os.path.join(sdir, "manifest.json.z"), manifest, set_id + "/manifest")
        repo.write_zjson(os.path.join(sdir, "catalog.json.z"), cat, set_id + "/catalog")
        meta.update({"status": "PENDING_WAL", "stop_time": _stop_time(sess, in_recovery), "duration_sec": round(time.time() - t_start, 1), "stats": totals,
                     "tablespaces": tbs, "hostname": socket.gethostname()})
        repo.write_meta(meta)

        # ---- WAL needed to make THIS set recoverable must be in the archive
        if progress:
            progress({"phase": "wal", "set": set_id})
        ok, need_missing, wal_diag = _wait_for_wal(ctx, sess, tli, start_lsn, stop_lsn, seg_size, in_recovery, archive_timeout, cancel, progress, set_id)
        if not ok:
            meta["status"] = "UNRECOVERABLE"
            if wal_diag == "stale":
                meta["wal_timeout"] = True
                meta["reason"] = ("nothing reached this node's WAL archive (%s) while waiting for %s: the archive this node reads is not receiving "
                                  "the primary's segments" % (ctx.wal.wal_dir, ", ".join(need_missing[:3])))
                repo.write_meta(meta)
                raise EngineError("PGA-WAL-021", meta["reason"],
                                  "a backup taken on a standby needs the WHOLE cluster to share ONE WAL archive (the same network share or destination on every "
                                  "node). Point every node at the same archive (Backup tab, 'Backup storage' -> 'Destination'), or run backups on the primary. "
                                  "If the archive IS shared, the primary's archiver is failing: check pg_stat_archiver there. The set is marked UNRECOVERABLE")
            else:
                meta["reason"] = "WAL segment(s) not archived within %ds: %s%s" % (archive_timeout, ", ".join(need_missing[:5]), _archiver_diagnosis(ctx, sess, in_recovery))
                meta["wal_timeout"] = True                     # completed by a later run once that WAL reaches the archive (_finish_pending_wal)
                repo.write_meta(meta)
                raise EngineError("PGA-WAL-020", meta["reason"],
                                  ("check archive_command / pg_stat_archiver on the primary (this backup ran on a standby: the primary archives its WAL)"
                                   if in_recovery else "check archive_command / pg_stat_archiver") + "; the set is marked UNRECOVERABLE")
        # present by NAME is not enough: when another server wrote these names (split brain, a promotion without the archive) the copies in the
        # archive are its WAL, not ours - this set would be COMPLETE and fail at restore time (independent review: only the late-WAL path checked)
        why = _late_wal_doubt(ctx, {"timeline": tli, "stop_lsn": stop_lsn}, _wal_needed(tli, start_lsn, stop_lsn, seg_size, in_recovery))
        if why:
            meta.update(status="UNRECOVERABLE", reason=why, late_wal_doubt=why)
            repo.write_meta(meta)
            raise EngineError("PGA-WAL-023", "backup %s is not usable: %s" % (set_id, why),
                              "resolve the divergence (WAL archive findings: which server is the real primary), then take a new FULL backup")
        meta["status"] = "COMPLETE"
        meta["completed"] = iso()
        repo.write_meta(meta)
        ratio = totals["bytes_logical"] / float(max(totals["bytes_written"], 1))
        log("info", "backup %s complete: %s read, %s stored (%.1fx) in %.1fs%s" % (set_id, human(totals["bytes_logical"] - totals["bytes_not_read"]), human(totals["bytes_written"]), ratio, time.time() - t_start,
                                                                              (", %s of %d files not read thanks to WAL summaries" % (human(totals["bytes_not_read"]), totals["files_not_read"])) if totals["bytes_not_read"] else ""))
        return meta
    except BaseException as e:
        if started_backup:
            try:
                _stop_backup(sess)
            except Exception:
                pass
        try:
            repo.flush()                                               # chunks of a failed attempt stay usable (deduplicated by the next one)
        except Exception:
            pass
        if meta is not None and meta.get("status") in ("RUNNING", "PENDING_WAL"):
            meta["status"] = "FAILED"
            meta["reason"] = e.as_text() if isinstance(e, EngineError) else str(e)
            try:
                repo.write_meta(meta)
            except Exception:
                pass
        if isinstance(e, OSError) and not isinstance(e, EngineError):
            raise _storage_error(e, ctx) from e
        raise
    finally:
        sess.close()


def _plan_with_summaries(ctx, sess, repo, parent, tli, prev_lsn, start_lsn, files, progress, cancel):
    """(unread set, partial {rel: chunk indexes}, info for meta) from the WAL summaries, or (set(), {}, info/None) when they cannot be used.
    A sample of the files that would not be read is scanned in full first: a changed chunk there means the summaries cannot be trusted
    for this backup, and everything is scanned as before (loud in the log)."""
    from pg_arca.engine import walsummary
    log = ctx.log
    ok, why = walsummary.available(sess, log)
    if not ok:
        if sess.version_num >= 170000:
            log("info", "WAL summaries not used: %s" % why)
        return set(), {}, {"used": False, "reason": why} if sess.version_num >= 170000 else None
    if progress:
        progress({"phase": "summaries"})
    chain = walsummary.summaries_for(sess, tli, parent["start_lsn"], start_lsn, cancel=cancel, log=log)
    if not chain:
        return set(), {}, {"used": False, "reason": "summaries do not cover the range"}
    try:
        seg_blocks = int(sess.scalar("SELECT setting FROM pg_settings WHERE name = 'segment_size'"))
    except (EngineError, ValueError, TypeError):
        seg_blocks = 131072
    try:
        changes = walsummary.changed_chunks(sess, tli, chain, [x[0] for x in files], seg_blocks)
        pfiles = repo.load_manifest(parent)["files"]
    except EngineError as e:
        log("warn", "PGA-INC-013: WAL summaries unreadable (%s): this incremental scans every page" % e)
        return set(), {}, {"used": False, "reason": str(e)}
    paged = [x for x in files if is_main_fork(x[0])]
    skip, partial, full = walsummary.plan_files(paged, changes, pfiles)
    # the check: a few files the summaries call unchanged, scanned the old way; one changed page there and the summaries are not used
    sizes = dict((x[0], x[2].st_size) for x in paged)
    for rel in walsummary.sample(skip, sizes=sizes):
        item = next(x for x in paged if x[0] == rel)
        bad = walsummary.contradiction(item[1], prev_lsn, lsn_to_int(start_lsn))
        if bad is not None:
            log("error", "PGA-INC-014: WAL summaries say %s is unchanged since %s but its page %d was modified in that range: summaries NOT used for this backup "
                         "(every page scanned). Check summarize_wal and wal_summary_keep_time; report this if it repeats" % (rel, parent["id"], bad))
            return set(), {}, {"used": False, "reason": "sample check failed on %s" % rel}
    info = {"used": True, "ranges": len(chain), "files_unread": len(skip), "files_partial": len(partial), "files_full": len(full),
            "bytes_unread": sum(x[2].st_size for x in paged if x[0] in set(skip))}
    log("info", "WAL summaries: %d relation files unchanged (%s not read), %d read at changed chunks only, %d scanned in full" % (len(skip), human(info["bytes_unread"]), len(partial), len(full)))
    return set(skip), partial, info


def _storage_error(e, ctx):
    """A raw OSError from the repository volume becomes an actionable error instead of 'OSError: [Errno 28]'."""
    import errno as _e
    where = ctx.repo.path
    if e.errno in (_e.ENOSPC, getattr(_e, "EDQUOT", -1)):
        return EngineError("PGA-REPO-060", "the backup repository is full (%s): %s" % (where, e.strerror or e),
                           "free space or enlarge the volume, or run 'expire' to apply retention; the failed set is discarded and chunks already stored are reused by the next attempt")
    if e.errno == _e.EROFS:
        return EngineError("PGA-REPO-061", "the backup repository is mounted read-only (%s)" % where, "check the mount (a filesystem error usually remounts it read-only)")
    if e.errno in (_e.EACCES, _e.EPERM):
        return EngineError("PGA-REPO-003", "no permission to write in the backup repository (%s): %s" % (where, e.strerror or e), "check ownership: the agent user must own the repository")
    return EngineError("PGA-REPO-062", "I/O error on the backup repository (%s): %s" % (where, e), "check the storage (network mount, disk health, permissions)")


def _wal_seg_size(sess):
    v = sess.scalar("SELECT setting FROM pg_settings WHERE name='wal_segment_size'")
    u = sess.scalar("SELECT unit FROM pg_settings WHERE name='wal_segment_size'")
    n = int(v)
    return n * {"B": 1, "kB": 1024, "8kB": 8192, "MB": 1024 * 1024}.get(u or "B", 1)


def _stream(pool, items, fn, window, tick=None):
    """Run fn over items on the pool with at most `window` tasks in flight, yielding results as they complete. Unlike batched
    pool.map there is no barrier: a worker that finishes a small file takes the next one at once, even while a 1 GB relation is still
    being chunked on another thread (with the old 512-file batches the other workers sat idle at the tail of every batch, waiting for its slowest file).
    The first exception stops the stream (the remaining queued work is dropped)."""
    from concurrent.futures import FIRST_COMPLETED, wait
    it = iter(items)
    pending = set()
    try:
        for x in it:
            pending.add(pool.submit(fn, x))
            if len(pending) >= window:
                break
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for f in done:
                yield f.result()
                if tick:
                    tick()
            for x in it:
                pending.add(pool.submit(fn, x))
                if len(pending) >= window:
                    break
    finally:
        for f in pending:
            f.cancel()


def _wal_needed(tli, start_lsn, stop_lsn, seg_size, from_standby):
    first, last = wal_segno(lsn_to_int(start_lsn), seg_size), last_wal_segno({"stop_lsn": stop_lsn, "from_standby": from_standby}, seg_size)
    return [wal_name(tli, n, seg_size) for n in range(first, last + 1)]


def _archiver_diagnosis(ctx, sess, in_recovery):
    """Why the WAL did not arrive, when it can be told: PostgreSQL's archiver failing (pg_stat_archiver on the primary) and the reason
    pg-arca-wal recorded for its last refusal (PostgreSQL keeps only the segment name). '' when nothing more is known."""
    out = []
    if not in_recovery:
        try:
            r = sess.query("SELECT COALESCE(last_failed_wal,''), COALESCE(last_failed_time::text,''), COALESCE(last_archived_time::text,''), failed_count "
                           "FROM pg_stat_archiver")
            if r and r[0][0] and (not r[0][2] or r[0][1] > r[0][2]):
                out.append("PostgreSQL's archiver is failing: last failure on %s at %s (%s failures so far)" % (r[0][0], r[0][1][:19], r[0][3]))
        except Exception:
            pass
    try:
        with open(os.path.join(ctx.wal.wal_dir, ".last_archive_error.json"), "r", encoding="utf-8") as f:
            e = json.load(f)
        if e.get("error"):
            out.append("last refusal by the archive: %s" % str(e["error"])[:300])
    except (IOError, OSError, ValueError, AttributeError):
        pass
    return (". " + "; ".join(out)) if out else ""


def _late_wal_doubt(ctx, s, need):
    """Why the archive's copies of `need` may not be THIS server's WAL ('' when there is no such sign): a divergent copy of one of them was
    quarantined (conflicts/, reviewed/ or a retired dead branch), or a later timeline's history says this set's timeline ended before the set
    did (its tail is not on the surviving history)."""
    want = set(need)
    root = os.path.join(ctx.wal.wal_dir, "conflicts")
    try:
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                if f.split(".")[0] in want:
                    return "a divergent copy of %s is in the archive's quarantine (%s): which server's WAL the archive holds must be checked by a person" % (
                        f.split(".")[0], os.path.relpath(os.path.join(dirpath, f), ctx.wal.wal_dir))
    except OSError:
        pass
    try:
        tli, stop = int(s["timeline"]), lsn_to_int(s["stop_lsn"])
        for f in os.listdir(ctx.wal.wal_dir):
            m = re.match(r"^([0-9A-F]{8})\.history$", f)
            if m and int(m.group(1), 16) > tli:
                forks = ctx.wal._history_forks(int(m.group(1), 16)) or {}
                if tli in forks and forks[tli] < stop:
                    return "timeline %d ended at %X/%X in %s, before this backup's end: its WAL is not on the surviving history" % (
                        tli, forks[tli] >> 32, forks[tli] & 0xFFFFFFFF, f)
    except (OSError, ValueError, KeyError):
        return "the archive's timeline history could not be read"
    return ""


def _finish_pending_wal(ctx, s):
    """A set left in PENDING_WAL by a crash (agent or host died while waiting for the archiver), or marked UNRECOVERABLE because its WAL was
    late (wal_timeout: the archiver was blocked and has been repaired since): its data and manifest are durable, only the
    WAL was missing. If every segment it needs is in the archive now, it is complete (it used to be marked FAILED and later deleted as junk:
    a good backup thrown away). Returns True when the set was completed."""
    try:
        if not (s.get("start_lsn") and s.get("stop_lsn") and s.get("timeline")) or not os.path.exists(ctx.repo.sp("backup", s["id"], "manifest.json.z")):
            return False
        need = _wal_needed(int(s["timeline"]), s["start_lsn"], s["stop_lsn"], int(s.get("wal_segment_size") or ctx.seg_size), bool(s.get("from_standby")))
        if any(not ctx.wal.has_segment(n, anywhere=False) for n in need):
            return False
        why = _late_wal_doubt(ctx, s, need)
        if why:
            # present by NAME is not enough when two servers wrote these names (the usual reason the WAL was late): the stored copies may be the
            # other server's, and replaying them over this backup would fail or corrupt it (independent engine review, 16/10)
            if s.get("late_wal_doubt") != why:
                s["late_wal_doubt"] = why
                ctx.repo.write_meta(s)
            ctx.log("warn", "backup %s not completed automatically: %s" % (s.get("id"), why))
            return False
        s["status"] = "COMPLETE"
        s["completed"] = iso()
        s["note"] = ((s.get("note") or "") + (" (completed at a later run: its WAL reached the archive late)" if s.get("wal_timeout") else
                                             " (completed at the next run: its WAL reached the archive after the agent stopped)")).strip()
        s.pop("reason", None)
        s.pop("late_wal_doubt", None)
        ctx.repo.write_meta(s)
        ctx.log("info", "backup %s completed: the WAL it was waiting for when the agent stopped is in the archive now" % s.get("id"))
        return True
    except Exception as e:                                  # never let this block the new backup: the set is then marked FAILED as before
        ctx.log("warn", "could not complete the interrupted backup %s: %s" % (s.get("id"), e))
        return False


def _wait_for_wal(ctx, sess, tli, start_lsn, stop_lsn, seg_size, in_recovery, timeout, cancel, progress=None, set_id=""):
    """Wait until every WAL segment this set needs is in the archive. Returns (ok, missing, diag):
    diag "" = plain timeout; "stale" = NOTHING reached this node's archive while waiting (on a standby that almost always means the
    archive this node reads is not the one the primary writes to, i.e. not shared). On the primary the current segment is switched
    here; on a standby the CONSOLE asks the primary to switch (an agent cannot run pg_switch_wal through a replication connection)."""
    need = _wal_needed(tli, start_lsn, stop_lsn, seg_size, in_recovery)
    switch_err = ""
    if not in_recovery:
        try:
            sess.query("SELECT pg_switch_wal()")
        except EngineError as e:
            switch_err = str(e)
            ctx.log("warn", "pg_switch_wal failed (%s): waiting for the archiver to reach the stop segment by itself" % e)
    t0 = time.time()
    last_note = 0.0
    missing = need
    while True:
        missing = [n for n in need if not ctx.wal.has_segment(n, anywhere=False)]
        if not missing:
            return True, [], ""
        waited = time.time() - t0
        # a standby waits for segments the PRIMARY archives: if nothing at all lands here, this archive is not receiving them
        # (each node with its own local archive directory): no amount of waiting can fix that, say it early and clearly.
        if in_recovery and waited > min(60, timeout / 2.0) and not ctx.wal.activity_since(t0 - 1):
            return False, missing, "stale"
        if waited > timeout:
            return False, missing, "switch_failed" if switch_err else ""
        if progress and time.time() - last_note > 14:
            last_note = time.time()
            progress({"phase": "wal", "set": set_id, "waited_sec": int(waited), "missing": missing[:3]})
        _check_cancel(cancel)
        time.sleep(1)
