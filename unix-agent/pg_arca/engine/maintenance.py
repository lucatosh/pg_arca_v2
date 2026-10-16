"""Repository inspection and care: info, verify (shallow/deep), expire (retention + CAS GC + WAL), forensics."""

import logging
import os
import re
import shutil
import subprocess
import tempfile
import time

from pg_arca.engine.backup import build_chain
from pg_arca.engine.repo import GC_GRACE

REPACK_FRACTION = 0.25            # a pack whose dead chunks weigh at least this share of it is rewritten without them
from pg_arca.engine.util import EngineError, iso, last_wal_segno, lsn_to_int, parse_wal_name, read_json, wal_name, wal_segno, write_json

logger = logging.getLogger("pg_arca.maintenance")


# --------------------------------------------------------------------------- info
def repo_info(ctx):
    repo = ctx.repo
    sets = repo.sets()
    out = {"stanza": ctx.stanza, "repo_path": repo.path, "sets": [], "wal": {}}
    for s in sets:
        st = s.get("stats") or {}
        row = {k: s.get(k) for k in ("id", "type", "parent", "status", "start_time", "stop_time", "start_lsn", "stop_lsn", "timeline",
                                     "duration_sec", "pg_version", "reason", "note", "from_standby")}
        row.update(bytes_logical=st.get("bytes_logical", 0), bytes_written=st.get("bytes_written", 0), files=st.get("files", 0))
        out["sets"].append(row)
    segs = ctx.wal.list_segments()
    cont = ctx.wal.verify_continuity(max_age=0)
    out["wal"] = {"segments": len(segs), "first": segs[0] if segs else None, "last": segs[-1] if segs else None, "continuous": cont.get("continuous"),
                  "gaps": cont.get("gaps", [])[:10], "conflicts": cont.get("conflicts", 0)}
    cs = repo.cas_stats()
    n, total = cs["chunks"], cs["stored_bytes"]
    logical = sum((s.get("stats") or {}).get("bytes_logical", 0) for s in sets if s.get("status") == "COMPLETE")
    out["cas"] = {"chunks": n, "stored_bytes": total, "logical_bytes": logical, "ratio": round(logical / float(max(total, 1)), 2),
                  "packs": cs["packs"], "files": cs["files"]}
    done = [s for s in sets if s.get("status") == "COMPLETE"]
    if done:
        out["recovery_window"] = {"from": done[0].get("start_time"), "to": "latest archived WAL" if out["wal"]["segments"] else done[-1].get("stop_time")}
    return out


