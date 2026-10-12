"""Restore: chain merge, parallel verified materialization, sparse (single-DB) extraction, skeletonization, recovery config."""

import datetime
import os
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from pg_arca.engine.backup import _check_cancel, build_chain
from pg_arca.pgcompat import Profile, require_supported, set_profile
from pg_arca.engine.pgdata import list_directories
from pg_arca.engine.safety import assert_writable_target, audit_symlinks
from pg_arca.engine.util import (parse_wal_name, last_wal_segno, EngineError, chunk_hash, human, iso, lsn_to_int, parse_target_time, safe_relpath, target_time_to_dt, wal_name,
                                 wal_segno, read_json, write_json)


# --------------------------------------------------------------------------- planning
def merge_chain(repo, chain, include=None):
    """Final file set = files of the LAST manifest; chunks are layered full -> ... -> last (later wins, by byte offset).
    Files deleted before the last set never reappear; 'whole' files are replaced, never layered."""
    mans = [repo.load_manifest(s) for s in chain]
    final = mans[-1]["files"]
    merged = {}
    for rel, e in final.items():
        if include and not include(rel):
            continue
        merged[rel] = {"size": e["size"], "mode": e["mode"], "kind": e["kind"], "chunks": {}, "origin": e.get("origin")}
    for m in mans:
        for rel, e in m["files"].items():
            tgt = merged.get(rel)
            if tgt is None:
                continue
            if e["kind"] == "whole" or tgt["kind"] == "whole":
                if m is mans[-1]:
                    tgt["chunks"] = {off: (ln, h) for off, ln, h in e["chunks"]}
                continue
            for off, ln, h in e["chunks"]:
                tgt["chunks"][off] = (ln, h)
    return merged, mans[-1].get("tablespaces", {})


def tablespaces_created_in_window(ctx, chain, target_lsn=None):
    """CREATE TABLESPACE records the recovery of `chain` will replay (from the base backup's start, up to target_lsn when known). Their replay works on
    the ABSOLUTE location written in the WAL - not on a relocated copy - and PostgreSQL REMOVES an existing version directory there: on the production
    server that is production's own tablespace. Returns [{"oid", "path", "lsn"}]."""
    from pg_arca.engine import walscan
    start = chain[0].get("start_time") if chain else None
    try:
        r = walscan.scan(ctx, mode="tablespaces", hours=0, since_iso=start, limit=1000, budget_sec=600, cache_dir=getattr(ctx, "forensics_cache", None))
    except EngineError as e:
        if e.code == "PGA-WAL-002":                         # no WAL in the window: nothing to replay
            return []
        return _tablespaces_after_full_live(ctx, chain, e)
    out = []
    base = lsn_to_int(chain[0].get("start_lsn") or "0/0") if chain else 0
    hi = lsn_to_int(target_lsn) if target_lsn else None
    for e in r.get("created") or []:
        v = lsn_to_int(e["lsn"])
        if v < base or (hi is not None and v >= hi):
            continue
        out.append({"oid": e["rels"][0][0], "path": e.get("path"), "lsn": e["lsn"]})
    return out


def _tablespaces_after_full_live(ctx, chain, why):
    """The WAL could not be read (no pg_waldump, archive unreadable): decide from what is certain instead - the tablespaces of the LIVE server that the
    base full does not know were created after it, and their paths are the dangerous ones on this host."""
    try:
        known = set(str(k) for k in (ctx.repo.load_catalog(chain[0]).get("tablespaces") or {}).keys())
        from pg_arca.engine.pgsession import PgSession
        s = PgSession(ctx.conn.with_db("postgres"), read_only=True)
        try:
            rows = s.query("SELECT oid::text, pg_tablespace_location(oid) FROM pg_tablespace WHERE spcname NOT IN ('pg_default', 'pg_global')")
        finally:
            s.close()
        ctx.log("warning", "WAL not readable for the tablespace check (%s): using the live server's tablespaces" % getattr(why, "message", why))
        return [{"oid": r[0], "path": r[1], "lsn": "?"} for r in rows if r and r[0] not in known]
    except Exception as e:                                  # nothing certain at all: the restore must not run blind on a host with tablespaces
        raise EngineError("PGA-RST-052", "cannot verify whether the recovery would replay CREATE TABLESPACE on a live path: %s" % getattr(why, "message", why),
                          "make pg_waldump available to the agent, or take a new FULL backup")


def guard_created_tablespaces(created, where):
    """None when replaying `created` is harmless here; else an EngineError to raise (the location is IN USE on this host)."""
    def in_use(p):
        try:
            return os.path.isdir(p) and any(x.startswith("PG_") for x in os.listdir(p))      # a version directory = a tablespace lives there
        except OSError:
            return True                                    # cannot look: assume the worst
    live = [t for t in (created or []) if t.get("path") and in_use(t["path"])]
    if not live:
        return None
    t = live[0]
    return EngineError("PGA-RST-050", "the recovery would replay CREATE TABLESPACE for %s (created after the base backup, at %s): PostgreSQL replays it on that "
                                      "ABSOLUTE path and removes what it finds there - on this server that is the live tablespace. Refused on %s." % (t["path"], t["lsn"], where),
                       "take a new FULL backup (the tablespace is then part of it and is relocated safely; the scheduler starts one by itself), choose a point in "
                       "time before it was created, or run the recovery on a central recovery host where that path does not exist")


