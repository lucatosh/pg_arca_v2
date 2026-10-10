"""Restore: chain merge, parallel verified materialization, sparse (single-DB) extraction, skeletonization, recovery config."""

import os
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from pg_arca.engine.backup import _check_cancel, build_chain
from pg_arca.engine.pgdata import list_directories
from pg_arca.engine.safety import assert_writable_target, audit_symlinks
from pg_arca.engine.util import (last_wal_segno, EngineError, chunk_hash, human, iso, lsn_to_int, parse_target_time, safe_relpath, target_time_to_dt, wal_name,
                                 wal_segno)


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
            if rel not in keep and f not in ("backup_label", "recovery.signal", "tablespace_map"):
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
        hi = max(hi, wal_segno(lsn_to_int(target_lsn), seg))
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


def target_dir_check(ctx, dest, delta, what="restore destination"):
    dest = assert_writable_target(ctx, dest, what)
    if delta and os.path.exists(dest) and os.listdir(dest) and not os.path.exists(os.path.join(dest, "PG_VERSION")):
        raise EngineError("PGA-SEC-006", "delta restore: '%s' does not look like a PostgreSQL data directory (no PG_VERSION)" % dest,
                          "delta deletes every file that is not in the backup; point it at the old copy of the data directory, or use an empty directory")
    if os.path.exists(dest) and os.listdir(dest) and not delta:
        raise EngineError("PGA-SEC-005", "%s '%s' is not empty" % (what, dest), "use an empty directory, or delta=true to overwrite in place (existing content will be lost)")
    return dest


# --------------------------------------------------------------------------- full-instance restore
def restore_instance(ctx, set_spec=None, dest=None, target_time=None, target_lsn=None, target_xid=None, target_name=None, inclusive=True,
                     action="promote", timeline="latest", delta=False, tablespace_remap=None, dry_run=False, immediate=False,
                     progress=None, cancel=None):
    repo = ctx.repo
    count_targets(target_time, target_lsn, target_xid, target_name, immediate)
    target_time = parse_target_time(target_time)
    if not dest:
        raise EngineError("PGA-GEN-063", "destination directory is required", "restoring over the live data directory is never allowed")
    target = choose_set(repo, set_spec, target_time, target_lsn, target_xid, target_name)
    chain = build_chain(repo, target)
    missing = check_wal_for_chain(ctx, chain, target_lsn)
    plan = {"set": target["id"], "chain": [c["id"] for c in chain], "destination": os.path.realpath(dest), "missing_wal": missing[:20],
            "target": target_time or target_lsn or target_xid or target_name or ("immediate" if immediate else "end of archive")}
    merged, tbs = merge_chain(repo, chain)
    plan["bytes"] = estimate(merged)
    plan["files"] = len(merged)
    if missing:
        raise EngineError("PGA-WAL-022", "WAL archive is missing %d segment(s) required by this restore (first: %s)" % (len(missing), missing[0]),
                          "restore is impossible past the gap; pick another set or fix the archive")
    dest = target_dir_check(ctx, dest, delta)
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
    if dry_run:
        plan["dry_run"] = True
        return plan
    os.makedirs(dest, mode=0o700, exist_ok=True)
    os.chmod(dest, 0o700)
    if delta:
        remove_stale(dest, merged)
    link_tablespaces(dest, tbs, remap)
    stats = materialize(ctx, merged, dest, delta, progress, cancel)
    cat = repo.load_catalog(target)
    prepare_skeleton(dest, cat)
    install_external_conf(dest, merged)
    label = os.path.join(repo.sp("backup", chain[0]["id"], "backup_label"))        # ALWAYS the base full's label
    shutil.copy2(label, os.path.join(dest, "backup_label"))
    scrub_recovery_settings(dest)
    with open(os.path.join(dest, "postgresql.auto.conf"), "a") as f:
        t_lsn, t_imm = effective_targets(chain, target_lsn, immediate, ctx)
        f.write(recovery_lines(ctx.restore_command, target_time, t_lsn, target_xid, target_name, t_imm,
                               "promote" if action == "promote" else "pause", inclusive, timeline))
    open(os.path.join(dest, "recovery.signal"), "w").close()
    bad = audit_symlinks(dest)
    bad = [b for b in bad if not b[0].startswith(os.path.join(dest, "pg_tblspc") + os.sep)]
    if bad:
        raise EngineError("PGA-SEC-011", "symlinks escape the destination: %s" % bad[:3])
    os.chmod(dest, 0o700)
    plan.update(stats)
    plan["start_hint"] = "pg_ctl -D %s start   (recovery runs until %s)" % (dest, plan["target"])
    return plan