# --------------------------------------------------------------------------- verify
def verify(ctx, deep=False, progress=None, cancel=None):
    repo = ctx.repo
    repo.reload_index()                                            # verify what is on disk now, not what this process remembers
    problems, report = [], []
    sets = repo.sets()
    checked_chunks = 0
    # every chunk is located once, and in a deep verify read and checked ONCE even when ten sets share it, pack by pack in file order
    # (sequential I/O) instead of set by set in manifest order (random reads, the same chunk ten times)
    located = {}                                                   # hash -> (path, offset, length) or None
    uses = {}                                                      # hash -> [set ids]
    per_set = {}
    for s in sets:
        if s.get("status") != "COMPLETE":
            continue
        entry = {"id": s["id"], "problems": 0}
        if lsn_to_int(s["stop_lsn"]) < lsn_to_int(s["start_lsn"]):
            problems.append("%s: stop_lsn < start_lsn" % s["id"])
            entry["problems"] += 1
        try:
            build_chain(repo, s)
        except EngineError as e:
            problems.append("%s: %s" % (s["id"], e.message))
            entry["problems"] += 1
        try:
            man = repo.load_manifest(s)
        except Exception as e:
            problems.append("%s: manifest unreadable (%s)" % (s["id"], e))
            report.append(entry)
            continue
        missing = 0
        for rel, e in man["files"].items():
            for off, ln, h in e["chunks"]:
                if h not in located:
                    located[h] = repo.locate(h)
                    uses[h] = []
                uses[h].append(s["id"])
                if located[h] is None:
                    missing += 1
        if cancel and cancel():
            raise EngineError("PGA-GEN-099", "cancelled")
        entry.update(files=len(man["files"]), missing=missing, corrupt=0)
        entry["problems"] += missing
        per_set[s["id"]] = entry
        report.append(entry)
    if deep:
        order = sorted((loc[0], loc[1], h) for h, loc in located.items() if loc is not None)
        bad_by_set = {}
        i = 0
        while i < len(order):
            run = [h for _, _, h in order[i:i + 128]]                   # adjacent chunks of a pack come with one read (Repo.get_chunks)
            try:
                got = repo.get_chunks(run)
                bad = [h for h in run if h not in got]
            except EngineError:
                got, bad = {}, []
                for h in run:                                          # one of them is corrupt: find which, one by one
                    try:
                        repo.get_chunk(h)
                    except EngineError:
                        bad.append(h)
            for h in bad:
                for sid in uses[h]:
                    bad_by_set[sid] = bad_by_set.get(sid, 0) + 1
            checked_chunks += len(run)
            i += len(run)
            if progress:
                progress({"phase": "verify", "chunks": checked_chunks, "chunks_total": len(order)})
            if cancel and cancel():
                raise EngineError("PGA-GEN-099", "cancelled")
        for sid, n in bad_by_set.items():
            per_set[sid]["corrupt"] = n
            per_set[sid]["problems"] += n
    for sid, entry in per_set.items():
        if entry["missing"] or entry["corrupt"]:
            problems.append("%s: %d missing, %d corrupt chunks" % (sid, entry["missing"], entry["corrupt"]))
    for s in sets:
        if s.get("status") != "COMPLETE" or s["id"] not in per_set:
            continue
        entry = per_set[s["id"]]
        # WAL needed for this set
        seg = s.get("wal_segment_size") or ctx.seg_size
        miss = [wal_name(s["timeline"], n, seg) for n in range(wal_segno(lsn_to_int(s["start_lsn"]), seg), last_wal_segno(s, seg) + 1)
                if not ctx.wal.has_segment(wal_name(s["timeline"], n, seg))]
        if miss:
            problems.append("%s: %d WAL segment(s) between start and stop are not archived (first %s)" % (s["id"], len(miss), miss[0]))
            entry["problems"] += len(miss)
        else:
            from pg_arca.engine.backup import _late_wal_doubt
            need = [wal_name(s["timeline"], n, seg) for n in range(wal_segno(lsn_to_int(s["start_lsn"]), seg), last_wal_segno(s, seg) + 1)]
            why = _late_wal_doubt(ctx, s, need)
            if why:                                                # the names are there, but maybe another server's WAL
                problems.append("%s: %s" % (s["id"], why))
                entry["problems"] += 1
    for pr in repo.index().problems:                               # a pack index that cannot be read: its chunks look missing above; say why
        problems.append("pack index unreadable: %s" % pr)
    cont = ctx.wal.verify_continuity(max_age=0)
    if not cont.get("continuous", True):
        problems.append("WAL archive has %d gap(s)" % cont.get("gap_count", len(cont.get("gaps", []))))
    if cont.get("conflicts"):
        problems.append("%d divergent WAL copies in quarantine (possible split-brain)" % cont["conflicts"])
    return {"ok": not problems, "problems": problems, "sets": report, "deep": deep, "chunks_checked": checked_chunks,
            "wal": {"segments": cont.get("total_segments"), "continuous": cont.get("continuous")}}


# --------------------------------------------------------------------------- expire
def _dependents(sets, full):
    prefix = full["id"].split("_")[0]
    return [s for s in sets if s["id"].split("_")[0] == prefix]


def _sibling_floors(repo, keep):
    """Oldest backup start LSN of every OTHER stanza of the same database in this repository (e.g. the sites of a geo-redundant pair, registered as two
    clusters, sharing one WAL archive): the shared archive must keep what their backups need too."""
    sysid = next((s.get("system_identifier") for s in keep if s.get("system_identifier")), None)
    out = []
    root = repo.p("stanza")
    if not sysid or not os.path.isdir(root):
        return out
    for st in os.listdir(root):
        if st == repo.stanza:
            continue
        d = os.path.join(root, st, "backup")
        if not os.path.isdir(d):
            continue
        for sid in os.listdir(d):
            try:
                m = read_json(os.path.join(d, sid, "meta.json"))
            except (IOError, OSError, ValueError):
                continue
            if (m.get("status") in ("COMPLETE", "RUNNING", "PENDING_WAL") or (m.get("status") == "UNRECOVERABLE" and m.get("wal_timeout"))) \
                    and str(m.get("system_identifier")) == str(sysid) and m.get("start_lsn"):
                out.append(lsn_to_int(m["start_lsn"]))
    return out