def system_db_oids(cat):
    """Databases a partial (sparse) recovery always needs: template1 (OID 1, CREATE DATABASE) and the 'postgres' database (where connections land).
    'postgres' has the fixed OID 5 only since PostgreSQL 15; up to 14 it gets an OID assigned at initdb (e.g. 13780): read it from the backup catalog.
    Without it a PostgreSQL 14 recovery instance refused every connection ("could not open file base/13780/1259")."""
    out = {1}
    dbs = (cat or {}).get("databases") or {}
    pg = dbs.get("postgres") if isinstance(dbs, dict) else None
    out.add(int(pg["oid"]) if isinstance(pg, dict) and pg.get("oid") else 5)
    return out


def sparse_filter(keep_oids):
    keep = set(int(x) for x in keep_oids)

    def f(rel):
        m = re.match(r"^base/(\d+)/(.+)$", rel)
        if m:
            if int(m.group(1)) in keep:
                return True
            return m.group(2) in ("PG_VERSION", "pg_filenode.map")        # every DB dir keeps the two files a connection needs
        m = re.match(r"^pg_tblspc/\d+/[^/]+/(\d+)/", rel)
        if m:
            return int(m.group(1)) in keep
        if rel.startswith("_conf/"):
            return True
        return True
    return f


def estimate(merged):
    return sum(v["size"] for v in merged.values())


# --------------------------------------------------------------------------- materialization
def _write_one(repo, dest, rel, info, delta):
    safe_relpath(rel)
    out = os.path.join(dest, rel)
    os.makedirs(os.path.dirname(out), mode=0o700, exist_ok=True)
    size = info["size"]
    written = 0
    exists = delta and os.path.isfile(out)
    mode = "r+b" if exists else "wb"
    with open(out, mode) as f:
        for off in sorted(info["chunks"]):
            ln, h = info["chunks"][off]
            if off >= size:
                continue
            if exists:
                f.seek(off)
                cur = f.read(ln)
                if len(cur) == ln and repo.hash(cur) == h:
                    continue                                              # delta: identical range, skip the write
            data = repo.get_chunk(h)
            if off + len(data) > size:
                data = data[:size - off]
            f.seek(off)
            f.write(data)
            written += len(data)
        f.truncate(size)
    try:
        os.chmod(out, info["mode"] & 0o777)
    except OSError:
        pass
    return written


def materialize(ctx, merged, dest, delta=False, progress=None, cancel=None):
    repo = ctx.repo
    total = len(merged)
    total_bytes = estimate(merged)
    state = {"files": 0, "bytes": 0}
    t0 = time.time()
    last = [0.0]
    lock = threading.Lock()

    def work(item):
        rel, info = item
        _check_cancel(cancel)
        n = _write_one(repo, dest, rel, info, delta)
        with lock:
            state["files"] += 1
            state["bytes"] += info["size"]
        return n

    items = sorted(merged.items(), key=lambda kv: -kv[1]["size"])
    written = 0
    with ThreadPoolExecutor(max_workers=ctx.process_max) as pool:
        for i in range(0, len(items), 512):
            for n in pool.map(work, items[i:i + 512]):
                written += n
            if progress and time.time() - last[0] > 1.0:
                last[0] = time.time()
                progress({"phase": "extract", "files": state["files"], "files_total": total, "bytes": state["bytes"], "bytes_total": total_bytes,
                          "pct": int(100.0 * state["bytes"] / max(total_bytes, 1))})
    os.sync()
    return {"files": total, "bytes": total_bytes, "bytes_written": written, "seconds": round(time.time() - t0, 2)}


def remove_stale(dest, merged):
    """--delta: delete files that are not part of the restored set (never directories' roots)."""
    keep = set(merged)
    removed = 0
    for cur, dirs, files in os.walk(dest, followlinks=False):
        rel_root = os.path.relpath(cur, dest)
        rel_root = "" if rel_root == "." else rel_root
        if rel_root.startswith("pg_wal"):
            continue
        for f in files:
            rel = (rel_root + "/" + f) if rel_root else f
            if rel not in keep and f not in ("backup_label", "recovery.signal", "tablespace_map", RESUME_MARK):
                try:
                    os.unlink(os.path.join(cur, f))
                    removed += 1
                except OSError:
                    pass
    return removed


def prepare_skeleton(dest, catalog, keep_oids=()):
    """Directory skeleton required by recovery (service dirs + one dir per database)."""
    pgver = ""
    try:
        pgver = open(os.path.join(dest, "PG_VERSION")).read().strip()
    except (IOError, OSError):
        pass
    made = 0
    for name, d in catalog["databases"].items():
        bd = os.path.join(dest, "base", str(d["oid"]))
        if not os.path.isdir(bd):
            os.makedirs(bd, mode=0o700, exist_ok=True)
            made += 1
        pv = os.path.join(bd, "PG_VERSION")
        if not os.path.exists(pv) and pgver:
            with open(pv, "w") as fh:
                fh.write(pgver + "\n")
    for d in list_directories(dest):
        os.makedirs(os.path.join(dest, d), mode=0o700, exist_ok=True)
    return made


