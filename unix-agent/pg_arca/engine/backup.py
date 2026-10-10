"""Backup: physical, page-aware, deduplicated, parallel; full / differential / incremental (page-LSN)."""

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
from pg_arca.engine.pgdata import ZEROPAGE, is_main_fork, page_lsn, tablespace_links, walk_pgdata
from pg_arca.engine.pgsession import PgSession
from pg_arca.engine.util import (BLCKSZ, CHUNK_SIZE, Cancelled, EngineError, human, iso, lsn_to_int, now_utc, read_json, sql_lit,
                                 wal_name, wal_segno, last_wal_segno, write_file_atomic, write_json)

READ_BLOCK = 4 * 1024 * 1024
TYPE_LETTER = {"full": "F", "diff": "D", "incr": "I"}


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


def backup_file(repo, rel, full, st, prev_lsn, incremental, fadvise=True):
    """Store one file. Returns (entry or None, stats dict)."""
    stats = {"bytes_logical": 0, "bytes_written": 0, "chunks_new": 0, "chunks_dedup": 0, "pages_read": 0, "pages_kept": 0, "skipped": 0}
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


def current_timeline(sess, in_recovery):
    """The timeline new WAL is being written on RIGHT NOW. pg_control_checkpoint() lags after a promotion (it only moves when the first checkpoint of the new timeline
    completes), so a backup started just after a failover would be labelled with the OLD timeline: wrong WAL names to wait for and an incremental chained onto a
    parent from another timeline. On a primary the WAL insert position says it exactly; a standby only has the control file."""
    if not in_recovery:
        try:
            return int(sess.scalar("SELECT ('x' || substr(pg_walfile_name(pg_current_wal_insert_lsn()), 1, 8))::bit(32)::int"))
        except EngineError:
            pass
    return int(sess.scalar("SELECT timeline_id FROM pg_control_checkpoint()"))


def _stop_backup(sess):
    if sess.version_num >= 150000:
        fn = "pg_backup_stop(false)"
    else:
        fn = "pg_stop_backup(false, false)"
    q = ("SELECT lsn::text, translate(encode(convert_to(labelfile,'UTF8'),'base64'), E'\\n', ''), "
         "translate(encode(convert_to(COALESCE(spcmapfile,''),'UTF8'),'base64'), E'\\n', '') FROM %s" % fn)
    r = sess.query(q)
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


def run_backup(ctx, btype="incr", archive_timeout=120, progress=None, cancel=None, owner="", note="", start_fast=None):
    repo = ctx.repo
    repo.init()
    repo.check_writable()
    if not ctx.pgdata or not os.path.exists(os.path.join(ctx.pgdata, "PG_VERSION")):
        raise EngineError("PGA-CFG-014", "%s is not a PGDATA (PG_VERSION missing)" % ctx.pgdata)
    with repo.lock("stanza", owner or "backup"):
        return _run_locked(ctx, btype, archive_timeout, progress, cancel, note, start_fast)