def expire(ctx, dry_run=False, retention_full=None, retention_days=None):
    repo = ctx.repo
    keep_full = int(retention_full if retention_full is not None else ctx.retention_full)
    days = int(retention_days if retention_days is not None else ctx.retention_days)
    if keep_full < 1:
        raise EngineError("PGA-GEN-066", "retention_full must be >= 1")
    with repo.lock("stanza", "expire"):
        sets = repo.own_sets()                                     # retention never touches a previous location (read-only until migrated or removed on purpose)
        if not dry_run:
            # a set whose only fault was late WAL (archiver blocked, repaired since) is a good backup now: complete it instead of deleting it as junk
            from pg_arca.engine.backup import _finish_pending_wal
            for s in sets:
                # PENDING_WAL: the agent died while waiting for the archiver (a live backup holds the stanza lock, so none is running now) -
                # its data and manifest are durable; deleting it as junk threw a good backup away (independent review)
                if (s.get("status") == "UNRECOVERABLE" and s.get("wal_timeout")) or s.get("status") == "PENDING_WAL":
                    _finish_pending_wal(ctx, s)
        done = [s for s in sets if s.get("status") == "COMPLETE"]
        fulls = [s for s in done if s["type"] == "full"]
        # the N chains to keep are counted on PLANNED fulls: an incremental the agent had to promote (standby blip, timeline change) starts a chain
        # too, kept with the others, but it does not push a planned week of history out
        counted = [f for f in fulls if not f.get("promoted_from")] or fulls
        if keep_full > 0 and len(counted) > keep_full:
            doomed_fulls = fulls[:fulls.index(counted[-keep_full])]
        else:
            doomed_fulls = fulls[:max(0, len(fulls) - keep_full)] if keep_full <= 0 else []
        if days and doomed_fulls:
            # every point of the last N days must stay restorable: a point just after the cutoff needs the newest full that STARTED BEFORE it
            # (its chain and WAL carry the point forward), so that full is kept too, not only the fulls younger than the cutoff
            cutoff = time.time() - days * 86400
            # a full serves the points AFTER its end: the one that carries the cutoff is the newest that ENDED before it (independent review:
            # chosen by its start, a full running across the cutoff was kept instead and the points between the cutoff and its end were lost)
            ended = lambda f: (f.get("started_ts") or 0) + float(f.get("duration_sec") or 0)
            older = [f for f in fulls if ended(f) < cutoff]
            spanning = older[-1]["id"] if older else None
            doomed_fulls = [f for f in doomed_fulls if (f.get("started_ts") or 0) < cutoff and f["id"] != spanning]
        doomed = []
        for f in doomed_fulls:
            doomed += _dependents(sets, f)
        # failed / unrecoverable / pending leftovers are always collectable
        # a set that only waits for late WAL (archiver blocked) is kept for a week: it becomes a good backup the moment the archive catches up
        grace = lambda s: ((s.get("status") == "UNRECOVERABLE" and s.get("wal_timeout")) or s.get("status") == "PENDING_WAL") and \
            time.time() - (s.get("started_ts") or 0) < 7 * 86400
        junk = [s for s in sets if s.get("status") in ("FAILED", "UNRECOVERABLE", "RUNNING", "PENDING_WAL", "EXPIRING") and s not in doomed and not grace(s)]
        # incrementals whose full is gone or going (an expire interrupted after marking the full, a meta deleted by hand): not restorable, and
        # kept they pinned the WAL floor at their start forever - the archive was never trimmed again (independent engine review)
        good_fulls = set(f["id"] for f in fulls)
        junk += [s for s in done if s["type"] != "full" and s["id"].split("_")[0] not in good_fulls and s not in doomed and s not in junk]
        doomed_ids = set(s["id"] for s in doomed) | set(s["id"] for s in junk)
        pins = repo.pins()                                         # running restores: their sets and the WAL they may still fetch stay
        pinned = set(x for p in pins for x in (p.get("sets") or []))
        if pinned & doomed_ids:
            getattr(ctx, "log", lambda *a: None)("info", "expire: %d set(s) kept for now, a running restore reads them: %s" % (len(pinned & doomed_ids), ", ".join(sorted(pinned & doomed_ids))))
        doomed_ids -= pinned
        keep = [s for s in done if s["id"] not in doomed_ids]
        # sets still only in a previous location (destination changed, not migrated yet / kept on purpose) are restorable from here, and the
        # WAL they need after the switch lives in THIS archive: the floor must not cut below their start either
        prev_lsns = [lsn_to_int(s["start_lsn"]) for s in repo.sets() if s.get("location") and s.get("status") == "COMPLETE" and s.get("start_lsn")]
        prev_lsns += [lsn_to_int(p["wal_from"]) for p in pins if p.get("wal_from")]
        oldest_lsn = min([lsn_to_int(s["start_lsn"]) for s in keep] + prev_lsns, default=None)
        plan = {"delete_sets": sorted(doomed_ids), "keep_sets": [s["id"] for s in keep], "retention_full": keep_full}
        if oldest_lsn is not None:
            plan["wal_keep_from_lsn"] = "%X/%08X" % (oldest_lsn >> 32, oldest_lsn & 0xFFFFFFFF)
        plan["stale_dirs"] = repo.stale_set_dirs()
        if dry_run:
            plan["dry_run"] = True
            return plan
        # mark first (never a pinned set): a crash mid-delete leaves a recognisable EXPIRING set. Dependents before their full: a crash in between
        # never leaves COMPLETE incrementals on top of an EXPIRING full
        for s in sorted([x for x in doomed + junk if x["id"] in doomed_ids], key=lambda x: x.get("type") == "full"):
            m = repo.set_meta(s["id"])
            if m:
                m["status"] = "EXPIRING"
                repo.write_meta(m)
        try:
            repo.retire(sets=sorted(doomed_ids))                         # the offsite rehydrate must not bring them back
        except (IOError, OSError) as e:
            logger.warning("could not record the expired sets in the repository journal: %s", e)
        for sid in doomed_ids:
            shutil.rmtree(repo.own_path("backup", sid), ignore_errors=True)        # only this location: a previous one is never touched by retention
        for d in repo.stale_set_dirs():                                  # starts that died before their meta (or empty claims): not sets, just clutter
            shutil.rmtree(repo.own_path("backup", d), ignore_errors=True)
        gc = _gc_cas(repo)
        freed, removed = gc if gc is not None else (0, 0)
        if gc is None:
            plan["gc_postponed"] = True
        walrm = 0
        if oldest_lsn is not None:
            seg = keep[0].get("wal_segment_size") or ctx.seg_size
            floor_lsn = min([oldest_lsn] + _sibling_floors(repo, keep))
            floor = wal_segno(floor_lsn, seg)
            try:                                       # tell gap detection and the WAL rescue: below this the archive is empty ON PURPOSE
                ctx.wal.set_retention_floor(floor, "%X/%08X" % (floor_lsn >> 32, floor_lsn & 0xFFFFFFFF))
            except (OSError, AttributeError):
                pass
            for name in ctx.wal.list_segments():
                p = parse_wal_name(name, seg)
                if p and p[1] < floor:
                    ctx.wal.remove_segment(name)
                    walrm += 1
        plan.update(chunks_removed=removed, bytes_freed=freed, wal_removed=walrm)
        return plan