# preloaded libraries whose background workers act on OTHER servers (or replay a schedule) as soon as a copy starts: pg_cron connects to the
# nodename:nodeport stored in each job (localhost:5432 = production when the copy runs on the same host), pglogical / pgactive / bdr connect to
# their peers. A restored COPY starts without them; security libraries (anon, sepgsql, passwordcheck, ...) and the rest are kept.
COPY_BLOCKED_LIBS = ("pg_cron", "pglogical", "pgactive", "bdr", "pg_partman_bgw", "pg_background", "pg_squeeze", "timescaledb_osm")


def copy_preload_filter(value):
    """shared_preload_libraries value -> (new value or None when nothing to remove, removed list)."""
    libs = [x.strip().strip('"') for x in (value or "").split(",") if x.strip()]
    gone = [x for x in libs if os.path.basename(x).split(".")[0] in COPY_BLOCKED_LIBS]
    if not gone:
        return None, []
    return ",".join(x for x in libs if x not in gone), gone


def _conf_preload(dest):
    """Last shared_preload_libraries set in the restored postgresql.conf / postgresql.auto.conf (backups older than the catalog setting)."""
    val = None
    for fn in ("postgresql.conf", "postgresql.auto.conf"):
        try:
            for line in open(os.path.join(dest, fn), errors="replace"):
                m = re.match(r"^\s*shared_preload_libraries\s*=?\s*'([^']*)'", line)
                if m:
                    val = m.group(1)
        except OSError:
            continue
    return val


def flush_current_wal(ctx, chain, target_time=None, target_lsn=None, target_xid=None, target_name=None, wait=90, cancel=None):
    """A target of 'now' (or of the last minutes) needs the WAL the source has not archived yet: with archive_timeout = 60 the last seconds may be
    only in the current segment, and the recovery would stop earlier ('target clamped'). When the backed-up server is reachable here as a PRIMARY
    (same system identifier as the backups), the segment is switched and its archiving awaited. Never fatal; returns what happened or None."""
    if target_lsn or target_xid or target_name:
        return None                                 # explicit positions: the user knows where they are (and recent ones are flushed by the scan anyway)
    if target_time:
        try:
            dt = target_time_to_dt(parse_target_time(target_time))
            if (datetime.datetime.now(datetime.timezone.utc) - dt).total_seconds() > 900:
                return None                         # long archived already
        except Exception:
            return None
    from pg_arca.engine.pgsession import PgSession
    try:
        s = PgSession(ctx.conn.with_db("postgres"))
    except Exception:
        return None
    try:
        sysid = s.scalar("SELECT system_identifier FROM pg_control_system()")
        if not chain or str(chain[0].get("system_identifier") or "") != str(sysid or "-"):
            return None                             # another cluster (a central recovery host's own PostgreSQL): never touched
        if s.scalar("SELECT pg_is_in_recovery()") != "f":
            return None
        name = s.scalar("SELECT pg_walfile_name(pg_switch_wal())")
    except EngineError:
        return None
    finally:
        s.close()
    t0 = time.time()
    while time.time() - t0 < wait:
        if name and ctx.wal.has_segment(name, anywhere=False):
            return {"segment": name, "archived": True, "seconds": round(time.time() - t0, 1)}
        _check_cancel(cancel)
        time.sleep(0.5)
    return {"segment": name, "archived": False, "seconds": wait}


def ensure_tablespace_version_dirs(datadir, tablespaces, files, major, catversion=None):
    """Create pg_tblspc/<oid>/PG_<major>_<catversion> for every tablespace. The manifest lists files, not directories: a tablespace that was empty at
    backup time (or whose files all belong to databases a sparse recovery leaves out) would otherwise have no version directory, and a CREATE DATABASE
    replayed into it after the consistency point makes PostgreSQL 15+ PANIC ('missing directory'); before 15 the copy fails the same way."""
    names = {}
    for rel in files:
        m = re.match(r"^pg_tblspc/(\d+)/([^/]+)/", rel)
        if m:
            names.setdefault(m.group(1), set()).add(m.group(2))
    made = []
    for oid in (tablespaces or {}):
        want = names.get(str(oid)) or ({"PG_%s_%s" % (major, catversion)} if catversion and major else set())
        for n in want:
            p = os.path.join(datadir, "pg_tblspc", str(oid), n)
            if not os.path.isdir(p):
                os.makedirs(p, mode=0o700, exist_ok=True)
                made.append(p)
    return made


def link_tablespaces(dest, tablespaces, remap=None):
    """pg_tblspc/<oid> -> location. `remap` {oid: newdir}; locations must not collide with protected paths (checked by caller)."""
    remap = remap or {}
    os.makedirs(os.path.join(dest, "pg_tblspc"), mode=0o700, exist_ok=True)
    out = {}
    for oid, target in tablespaces.items():
        tgt = remap.get(str(oid)) or target
        os.makedirs(tgt, mode=0o700, exist_ok=True)
        link = os.path.join(dest, "pg_tblspc", str(oid))
        if os.path.islink(link) or os.path.exists(link):
            if os.path.islink(link):
                os.unlink(link)
            else:
                continue
        os.symlink(tgt, link)
        out[str(oid)] = tgt
    return out


_UNSAFE_CONF = re.compile(r"^\s*(data_directory|hba_file|ident_file|external_pid_file|include_dir|include_if_exists|include)\b", re.I)


