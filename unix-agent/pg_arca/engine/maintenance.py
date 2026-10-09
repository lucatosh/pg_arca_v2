"""Repository inspection and care: info, verify (shallow/deep), expire (retention + CAS GC + WAL), forensics."""

import os
import re
import shutil
import subprocess
import tempfile
import time

from pg_arca.engine.backup import build_chain
from pg_arca.engine.repo import GC_GRACE
from pg_arca.engine.util import EngineError, lsn_to_int, parse_wal_name, read_json, wal_name, wal_segno


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
    total = 0
    n = 0
    for root, _, files in os.walk(repo.p("cas")):
        for f in files:
            if ".tmp." in f:
                continue
            try:
                total += os.path.getsize(os.path.join(root, f))
                n += 1
            except OSError:
                pass
    logical = sum((s.get("stats") or {}).get("bytes_logical", 0) for s in sets if s.get("status") == "COMPLETE")
    out["cas"] = {"chunks": n, "stored_bytes": total, "logical_bytes": logical, "ratio": round(logical / float(max(total, 1)), 2)}
    done = [s for s in sets if s.get("status") == "COMPLETE"]
    if done:
        out["recovery_window"] = {"from": done[0].get("start_time"), "to": "latest archived WAL" if out["wal"]["segments"] else done[-1].get("stop_time")}
    return out


# --------------------------------------------------------------------------- verify
def verify(ctx, deep=False, progress=None, cancel=None):
    repo = ctx.repo
    problems, report = [], []
    sets = repo.sets()
    checked_chunks = 0
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
        missing = bad = 0
        for rel, e in man["files"].items():
            for off, ln, h in e["chunks"]:
                p = repo.cas_path(h)
                if not os.path.exists(p):
                    missing += 1
                    continue
                if deep:
                    checked_chunks += 1
                    try:
                        repo.get_chunk(h)
                    except EngineError:
                        bad += 1
                    if progress and checked_chunks % 500 == 0:
                        progress({"phase": "verify", "chunks": checked_chunks})
                    if cancel and cancel():
                        raise EngineError("PGA-GEN-099", "cancelled")
        if missing or bad:
            problems.append("%s: %d missing, %d corrupt chunks" % (s["id"], missing, bad))
        entry.update(files=len(man["files"]), missing=missing, corrupt=bad)
        entry["problems"] += missing + bad
        # WAL needed for this set
        seg = s.get("wal_segment_size") or ctx.seg_size
        miss = [wal_name(s["timeline"], n, seg) for n in range(wal_segno(lsn_to_int(s["start_lsn"]), seg), wal_segno(lsn_to_int(s["stop_lsn"]), seg) + 1)
                if not ctx.wal.has_segment(wal_name(s["timeline"], n, seg))]
        if miss:
            problems.append("%s: %d WAL segment(s) between start and stop are not archived (first %s)" % (s["id"], len(miss), miss[0]))
            entry["problems"] += len(miss)
        report.append(entry)
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