def _retire_pack(repo, pack):
    try:
        repo.retire(packs=[os.path.basename(pack)[:-5]])
    except (IOError, OSError, AttributeError) as e:
        logger.warning("could not record the removed pack in the repository journal: %s", e)


def _gc_cas(repo, wait=120):
    """Mark & sweep over EVERY stanza in the repository (chunks are shared). Young chunks are never swept (GC grace). Skipped (0, 0) while a
    backup or a migration holds the repository's shared lock: they deduplicate against an index loaded at their start, and a pack deleted or
    rewritten meanwhile would leave their set pointing at nothing."""
    lk = None
    deadline = time.time() + wait                         # a repository shared by many clusters is rarely free: wait up to 2 minutes for a gap
    while True:
        lk = repo.gc_lock(shared=False)
        if lk is not None or time.time() >= deadline:
            break
        time.sleep(min(10, max(0.1, deadline - time.time())))
    mark = repo.p("gc_postponed.json")
    if lk is None:
        try:
            prev = read_json(mark)
        except Exception:
            prev = {}
        n = int(prev.get("count") or 0) + 1
        try:
            write_json(mark, {"count": n, "since": prev.get("since") or iso()})
        except OSError:
            pass
        logger.warning("garbage collection postponed (%d time(s) in a row): a backup or migration is running in this repository", n)
        return None
    try:
        out = _gc_cas_locked(repo)
        try:
            os.unlink(mark)
        except OSError:
            pass
        return out
    finally:
        lk.release()