def neutralize_conf(path):
    """A postgresql.conf captured from an external layout (Debian: /etc/postgresql/NN/main) still points at the ORIGINAL data directory / hba / include dir.
    Starting the restored copy with those lines would open the production cluster (or fail on a missing conf.d): comment them out, keep a visible note."""
    with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
        lines = f.read().split("\n")
    out, hit = [], 0
    for ln in lines:
        if _UNSAFE_CONF.match(ln):
            out.append("#pg_arca-restore# " + ln)
            hit += 1
        else:
            out.append(ln)
    if hit:
        out.append("# pg_arca: %d line(s) above were disabled on restore (data_directory/hba_file/ident_file/include*): they pointed at the original server." % hit)
        tmp = path + ".pgarca-tmp"
        with open(tmp, "w", encoding="utf-8", errors="surrogateescape") as f:
            f.write("\n".join(out))
        shutil.copystat(path, tmp)
        os.rename(tmp, path)
    return hit


_STALE_RECOVERY = re.compile(r"^\s*(recovery_target\w*|restore_command|recovery_end_command|archive_cleanup_command)\s*=", re.I)


def scrub_recovery_settings(dest):
    """A backed-up postgresql.auto.conf may still hold a previous restore's recovery_target_* / restore_command block: appending ours would leave two targets
    ('multiple recovery targets specified') or silently keep the old one. Comment the old ones out (postgresql.conf and postgresql.auto.conf)."""
    for fn in ("postgresql.conf", "postgresql.auto.conf"):
        path = os.path.join(dest, fn)
        if not os.path.isfile(path):
            continue
        with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
            lines = f.read().split("\n")
        changed, out = False, []
        for ln in lines:
            if _STALE_RECOVERY.match(ln):
                out.append("#pg_arca-restore# " + ln)
                changed = True
            else:
                out.append(ln)
        if changed:
            with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
                f.write("\n".join(out))


def install_external_conf(dest, merged_all):
    """Config files that lived outside PGDATA were captured as _conf/*: place missing ones at the PGDATA root (neutralised, see above)."""
    for rel in list(merged_all):
        if rel.startswith("_conf/"):
            name = rel[len("_conf/"):]
            src = os.path.join(dest, rel)
            tgt = os.path.join(dest, name)
            if os.path.exists(src) and not os.path.exists(tgt):
                shutil.copy2(src, tgt)
                if name == "postgresql.conf":
                    neutralize_conf(tgt)


# --------------------------------------------------------------------------- recovery configuration
def recovery_lines(restore_command, target_time=None, target_lsn=None, target_xid=None, target_name=None, immediate=False,
                   action="promote", inclusive=True, timeline="latest"):
    q = lambda v: "'%s'" % str(v).replace("'", "''")
    if target_time:
        from pg_arca.engine.util import _pg_time
        target_time = _pg_time(str(target_time).strip())
    lines = ["", "# ==== pg_arca recovery (generated %s) ====" % iso(), "restore_command = %s" % q(restore_command),
             "recovery_target_timeline = %s" % q(timeline)]
    targets = [(k, v) for k, v in (("recovery_target_time", target_time), ("recovery_target_lsn", target_lsn),
                                   ("recovery_target_xid", target_xid), ("recovery_target_name", target_name)) if v]
    if immediate:
        lines.append("recovery_target = 'immediate'")
    for k, v in targets:
        lines.append("%s = %s" % (k, q(v)))
    if targets or immediate:
        lines.append("recovery_target_action = %s" % q(action))
        if targets:
            lines.append("recovery_target_inclusive = %s" % ("on" if inclusive else "off"))
    return "\n".join(lines) + "\n"


def _free_bytes(path):
    """Free space (for an unprivileged writer) of the filesystem that will hold `path`, looking at its nearest existing ancestor."""
    p = os.path.abspath(path)
    while p and not os.path.exists(p):
        np_ = os.path.dirname(p)
        if np_ == p:
            break
        p = np_
    try:
        st = os.statvfs(p)
        return st.f_bavail * st.f_frsize
    except OSError:
        return None


def effective_targets(chain, target_lsn, immediate, ctx=None):
    """'Stop as soon as consistent' means: at the END OF THE LAST SET of the chain. The backup_label is the base full's, so PostgreSQL's own notion of
    'consistent' is the end of the FULL, while the files already contain the later incremental pages: stopping there would promote a torn cluster."""
    if immediate and len(chain) > 1:
        return _end_of_set_target(ctx, chain[-1]), False
    return target_lsn, immediate