def expire(ctx, dry_run=False, retention_full=None, retention_days=None):
    repo = ctx.repo
    keep_full = int(retention_full if retention_full is not None else ctx.retention_full)
    days = int(retention_days if retention_days is not None else ctx.retention_days)
    if keep_full < 1:
        raise EngineError("PGA-GEN-066", "retention_full must be >= 1")
    with repo.lock("stanza", "expire"):
        sets = repo.sets()
        done = [s for s in sets if s.get("status") == "COMPLETE"]
        fulls = [s for s in done if s["type"] == "full"]
        doomed_fulls = fulls[:max(0, len(fulls) - keep_full)]
        if days and doomed_fulls:
            cutoff = time.time() - days * 86400
            doomed_fulls = [f for f in doomed_fulls if (f.get("started_ts") or 0) < cutoff]
        doomed = []
        for f in doomed_fulls:
            doomed += _dependents(sets, f)
        # failed / unrecoverable / pending leftovers are always collectable
        junk = [s for s in sets if s.get("status") in ("FAILED", "UNRECOVERABLE", "RUNNING", "PENDING_WAL", "EXPIRING") and s not in doomed]
        doomed_ids = set(s["id"] for s in doomed) | set(s["id"] for s in junk)
        keep = [s for s in done if s["id"] not in doomed_ids]
        oldest_lsn = min((lsn_to_int(s["start_lsn"]) for s in keep), default=None)
        plan = {"delete_sets": sorted(doomed_ids), "keep_sets": [s["id"] for s in keep], "retention_full": keep_full}
        if oldest_lsn is not None:
            plan["wal_keep_from_lsn"] = "%X/%08X" % (oldest_lsn >> 32, oldest_lsn & 0xFFFFFFFF)
        if dry_run:
            plan["dry_run"] = True
            return plan
        for s in doomed + junk:                                      # mark first: a crash mid-delete leaves a recognisable EXPIRING set
            m = repo.set_meta(s["id"])
            if m:
                m["status"] = "EXPIRING"
                repo.write_meta(m)
        for sid in doomed_ids:
            shutil.rmtree(repo.sp("backup", sid), ignore_errors=True)
        freed, removed = _gc_cas(repo)
        walrm = 0
        if oldest_lsn is not None:
            seg = keep[0].get("wal_segment_size") or ctx.seg_size
            floor = wal_segno(oldest_lsn, seg)
            for name in ctx.wal.list_segments():
                p = parse_wal_name(name, seg)
                if p and p[1] < floor:
                    ctx.wal.remove_segment(name)
                    walrm += 1
        plan.update(chunks_removed=removed, bytes_freed=freed, wal_removed=walrm)
        return plan


def _gc_cas(repo):
    """Mark & sweep over EVERY stanza in the repository (chunks are shared). Young chunks are never swept (GC grace)."""
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
                man = read_json(mp, compressed=True)
            except Exception:
                raise EngineError("PGA-REPO-050", "cannot read manifest %s: refusing to garbage-collect (would risk deleting live chunks)" % mp)
            for e in man["files"].values():
                for _, _, h in e["chunks"]:
                    live.add(h)
    now = time.time()
    freed = removed = 0
    for root, _, files in os.walk(repo.p("cas")):
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
    return freed, removed


# --------------------------------------------------------------------------- forensics
def forensics(ctx, limit=20, since=None, until=None):
    """Locate DROP / TRUNCATE events in archived WAL (pg_waldump) and map relfilenodes back to names via the catalog."""
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
            r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
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
def catalog_browse(ctx, set_spec=None, database=None, search="", limit=2000):
    """Databases of a set; or, for one database, its schemas/objects (largest first, capped)."""
    s = ctx.repo.resolve_set(set_spec)
    cat = ctx.repo.load_catalog(s)
    if not database:
        return {"set": s["id"], "captured": cat.get("captured"),
                "databases": [{"name": n, "oid": d["oid"], "size": d["size"], "objects": len([r for r in d["relations"] if r["kind"] in ("r", "p", "m")]),
                               "connectable": d.get("connectable", True)} for n, d in sorted(cat["databases"].items())]}
    d = cat["databases"].get(database)
    if not d:
        raise EngineError("PGA-GEN-031", "database '%s' is not in backup %s" % (database, s["id"]))
    q = (search or "").lower()
    rels = [r for r in d["relations"] if r["kind"] in ("r", "p", "m") and r["schema"] not in ("pg_catalog", "information_schema", "pg_toast")
            and (not q or q in r["name"].lower() or q in r["schema"].lower())]
    rels.sort(key=lambda r: -r["size"])
    schemas = {}
    for r in rels[:limit]:
        schemas.setdefault(r["schema"], []).append({"name": r["name"], "kind": r["kind"], "size": r["size"]})
    return {"set": s["id"], "database": database, "oid": d["oid"], "schemas": [{"name": k, "objects": v} for k, v in sorted(schemas.items())],
            "total_objects": len(rels), "truncated": len(rels) > limit}