def _gc_cas_locked(repo):
    live = set()
    sroot = repo.p("stanza")
    for st in os.listdir(sroot):
        bd = os.path.join(sroot, st, "backup")
        if not os.path.isdir(bd):
            continue
        for sid in os.listdir(bd):
            mp = os.path.join(bd, sid, "manifest.json.z")
            if not os.path.exists(mp):
                continue
            try:
                man = repo.read_zjson(mp, sid + "/manifest")
            except Exception:
                raise EngineError("PGA-REPO-050", "cannot read manifest %s: refusing to garbage-collect (would risk deleting live chunks)" % mp)
            for e in man["files"].values():
                for _, _, h in e["chunks"]:
                    live.add(h)
    now = time.time()
    freed = removed = 0
    # ---- format-1 files (repositories older than format 2): unreferenced files older than the grace period are removed
    if repo.has_legacy_chunks():
        for sub in os.listdir(repo.p("cas")):
            if len(sub) != 2:
                continue
            for root, _, files in os.walk(repo.p("cas", sub)):
                for f in files:
                    if f in live:
                        continue
                    p = os.path.join(root, f)
                    try:
                        st = os.stat(p)
                        tmp = ".tmp." in f
                        if now - st.st_mtime < (GC_GRACE if not tmp else 3600):
                            continue
                        os.remove(p)
                        freed += st.st_size
                        removed += 1
                    except OSError:
                        pass
    # ---- packs: a pack younger than the grace period is never touched (a backup without a manifest yet may reference it; dedup refreshes the
    # mtime of packs it reuses). All dead -> deleted. Mostly dead -> live records copied into a new sealed pack, then the old one deleted.
    from pg_arca.engine import packs as _packs
    livebytes = set(bytes.fromhex(h) for h in live)
    changed = False
    for pack, idx, mtime, size in _packs.list_packs(repo.path):
        if now - mtime < GC_GRACE:
            continue
        if idx is None:                                            # an open pack of a crashed process, or a pack whose index was never written
            if pack.endswith(".pack"):
                try:                                               # sealed but not indexed (crash between the two steps): index it from its content
                    entries = list(_packs.scan_pack(pack))
                    _packs.write_idx(pack[:-5] + ".idx", entries)
                    continue
                except (EngineError, OSError):
                    pass
            try:
                os.remove(pack)
                freed += size
                removed += 1
                changed = True
            except OSError:
                pass
            continue
        try:
            entries = _packs.read_idx(idx)
        except (EngineError, OSError):
            continue                                               # unreadable index: verify reports it; never delete what we cannot account for
        dead = [e for e in entries if e[0] not in livebytes]
        if not dead:
            continue
        try:                                                       # fresh mtime right before acting: a backup that reused a chunk of this pack
            if now - os.stat(pack).st_mtime < GC_GRACE:            # since the listing touched it (same narrow window as with per-chunk files)
                continue
        except OSError:
            continue
        dead_bytes = sum(e[2] for e in dead)
        if len(dead) == len(entries):
            try:
                _retire_pack(repo, pack)
                os.remove(idx)
                os.remove(pack)
                freed += size
                removed += len(entries)
                changed = True
            except OSError:
                pass
        elif dead_bytes >= REPACK_FRACTION * size:
            try:
                newp, kept = _packs.repack(repo.path, pack, livebytes)
                _retire_pack(repo, pack)
                os.remove(idx)
                os.remove(pack)
                freed += size - kept
                removed += len(dead)
                changed = True
            except (EngineError, OSError):
                pass
    if changed:
        repo.reload_index()
    return freed, removed