def _end_of_set_target(ctx, meta):
    """recovery_target_lsn that stops exactly after the last record a set needs. PostgreSQL stops after the first record whose START is >= the target, so a stop LSN
    that is the END of the final record (a standby's minimum recovery point, typically right after a WAL switch: exactly a segment boundary) would never be reached
    when nothing follows it in the archive: 'recovery ended before configured recovery target was reached'. In that case aim at the start of the last record."""
    stop = meta["stop_lsn"]
    if ctx is None or not meta.get("from_standby"):
        return stop
    seg = int(meta.get("wal_segment_size") or ctx.seg_size)
    v = lsn_to_int(stop)
    if v <= 0 or v % seg != 0:
        return stop
    try:
        last = _last_record_start(ctx, int(meta.get("timeline") or 1), (v - 1) // seg, seg)
    except Exception as e:                                                      # best effort: keep the previous behaviour rather than fail the restore here
        ctx.log("warning", "cannot locate the last WAL record of the set (%s): using its stop LSN" % e)
        return stop
    return last or stop


def _last_record_start(ctx, tli, segno, seg):
    """Start LSN of the last record of one archived WAL segment, found with pg_waldump on a temporary copy. None when pg_waldump is unavailable."""
    import subprocess
    import tempfile
    exe = ctx.conn.exe("pg_waldump")
    if os.path.sep in exe and not os.path.exists(exe):
        return None
    name = wal_name(tli, segno, seg)
    tmp = tempfile.mkdtemp(prefix="pgarca-wd-", dir=ctx.scratch_dir if os.path.isdir(ctx.scratch_dir) else None)
    try:
        f = os.path.join(tmp, name)
        rc, msg = ctx.wal.retrieve_segment(name, f)
        if rc != 0:
            raise EngineError("PGA-WAL-022", "segment %s not available: %s" % (name, msg))
        p = subprocess.Popen([exe, f], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        last = None
        for line in p.stdout:
            m = re.search(r"\blsn: ([0-9A-Fa-f]+/[0-9A-Fa-f]+)", line)
            if m:
                last = m.group(1)
        p.wait()
        return last
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def count_targets(target_time, target_lsn, target_xid, target_name, immediate=False):
    n = sum(1 for x in (target_time, target_lsn, target_xid, target_name) if x) + (1 if immediate else 0)
    if n > 1:
        raise EngineError("PGA-PITR-002", "more than one recovery target given",
                          "use exactly one of target_time, target_lsn, target_xid, target_name")


# --------------------------------------------------------------------------- choosing the base backup and checking WAL
def choose_set(repo, spec=None, target_time=None, target_lsn=None, target_xid=None, target_name=None):
    """Explicit set wins. Otherwise the newest COMPLETE set that ends BEFORE the target (a set cannot recover to earlier than its stop)."""
    done = repo.complete_sets()
    if not done:
        raise EngineError("PGA-REPO-020", "no complete backup available", "run a full backup first")
    if spec not in (None, "", "latest"):
        s = repo.resolve_set(spec)
        _check_target_after_set(s, target_time, target_lsn)
        if (target_xid or target_name) and s.get("type") != "full":
            raise EngineError("PGA-PITR-004", "a transaction-id / restore-point target cannot be ordered against an incremental or differential backup (%s)" % s["id"],
                              "choose a FULL backup as the base, or use a time / LSN target")
        return s
    if target_xid or target_name:
        # an xid or a named restore point cannot be compared with a backup's stop position: only a full backup is safe as the base
        fulls = [x for x in done if x.get("type") == "full"]
        if not fulls:
            raise EngineError("PGA-PITR-004", "no full backup available for a transaction-id / restore-point target")
        return fulls[-1]
    if target_time:
        t = target_time_to_dt(target_time)
        if t is not None:
            ok = []
            for s in done:
                st = target_time_to_dt((s.get("stop_time") or "").replace("T", " ")) if s.get("stop_time") else None
                if st is not None and st <= t:
                    ok.append(s)
            if not ok:
                raise EngineError("PGA-PITR-003", "target time %s is earlier than every backup (oldest ends %s)" % (target_time, done[0].get("stop_time")),
                                  "choose a later time or keep older backups")
            return ok[-1]
    if target_lsn:
        t = lsn_to_int(target_lsn)
        ok = [s for s in done if lsn_to_int(s["stop_lsn"]) <= t]
        if not ok:
            raise EngineError("PGA-PITR-003", "target LSN %s is earlier than every backup" % target_lsn)
        return ok[-1]
    return done[-1]


def _check_target_after_set(s, target_time, target_lsn):
    if target_time and s.get("stop_time"):
        t, st = target_time_to_dt(target_time), target_time_to_dt(s["stop_time"].replace("T", " "))
        if t and st and t < st:
            raise EngineError("PGA-PITR-003", "target %s is before the end of backup %s (%s)" % (target_time, s["id"], s["stop_time"]),
                              "pick an earlier backup or omit --set to choose automatically")
    if target_lsn and lsn_to_int(target_lsn) < lsn_to_int(s["stop_lsn"]):
        raise EngineError("PGA-PITR-003", "target LSN %s is before the end of backup %s (%s)" % (target_lsn, s["id"], s["stop_lsn"]))


def check_wal_for_chain(ctx, chain, target_lsn=None):
    """Every WAL segment between the BASE backup's start and the LAST set's stop (and the target LSN) must be archived."""
    first, last = chain[0], chain[-1]
    seg = last.get("wal_segment_size") or ctx.seg_size
    tli = last["timeline"]
    lo = wal_segno(lsn_to_int(first["start_lsn"]), seg)
    hi = last_wal_segno(last, seg)
    if target_lsn:
        want = wal_segno(lsn_to_int(target_lsn), seg)
        if want > hi:
            # a target past the END of the archive is not a hole in it: only what exists up to the last archived segment has to be contiguous (the rest is clamped by the recovery)
            try:
                lastname = (ctx.wal.verify_continuity() or {}).get("last_segment")
                p = parse_wal_name(lastname, seg) if lastname else None
                want = min(want, p[1]) if p else hi
            except Exception:
                want = hi
        hi = max(hi, want)
    missing = []
    # a set may span a timeline switch only through its own tli; segments of ancestors are looked up per set
    for s in chain:
        a, b = wal_segno(lsn_to_int(s["start_lsn"]), seg), last_wal_segno(s, seg)
        for n in range(a, b + 1):
            nm = wal_name(s["timeline"], n, seg)
            if not ctx.wal.has_segment(nm):
                missing.append(nm)
    # contiguity from the base start up to the last stop. A chain that spans a failover / PITR spans TIMELINES: the segments before the switch exist only under the
    # old timeline, the ones after it only under the new one, so a segment number counts as present if it exists under any timeline the chain went through.
    tls = {x["timeline"] for x in chain} | {tli}
    for n in range(lo, hi + 1):
        if not any(ctx.wal.has_segment(wal_name(t, n, seg)) for t in tls):
            nm = wal_name(tli, n, seg)
            if nm not in missing:
                missing.append(nm)
    return missing


RESUME_MARK = ".pg_arca_restore.json"      # written into the destination while a restore runs, removed when it is complete: a leftover = interrupted restore


def interrupted_restore(dest):
    try:
        return read_json(os.path.join(dest, RESUME_MARK))
    except (IOError, OSError, ValueError):
        return None


def target_dir_check(ctx, dest, delta, what="restore destination", resume=False):
    dest = assert_writable_target(ctx, dest, what)
    mark = interrupted_restore(dest) if os.path.isdir(dest) else None
    if mark and not (resume or delta):
        raise EngineError("PGA-RST-040", "'%s' holds an interrupted restore (set %s, started %s)" % (dest, mark.get("set"), mark.get("started")),
                          "resume it (only what is missing or different is written again), or empty the directory to start over")
    if resume and not mark:
        raise EngineError("PGA-RST-041", "nothing to resume in '%s' (no interrupted pg_arca restore there)" % dest, "start a normal restore")
    if mark and resume:
        return dest                                                     # our own partial copy: safe to complete in place, even before PG_VERSION was written
    if delta and os.path.exists(dest) and os.listdir(dest) and not os.path.exists(os.path.join(dest, "PG_VERSION")):
        raise EngineError("PGA-SEC-006", "delta restore: '%s' does not look like a PostgreSQL data directory (no PG_VERSION)" % dest,
                          "delta deletes every file that is not in the backup; point it at the old copy of the data directory, or use an empty directory")
    if os.path.exists(dest) and os.listdir(dest) and not delta:
        raise EngineError("PGA-SEC-005", "%s '%s' is not empty" % (what, dest), "use an empty directory, or delta=true to overwrite in place (existing content will be lost)")
    return dest


# --------------------------------------------------------------------------- full-instance restore
def restore_instance(ctx, set_spec=None, dest=None, target_time=None, target_lsn=None, target_xid=None, target_name=None, inclusive=True,
                     action="promote", timeline="latest", delta=False, tablespace_remap=None, dry_run=False, immediate=False,
                     progress=None, cancel=None, resume=False, keep_archiving=False):
    """keep_archiving=False (default): the restored copy is made SAFE to start next to production - archive_mode off (it would otherwise push a new
    timeline and its history file into production's WAL archive, where the next real failover then collides), no synchronous standby to wait for,
    no upstream to follow. True only when the copy REPLACES the original server."""
    repo = ctx.repo
    count_targets(target_time, target_lsn, target_xid, target_name, immediate)
    target_time = parse_target_time(target_time)
    if not dest:
        raise EngineError("PGA-GEN-063", "destination directory is required", "restoring over the live data directory is never allowed")
    target = choose_set(repo, set_spec, target_time, target_lsn, target_xid, target_name)
    chain = build_chain(repo, target)
    sp = set_profile(chain[0])
    if sp is not None:
        require_supported(sp, "restoring this backup")
    missing = check_wal_for_chain(ctx, chain, target_lsn)
    plan = {"set": target["id"], "chain": [c["id"] for c in chain], "destination": os.path.realpath(dest), "missing_wal": missing[:20],
            "pg_version": sp.label if sp else None,
            "target": target_time or target_lsn or target_xid or target_name or ("immediate" if immediate else "end of archive")}
    merged, tbs = merge_chain(repo, chain)
    plan["bytes"] = estimate(merged)
    plan["files"] = len(merged)
    if missing:
        raise EngineError("PGA-WAL-022", "WAL archive is missing %d segment(s) required by this restore (first: %s)" % (len(missing), missing[0]),
                          "restore is impossible past the gap; pick another set or fix the archive")
    dest = target_dir_check(ctx, dest, delta, resume=resume)
    if resume:
        delta = True                                                    # resume = delta over our own partial copy
    remap = {str(k): v for k, v in (tablespace_remap or {}).items()}
    auto = []
    for oid, loc in list(tbs.items()):
        tgt = remap.get(str(oid)) or loc
        if str(oid) not in remap:
            # No explicit mapping: the original location normally belongs to the LIVE source server (or is not empty). Never write there; relocate next to the
            # restored data directory instead, so a restore from the web console works without the operator knowing the tablespace oids.
            try:
                assert_writable_target(ctx, tgt, "tablespace %s location" % oid)
                busy = os.path.exists(tgt) and bool(os.listdir(tgt)) and not delta
            except EngineError:
                busy = True
            if busy:
                tgt = os.path.join(os.path.realpath(dest) + "_tblspc", str(oid))
                remap[str(oid)] = tgt
                auto.append(str(oid))
        assert_writable_target(ctx, tgt, "tablespace %s location" % oid)
        if os.path.exists(tgt) and os.listdir(tgt) and not delta:
            raise EngineError("PGA-SEC-005", "tablespace location '%s' is not empty" % tgt, "provide tablespace_remap for it")
    plan["tablespaces"] = {str(k): (remap.get(str(k)) or v) for k, v in tbs.items()}
    if auto:
        plan["tablespaces_relocated"] = auto       # shown to the operator: these did not keep their original path
    free = _free_bytes(dest)
    if free is not None:
        plan["destination_free_bytes"] = free
        need = int(plan["bytes"] * 1.05) + 64 * 1024 * 1024
        if not tbs and not delta and free < need:
            raise EngineError("PGA-RST-030", "not enough free space at the destination: %.1f GiB free, about %.1f GiB needed (%.1f GiB of data)" % (free / 2.0 ** 30, need / 2.0 ** 30, plan["bytes"] / 2.0 ** 30),
                              "choose a destination on a larger volume (the plan lists the sizes), or restore just one database / table instead of the whole cluster")
        if (tbs or delta) and free < plan["bytes"] * 0.2:
            plan["space_warning"] = "only %.1f GiB free at the destination for %.1f GiB of data (tablespaces / delta make an exact check impossible): the restore may run out of space" % (free / 2.0 ** 30, plan["bytes"] / 2.0 ** 30)
    try:                                                           # every chunk of the chain must be in the repository: found now, not halfway through the extraction
        from pg_arca.engine import restorecheck
        checked, nmiss, ex, sampled = restorecheck.missing_chunks(repo, merged)
        if nmiss:
            chk = [{"id": "chunks", "level": "bad", "text": "%d of the %d backup chunks this restore needs are missing from the repository (e.g. %s)" % (nmiss, checked, ", ".join(ex[:3])),
                    "fix": "restore the repository from its copy, or choose an older backup set that does not depend on them; run a deep verify"}]
        else:
            chk = [{"id": "chunks", "level": "ok", "text": "all %d backup chunks needed are present in the repository%s" % (checked, " (random sample)" if sampled else "")}]
        # space per filesystem: destination, relocated tablespaces, and the live data directory when it shares a volume with them (it must never fill up)
        tb_bytes = {}
        for k, v in merged.items():
            if k.startswith("pg_tblspc/"):
                oid = k.split("/")[1]
                tb_bytes[oid] = tb_bytes.get(oid, 0) + int(v.get("size") or 0)
        acc = restorecheck.access_check(dest)
        if acc:
            chk.append(acc)
        for oid, tp in (plan.get("tablespaces") or {}).items():
            a2 = restorecheck.access_check(tp, "tablespace destination")
            if a2:
                chk.append(a2)
        needs = [("dest", dest, int((plan["bytes"] - sum(tb_bytes.values())) * 1.05) + (64 << 20) if not delta else 0)]
        needs += [("tablespace", plan["tablespaces"][oid], int(b * 1.05)) for oid, b in tb_bytes.items() if oid in plan["tablespaces"] and not delta]
        if ctx.pgdata:
            needs.append(("data", ctx.pgdata, 0))
        vols = restorecheck.volumes(needs)

        def _add(cid, level, text, fix=None, **kw):
            chk.append(dict({"id": cid, "level": level, "text": text}, **({"fix": fix} if fix else {})))
        restorecheck.space_checks(vols, _add)
        plan["space"] = [{"paths": v["paths"], "roles": v["roles"], "need": v["need"], "free": v["free"], "total": v["total"], "free_after": v.get("free_after")} for v in vols if v["need"] > 0]
        if delta and "space_warning" in plan:
            chk.append({"id": "dest_space", "level": "warn", "text": plan["space_warning"]})
        try:
            created = tablespaces_created_in_window(ctx, chain, target_lsn)
        except EngineError as e:
            created = []
            chk.append({"id": "ts_created", "level": "warn", "text": "could not check the WAL for tablespaces created after the backup: %s" % e.message[:160]})
        if created:
            g = guard_created_tablespaces(created, "this server")
            plan["tablespaces_created_after_backup"] = created
            if g:
                chk.append({"id": "ts_created", "level": "bad", "text": g.message, "fix": g.hint})
            else:
                chk.append({"id": "ts_created", "level": "warn",
                            "text": "the recovery will create tablespace directories at their original paths (%s): start this copy only where those paths are free" % ", ".join(t["path"] for t in created[:3]),
                            "fix": "a new FULL backup includes the tablespaces and lets them be relocated"})
        subs = [x for x in (repo.load_catalog(chain[-1]).get("subscriptions") or []) if x.get("slot")]
        if subs:
            names = ", ".join("%s.%s (slot %s)" % (x["db"], x["name"], x["slot"]) for x in subs[:4])
            plan["subscriptions"] = subs
            if keep_archiving:
                chk.append({"id": "subscriptions", "level": "warn",
                            "text": "this server replaces the original: its logical replication subscriptions %s resume from the publisher's slots" % names,
                            "fix": "make sure the original subscriber is stopped for good: two subscribers on one slot lose changes"})
            else:
                chk.append({"id": "subscriptions", "level": "warn",
                            "text": "the copy keeps the logical replication subscriptions %s: they do not run in the copy, but DROP SUBSCRIPTION there connects to the "
                                    "publisher and DROPS production's slot" % names,
                            "fix": "in the copy, before anything else: ALTER SUBSCRIPTION <name> DISABLE; ALTER SUBSCRIPTION <name> SET (slot_name = NONE)"})
        plan["preflight"] = restorecheck.summarize(chk)
        if not dry_run:
            restorecheck.enforce(chk)
    except EngineError:
        raise
    except Exception as e:                                         # the pre-flight must never be the thing that breaks a restore
        ctx.log("warning", "restore pre-flight skipped: %s" % e)
    if dry_run:
        plan["dry_run"] = True
        return plan
    os.makedirs(dest, mode=0o700, exist_ok=True)
    os.chmod(dest, 0o700)
    write_json(os.path.join(dest, RESUME_MARK), {"set": target["id"] if isinstance(target, dict) else target, "started": iso(), "resumed": bool(resume)})
    if delta:
        remove_stale(dest, merged)
    if progress:
        progress({"phase": "wal_flush"})
    fl = flush_current_wal(ctx, chain, target_time, target_lsn, target_xid, target_name, cancel=cancel)     # the copy recovers up to 'now' when the source is alive
    if fl:
        plan["wal_flushed"] = fl
    link_tablespaces(dest, tbs, remap)
    stats = materialize(ctx, merged, dest, delta, progress, cancel)
    try:
        from pg_arca.engine.ephemeral import read_pg_control
        prof0 = set_profile(chain[0]) or Profile(16 * 10000)
        ensure_tablespace_version_dirs(dest, tbs, merged, prof0.label, read_pg_control(ctx.conn, dest).get("catversion") if tbs else None)
    except EngineError as e:
        ctx.log("warning", "tablespace version directories not checked: %s" % e.message)
    cat = repo.load_catalog(target)
    prepare_skeleton(dest, cat)
    install_external_conf(dest, merged)
    label = os.path.join(repo.sp("backup", chain[0]["id"], "backup_label"))        # ALWAYS the base full's label
    shutil.copy2(label, os.path.join(dest, "backup_label"))
    scrub_recovery_settings(dest)
    t_lsn, t_imm = effective_targets(chain, target_lsn, immediate, ctx)
    prof = set_profile(chain[0]) or Profile(16 * 10000)
    if not keep_archiving:
        safe = ["archive_mode = 'off'", "synchronous_standby_names = ''"]
        if not prof.recovery_conf_file:                     # >= 12: these are server settings (before, they lived in recovery.conf, which we write ourselves)
            safe += ["primary_conninfo = ''", "primary_slot_name = ''"]
        spl = (cat.get("settings") or {}).get("shared_preload_libraries")
        if spl is None:
            spl = _conf_preload(dest)
        newv, gone = copy_preload_filter(spl)
        if gone:
            safe.append("shared_preload_libraries = '%s'" % newv.replace("'", "''"))
            plan["copy_libraries_removed"] = gone
        if prof.num >= 100000:
            # logical replication SUBSCRIPTIONS of the copy would connect to the real publisher and consume the real subscriber's slot: that
            # subscriber then silently misses those changes. The copy starts with no apply worker (subscriptions stay defined, nothing runs)
            safe.append("max_logical_replication_workers = 0")
        with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
            f.write("\n# ==== pg_arca: restored COPY (%s) - safe to start next to production: it does not archive into production's WAL archive, waits for no\n"
                    "# synchronous standby, follows no primary, runs no logical replication subscription and loads no library that works on other\n"
                    "# servers by itself (pg_cron jobs connect to the host:port stored in each job). Remove these lines only if this copy REPLACES\n"
                    "# the original server. ====\n%s\n" % (iso(), "\n".join(safe)))
        plan["copy_safety"] = safe
    prof.install_recovery(dest, recovery_lines(ctx.restore_command, target_time, t_lsn, target_xid, target_name, t_imm,
                                               "promote" if action == "promote" else "pause", inclusive, timeline))       # recovery.signal + auto.conf (>=12) or recovery.conf (<12)
    bad = audit_symlinks(dest)
    bad = [b for b in bad if not b[0].startswith(os.path.join(dest, "pg_tblspc") + os.sep)]
    if bad:
        raise EngineError("PGA-SEC-011", "symlinks escape the destination: %s" % bad[:3])
    os.chmod(dest, 0o700)
    try:
        os.unlink(os.path.join(dest, RESUME_MARK))                     # complete: no longer an interrupted restore
    except OSError:
        pass
    plan.update(stats)
    if resume:
        plan["resumed"] = True
    plan["start_hint"] = ("pg_ctl -D %s -o \"-p <free port>\" start   (recovery runs until %s; on the production host choose a port that is not in use)" % (dest, plan["target"]))
    return plan