def _run_locked(ctx, btype, archive_timeout, progress, cancel, note, start_fast=None):
    repo, log = ctx.repo, ctx.log
    sess = PgSession(ctx.conn)
    meta = None
    started_backup = False
    try:
        sysid = sess.scalar("SELECT system_identifier FROM pg_control_system()")
        in_recovery = sess.scalar("SELECT pg_is_in_recovery()") == "t"
        tli = current_timeline(sess, in_recovery)
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
        for s in repo.sets():
            if s.get("status") in ("RUNNING", "PENDING"):
                s["status"] = "FAILED"
                s["reason"] = "interrupted (agent or host died before commit)"
                repo.write_meta(s)
                suspect = min(suspect or 1e18, s.get("started_ts", 0) or 0)
        repo.suspect_since = (suspect - 5) if suspect else None

        # ---- type & parent
        parent, prev_lsn = None, 0
        if btype in ("incr", "diff"):
            done = repo.complete_sets()
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

        set_id = now_utc().strftime("%Y%m%d-%H%M%S") + TYPE_LETTER[btype]
        if parent:
            set_id = parent["id"].split("_")[0] + "_" + set_id
        sdir = repo.sp("backup", set_id)
        if os.path.exists(sdir):
            raise EngineError("PGA-REPO-040", "backup set %s already exists" % set_id)
        os.makedirs(sdir, mode=0o750)
        t_start = time.time()
        meta = {"id": set_id, "type": btype, "parent": parent["id"] if parent else None, "stanza": ctx.stanza, "system_identifier": sysid,
                "pg_version": sess.version, "pg_version_num": sess.version_num, "timeline": tli, "status": "RUNNING", "started_ts": t_start,
                "start_time": iso(), "host": socket.gethostname(), "pgdata": ctx.pgdata, "from_standby": in_recovery, "engine": ENGINE_VERSION,
                "wal_segment_size": seg_size, "data_checksums": checksums, "note": note}
        repo.write_meta(meta)
        log("info", "backup %s (%s) started on timeline %d%s" % (set_id, btype, tli, " [standby]" if in_recovery else ""))
        if progress:
            progress({"phase": "catalog", "set": set_id, "type": btype})
        cat = snapshot_catalog(ctx.conn, log)
        _check_cancel(cancel)

        label = "pg_arca:%s" % set_id
        fast_on = ctx.start_fast if start_fast is None else bool(start_fast)
        fast = "true" if fast_on else "false"
        if sess.version_num >= 150000:
            start_sql = "SELECT pg_backup_start(%s, %s)::text" % (sql_lit(label), fast)
        else:
            start_sql = "SELECT pg_start_backup(%s, %s, false)::text" % (sql_lit(label), fast)
        start_lsn = _start_backup(ctx, sess, start_sql, fast_on, progress, cancel)
        if not start_lsn:
            raise EngineError("PGA-GEN-040", "pg_backup_start failed", "the backup role needs pg_backup_start privileges (superuser or pg_write_all_data/EXECUTE grants)")
        started_backup = True
        meta["start_lsn"] = start_lsn

        # ---- copy files in parallel
        files = list(walk_pgdata(ctx.pgdata))
        control = [x for x in files if x[0] == "global/pg_control"]
        files = [x for x in files if x[0] != "global/pg_control"]
        files.sort(key=lambda x: -x[2].st_size)                       # big first: better parallel tail
        totals = {"files": 0, "bytes_logical": 0, "bytes_written": 0, "chunks_new": 0, "chunks_dedup": 0, "pages_read": 0, "pages_kept": 0, "skipped_files": 0}
        manifest_files = {}
        lock = threading.Lock()
        planned = sum(x[2].st_size for x in files)
        last = [0.0]

        def one(item):
            rel, full, st = item
            _check_cancel(cancel)
            return rel, backup_file(repo, rel, full, st, prev_lsn, parent is not None)

        def absorb(rel, entry, st):
            totals["files"] += 1
            totals["skipped_files"] += st["skipped"]
            for k in ("bytes_logical", "bytes_written", "chunks_new", "chunks_dedup", "pages_read", "pages_kept"):
                totals[k] += st[k]
            if entry is not None:
                manifest_files[rel] = entry

        with ThreadPoolExecutor(max_workers=ctx.process_max) as pool:
            for i in range(0, len(files), 512):
                batch = files[i:i + 512]
                for rel, (entry, st) in pool.map(one, batch):
                    absorb(rel, entry, st)
                if progress and time.time() - last[0] > 1.0:
                    last[0] = time.time()
                    progress({"phase": "copy", "set": set_id, "files": totals["files"], "files_total": len(files) + 1,
                              "bytes_logical": totals["bytes_logical"], "bytes_written": totals["bytes_written"], "bytes_total": planned,
                              "pct": int(100.0 * totals["bytes_logical"] / max(planned, 1))})
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
        tli_stop = current_timeline(sess, in_recovery)
        if tli_stop != tli:
            raise EngineError("PGA-CLU-014", "timeline changed during the backup (%d -> %d): failover happened" % (tli, tli_stop), "retry; copied chunks are reused")
        meta["stop_lsn"] = stop_lsn
        tbs = tablespace_links(ctx.pgdata)
        manifest = {"set": set_id, "type": btype, "parent": meta["parent"], "files": manifest_files, "tablespaces": tbs}

        repo.sync()                                                    # one global sync: chunks are durable before the set can be COMPLETE
        write_file_atomic(os.path.join(sdir, "backup_label"), labelfile.encode("utf-8"), 0o640)
        repo.write_zjson(os.path.join(sdir, "manifest.json.z"), manifest, set_id + "/manifest")
        repo.write_zjson(os.path.join(sdir, "catalog.json.z"), cat, set_id + "/catalog")
        meta.update({"status": "PENDING_WAL", "stop_time": iso(), "duration_sec": round(time.time() - t_start, 1), "stats": totals,
                     "tablespaces": tbs, "hostname": socket.gethostname()})
        repo.write_meta(meta)

        # ---- WAL needed to make THIS set recoverable must be in the archive
        if progress:
            progress({"phase": "wal", "set": set_id})
        ok, need_missing = _wait_for_wal(ctx, sess, tli, start_lsn, stop_lsn, seg_size, in_recovery, archive_timeout, cancel)
        if not ok:
            meta["status"] = "UNRECOVERABLE"
            meta["reason"] = "WAL segment(s) not archived within %ds: %s" % (archive_timeout, ", ".join(need_missing[:5]))
            repo.write_meta(meta)
            raise EngineError("PGA-WAL-020", meta["reason"], "check archive_command / pg_stat_archiver; the set is marked UNRECOVERABLE")
        meta["status"] = "COMPLETE"
        meta["completed"] = iso()
        repo.write_meta(meta)
        ratio = totals["bytes_logical"] / float(max(totals["bytes_written"], 1))
        log("info", "backup %s complete: %s read, %s stored (%.1fx) in %.1fs" % (set_id, human(totals["bytes_logical"]), human(totals["bytes_written"]), ratio, time.time() - t_start))
        return meta
    except BaseException as e:
        if started_backup:
            try:
                _stop_backup(sess)
            except Exception:
                pass
        if meta is not None and meta.get("status") in ("RUNNING", "PENDING_WAL"):
            meta["status"] = "FAILED"
            meta["reason"] = e.as_text() if isinstance(e, EngineError) else str(e)
            try:
                repo.write_meta(meta)
            except Exception:
                pass
        raise
    finally:
        sess.close()


def _wal_seg_size(sess):
    v = sess.scalar("SELECT setting FROM pg_settings WHERE name='wal_segment_size'")
    u = sess.scalar("SELECT unit FROM pg_settings WHERE name='wal_segment_size'")
    n = int(v)
    return n * {"B": 1, "kB": 1024, "8kB": 8192, "MB": 1024 * 1024}.get(u or "B", 1)


def _wait_for_wal(ctx, sess, tli, start_lsn, stop_lsn, seg_size, in_recovery, timeout, cancel):
    first, last = wal_segno(lsn_to_int(start_lsn), seg_size), last_wal_segno({"stop_lsn": stop_lsn, "from_standby": in_recovery}, seg_size)
    need = [wal_name(tli, n, seg_size) for n in range(first, last + 1)]
    if not in_recovery:
        try:
            sess.query("SELECT pg_switch_wal()")
        except EngineError:
            pass
    t0 = time.time()
    missing = need
    while True:
        missing = [n for n in need if not ctx.wal.has_segment(n)]
        if not missing:
            return True, []
        if time.time() - t0 > timeout:
            return False, missing
        _check_cancel(cancel)
        time.sleep(1)