# --------------------------------------------------------------------------- forensics
def forensics(ctx, limit=20, since=None, until=None, **kw):
    """DROP / TRUNCATE / DROP DATABASE events in the archived WAL (see engine/walscan.py: parallel, filtered, cached). Whole archive unless `hours` says otherwise."""
    from pg_arca.engine import walscan
    kw.setdefault("hours", 0)
    return walscan.scan(ctx, limit=limit, since=since, until=until, **kw)


def forensics_legacy(ctx, limit=20, since=None, until=None):
    """The first implementation (one pg_waldump over a full copy of the archive, parsed in Python). Kept only so tests/bench_forensics.py can measure the difference."""
    exe = ctx.conn.exe("pg_waldump")
    segs = ctx.wal.list_segments()
    if not segs:
        raise EngineError("PGA-WAL-002", "the WAL archive is empty")
    if since:
        segs = [s for s in segs if s >= since]
    if until:
        segs = [s for s in segs if s <= until]
    if not segs:
        raise EngineError("PGA-WAL-002", "no WAL segment in the requested range")
    tmp = tempfile.mkdtemp(prefix="pgarca-wal-")
    events = []
    try:
        # one timeline at a time: pg_waldump walks a directory of consecutive segments
        by_tli = {}
        for s in segs:
            by_tli.setdefault(s[:8], []).append(s)
        for tli, names in sorted(by_tli.items()):
            for n in names:
                code, msg = ctx.wal.retrieve_segment(n, os.path.join(tmp, n))
                if code != 0:
                    raise EngineError("PGA-WAL-050", "cannot read archived segment %s: %s" % (n, msg))
            args = [exe, "-p", tmp, "-t", str(int(tli, 16)), names[0], names[-1]]
            r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, encoding="utf-8", errors="replace")
            for line in (r.stdout or "").splitlines():
                m_lsn = re.search(r"lsn: ([0-9A-F]+/[0-9A-F]+)", line)
                m_xid = re.search(r"tx:\s*(\d+)", line)
                lsn = m_lsn.group(1) if m_lsn else "?"
                if line.startswith("rmgr: Transaction") and "rels:" in line:
                    rels = re.findall(r"(?:base|pg_tblspc/\d+/[^/]+)/(\d+)/(\d+)", line.split("rels:", 1)[1])
                    mt = re.search(r"(?:COMMIT|COMMIT PREPARED)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)? \S+)", line)
                    if rels:
                        events.append({"lsn": lsn, "xid": m_xid.group(1) if m_xid else "?", "time": mt.group(1) if mt else "?", "kind": "DROP", "rels": rels})
                elif line.startswith("rmgr: Storage") and "TRUNCATE" in line:
                    rels = re.findall(r"(\d+)/(\d+)/(\d+)", line.split("desc:", 1)[-1])
                    if rels:
                        events.append({"lsn": lsn, "xid": "?", "time": "?", "kind": "TRUNCATE", "rels": [(r[1], r[2]) for r in rels]})
                elif line.startswith("rmgr: Database") and "DROP" in line:
                    events.append({"lsn": lsn, "xid": m_xid.group(1) if m_xid else "?", "time": "?", "kind": "DROP DATABASE", "rels": [],
                                   "detail": line.split("desc:", 1)[-1].strip()})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    cat = None
    try:
        cat = ctx.repo.load_catalog(ctx.repo.resolve_set("latest"))
    except EngineError:
        pass
    names = {}
    if cat:
        for dbname, d in cat["databases"].items():
            for r in d["relations"]:
                names[(str(d["oid"]), str(r["relfilenode"]))] = "%s.%s.%s" % (dbname, r["schema"], r["name"])
    out = []
    for e in events[-limit:]:
        e["names"] = [names.get((str(a), str(b)), "%s/%s" % (a, b)) for a, b in e["rels"]][:6]
        e["rels"] = [list(x) for x in e["rels"]][:6]
        out.append(e)
    res = {"segments_scanned": len(segs), "events": out}
    if out:
        last = out[-1]
        res["suggestion"] = {"target_lsn": last["lsn"], "inclusive": False, "note": "restoring with this LSN and inclusive=false stops just BEFORE the last event"}
    return res


# --------------------------------------------------------------------------- catalog browsing (restore wizard)
SYSTEM_SCHEMAS = ("pg_catalog", "information_schema", "pg_toast")


def user_objects(d):
    """The user tables / partitioned tables / materialized views of a database catalog, with their REAL footprint.
    total = heap + TOAST + indexes (of the table and of its TOAST) [+ all partitions for a partitioned table]. Computed from the sizes already in the catalog:
    no extra I/O on the source. Partitions are folded into their parent (`partitions` = how many). Catalogs written by an older engine lack the index/partition
    links: totals are then heap + TOAST only and `approx` is true."""
    rels = d.get("relations", [])
    by_oid = dict((r["oid"], r) for r in rels)
    linked = any("index_of" in r for r in rels)
    extra = {}
    for r in rels:
        if r.get("index_of"):
            extra[r["index_of"]] = extra.get(r["index_of"], 0) + r["size"]
    kids = {}
    for r in rels:
        if r.get("parent"):
            kids.setdefault(r["parent"], []).append(r)

    def own(r):
        t = r["size"] + extra.get(r["oid"], 0)
        tr = by_oid.get(r.get("toast") or 0)
        return t + ((tr["size"] + extra.get(tr["oid"], 0)) if tr else 0)

    def total(r, depth=0):
        return own(r) + (sum(total(k, depth + 1) for k in kids.get(r["oid"], ())) if depth < 8 else 0)

    out = []
    for r in rels:
        if r["kind"] not in ("r", "p", "m") or r["schema"] in SYSTEM_SCHEMAS or r.get("parent"):
            continue
        out.append({"schema": r["schema"], "name": r["name"], "kind": r["kind"], "size": total(r), "heap": r["size"],
                    "partitions": len(kids.get(r["oid"], ())), "oid": r["oid"], "persistence": r.get("persistence")})
    return out, (not linked)


def ensure_retention_floor(ctx):
    """An archive whose retention ran before the floor marker existed (older agent): write the floor now from the oldest backup still kept - by this stanza
    or by a sibling sharing the archive - so that legitimately removed segments are not reported as holes. Never lowers an existing floor."""
    if ctx.wal.retention_floor():
        return None
    repo = ctx.repo
    done = [x for x in repo.sets() if x.get("status") == "COMPLETE" and x.get("start_lsn")]
    if not done:
        return None
    floor_lsn = min([min(lsn_to_int(x["start_lsn"]) for x in done)] + _sibling_floors(repo, done))
    seg = done[0].get("wal_segment_size") or ctx.seg_size
    floor = wal_segno(floor_lsn, seg)
    ctx.wal.set_retention_floor(floor, "%X/%08X" % (floor_lsn >> 32, floor_lsn & 0xFFFFFFFF))
    return floor


def catalog_all(ctx, max_sets=12):
    """Databases of the newest backups merged: every database that was in ANY of them, described by the newest set that holds it (`last_set`, `last_stop`) and flagged
    `in_latest`. A database that is in older backups but not in the latest one was dropped before the latest backup: it can still be restored from the older one."""
    sets = ctx.repo.complete_sets()
    if not sets:
        raise EngineError("PGA-REPO-020", "no complete backup in stanza '%s'" % ctx.repo.stanza, "run a full backup first")
    sets = sets[-max_sets:]
    out, latest = {}, sets[-1]
    for s in reversed(sets):
        try:
            cat = ctx.repo.load_catalog(s)
        except EngineError:
            continue
        for n, d in cat["databases"].items():
            if n in out:
                out[n]["sets"] += 1
                out[n]["first_stop"] = s.get("stop_time")
                continue
            objs, approx = user_objects(d)
            out[n] = {"name": n, "oid": d["oid"], "size": d["size"], "connectable": d.get("connectable", True),
                      "tables": len([o for o in objs if o["kind"] in ("r", "p")]), "matviews": len([o for o in objs if o["kind"] == "m"]),
                      "objects": len(objs), "schemas": len(set(o["schema"] for o in objs)), "user_bytes": sum(o["size"] for o in objs), "approx": approx,
                      "in_latest": s["id"] == latest["id"], "last_set": s["id"], "last_stop": s.get("stop_time"), "first_stop": s.get("stop_time"), "sets": 1}
    return {"set": "all", "latest": latest["id"], "latest_stop": latest.get("stop_time"), "captured": latest.get("stop_time"), "databases": [out[k] for k in sorted(out)]}


def catalog_browse(ctx, set_spec=None, database=None, search="", limit=2000):
    """Databases of a set (with correct counts: user tables only, no system catalogs, no partitions double-counted); or, for one database, its schemas/objects
    (largest first, capped) with their real size (heap + TOAST + indexes + partitions)."""
    if set_spec == "all" and not database:
        return catalog_all(ctx)
    s = ctx.repo.resolve_set(set_spec)
    cat = ctx.repo.load_catalog(s)
    if not database:
        dbs = []
        for n, d in sorted(cat["databases"].items()):
            objs, approx = user_objects(d)
            dbs.append({"name": n, "oid": d["oid"], "size": d["size"], "connectable": d.get("connectable", True),
                        "tables": len([o for o in objs if o["kind"] in ("r", "p")]), "matviews": len([o for o in objs if o["kind"] == "m"]),
                        "objects": len(objs), "schemas": len(set(o["schema"] for o in objs)), "user_bytes": sum(o["size"] for o in objs), "approx": approx})
        return {"set": s["id"], "captured": cat.get("captured"), "databases": dbs}
    d = cat["databases"].get(database)
    if not d:
        raise EngineError("PGA-GEN-031", "database '%s' is not in backup %s" % (database, s["id"]))
    q = (search or "").lower()
    objs, approx = user_objects(d)
    allrels = d.get("relations", [])
    by_oid = dict((r["oid"], r) for r in allrels)
    kids = {}
    for r in allrels:
        if r.get("parent") and r["kind"] in ("r", "p"):
            kids.setdefault(r["parent"], []).append(r)
    sizes = {}
    for o in objs:
        sizes[o["oid"]] = o["size"]

    def parts_of(oid, depth=0):
        """Partitions (any depth) of a partitioned table: each can be restored alone (it is attached again to the live parent)."""
        out = []
        for k in sorted(kids.get(oid, ()), key=lambda x: x["name"]):
            out.append({"name": k["name"], "kind": k["kind"], "depth": depth, "parent": by_oid.get(oid, {}).get("name")})
            if depth < 6:
                out += parts_of(k["oid"], depth + 1)
        return out
    views = [{"schema": r["schema"], "name": r["name"], "kind": "v", "size": 0, "partitions": 0, "oid": r["oid"]}
             for r in allrels if r["kind"] == "v" and r["schema"] not in SYSTEM_SCHEMAS]
    rels = [o for o in objs + views if not q or q in o["name"].lower() or q in o["schema"].lower()
            or (o["partitions"] and any(q in x["name"].lower() for x in parts_of(o["oid"])))]
    rels.sort(key=lambda r: -r["size"])
    schemas = {}
    for r in rels[:limit]:
        e = {"name": r["name"], "kind": r["kind"], "size": r["size"], "partitions": r["partitions"]}
        if r["partitions"]:
            e["parts"] = parts_of(r["oid"])[:500]
        schemas.setdefault(r["schema"], []).append(e)
    return {"set": s["id"], "database": database, "oid": d["oid"], "approx": approx,
            "schemas": [{"name": k, "objects": v, "tables": len([o for o in v if o["kind"] in ("r", "p")]), "bytes": sum(o["size"] for o in v)} for k, v in sorted(schemas.items())],
            "total_objects": len(rels), "truncated": len(rels) > limit}
