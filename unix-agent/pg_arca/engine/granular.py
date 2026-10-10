"""Granular restore: a whole database or a single object at any point in time, via a sparse ephemeral instance.

Nothing existing is ever overwritten: databases are restored under a NEW name, objects into a NEW quarantine database.
Failure after the destination DB was created drops it again (all-or-nothing from the operator's point of view).
"""

import os
import shutil
import subprocess
import tempfile
import time

from pg_arca.engine.backup import build_chain
from pg_arca.engine import objects as objmod
from pg_arca.engine.catalog import find_object
from pg_arca.engine.ephemeral import Ephemeral, TargetNotReached
from pg_arca.engine.pgsession import PgConn, PgSession, run_tool
from pg_arca.engine.restore import check_wal_for_chain, choose_set, count_targets, estimate, merge_chain, sparse_filter
from pg_arca.engine.util import EngineError, human, lsn_to_int, now_utc, parse_target_time, quote_ident, sql_lit, target_time_to_dt, wal_name, wal_segno

import re as _re
_ID_OK = _re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,62}$")


def _check_name(n, what):
    if not _ID_OK.match(n or ""):
        raise EngineError("PGA-GEN-065", "invalid %s %r (letters, digits, _ and $; max 63; must not start with a digit)" % (what, n))


def _dest_conn(ctx, into):
    if not into:
        return ctx.conn.with_db("postgres")
    c = PgConn.from_dict(into, ctx.conn.bindir)
    return c


def _plan(ctx, set_spec, target_time, target_lsn, target_xid, target_name, immediate=False):
    count_targets(target_time, target_lsn, target_xid, target_name, immediate)
    tt = parse_target_time(target_time)
    target = choose_set(ctx.repo, set_spec, tt, target_lsn, target_xid, target_name)
    chain = build_chain(ctx.repo, target)
    missing = check_wal_for_chain(ctx, chain, target_lsn)
    if missing:
        raise EngineError("PGA-WAL-022", "WAL archive is missing %d segment(s) required (first: %s)" % (len(missing), missing[0]),
                          "recovery past the gap is impossible; choose another set or repair the archive")
    return target, chain, tt


def _create_db(admin, name, entry):
    s = PgSession(admin.with_db("postgres"))
    try:
        if s.scalar("SELECT 1 FROM pg_database WHERE datname=%s" % sql_lit(name)) == "1":
            raise EngineError("PGA-SEC-030", "destination database '%s' already exists" % name, "choose another name; existing databases are never overwritten")
        enc = entry.get("encoding") or "UTF8"
        extra = ""
        if entry.get("collate") and entry.get("ctype"):
            extra = " LC_COLLATE %s LC_CTYPE %s" % (sql_lit(entry["collate"]), sql_lit(entry["ctype"]))
        try:
            s.query("CREATE DATABASE %s TEMPLATE template0 ENCODING %s%s" % (quote_ident(name), sql_lit(enc), extra))
        except EngineError:
            s.query("CREATE DATABASE %s TEMPLATE template0 ENCODING %s" % (quote_ident(name), sql_lit(enc)))
    finally:
        s.close()


def _drop_db(admin, name):
    try:
        s = PgSession(admin.with_db("postgres"))
        try:
            s.query("DROP DATABASE IF EXISTS %s" % quote_ident(name))
        finally:
            s.close()
    except EngineError:
        pass


def _pg_restore(admin, dbname, dumpfile, jobs, extra=()):
    args = admin.args() + ["-d", dbname, "--no-owner", "--no-acl", "--exit-on-error", "-j", str(max(1, jobs))] + list(extra) + [dumpfile]
    rc, out, err = run_tool(admin, "pg_restore", args, timeout=None)
    if rc != 0:
        raise EngineError("PGA-GEN-071", "pg_restore failed: %s" % (err.strip() or out.strip())[:800])


def _recover_once(ctx, chain, keep_oids, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel, name=None, immediate=False):
    eph = Ephemeral(ctx, name=name)
    t0 = time.time()
    try:
        stats = eph.build(chain, keep_oids, tt, target_lsn, target_xid, target_name, inclusive, immediate, progress, cancel)
        if progress:
            progress({"phase": "starting"})
        boot = eph.start(cancel=cancel)
        rec_s, lsn, last_xact = eph.wait_target(cancel=cancel, progress=progress)
        info = {"extracted_bytes": stats["selected_bytes"], "cluster_bytes": stats["cluster_bytes"], "extract_seconds": stats["seconds"],
                "boot_seconds": round(boot, 1), "recovery_seconds": round(rec_s, 1), "reached_lsn": lsn, "last_replayed_xact_time": last_xact,
                "guc_removed": stats["guc_removed"], "total_seconds": round(time.time() - t0, 1)}
        return eph, info
    except BaseException:
        eph.cleanup()
        raise


def _recover(ctx, chain, keep_oids, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel, name=None, immediate=False):
    """Recover to the requested target. A time/LSN target beyond the last archived WAL (typically "now" when the last segment is still being filled) is not an error
    of the user's choice worth failing a long restore for: when the archive is continuous we recover up to its end instead and SAY SO (`target_clamped`).
    A transaction id / restore point that is not in the archive, or an archive with holes, is reported precisely and never papered over."""
    try:
        return _recover_once(ctx, chain, keep_oids, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel, name, immediate)
    except TargetNotReached as e:
        reached = e.redo_lsn or "?"
        if not (tt or target_lsn):
            raise EngineError("PGA-PITR-014", "the requested %s is not in the archived WAL (the archive ends at %s)" % ("transaction id" if target_xid else "restore point", reached),
                              "it may have happened after the last archived segment or never on this timeline; check the value, or restore to a time instead")
        try:
            cont = ctx.wal.verify_continuity()
        except Exception:
            cont = {"continuous": True}
        if not cont.get("continuous", True):
            g = (cont.get("gaps") or [{}])[0]
            raise EngineError("PGA-PITR-014", "recovery stopped at %s before the requested target and the WAL archive has %s gap(s) (first missing: %s)" % (reached, cont.get("gap_count", "some"), g.get("missing_from", "?")),
                              "the data after the gap cannot be recovered; choose an earlier target, or repair the archive (WAL rescue / the primary's pg_wal)")
        requested = tt or target_lsn
        ctx.log("warning", "target %s is beyond the end of the archive (replayed up to %s): recovering to the end of the archive instead" % (requested, reached))
        if progress:
            progress({"phase": "recovery", "note": "target beyond the archive: recovering to its end"})
        eph, info = _recover_once(ctx, chain, keep_oids, None, None, None, None, inclusive, progress, cancel, name, False)
        bad = False
        try:                                  # the end must really be BEFORE the request, otherwise the first failure had another cause
            if tt and info.get("last_replayed_xact_time"):
                got = target_time_to_dt(info["last_replayed_xact_time"])
                want = target_time_to_dt(tt)
                bad = bool(got and want and got >= want)
            elif target_lsn:
                bad = lsn_to_int(info["reached_lsn"]) >= lsn_to_int(target_lsn)
        except Exception:
            bad = False
        if bad:
            eph.cleanup()
            raise e
        info["target_clamped"] = {"requested": requested, "reached_lsn": info["reached_lsn"], "last_replayed_xact_time": info.get("last_replayed_xact_time"),
                                  "message": "the requested point is after the last archived WAL: recovered up to the end of the archive (%s)" % (info.get("last_replayed_xact_time") or info["reached_lsn"])}
        return eph, info


def _waldump(exe, tmp, name, *flags):
    r = subprocess.run([exe, "-p", tmp, ] + list(flags) + [name], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    return (r.stdout or "").splitlines()


def find_drop_database_lsn(ctx, chain, dboid, reached_lsn):
    """Where the DROP DATABASE of `dboid` begins in the WAL: returns ([candidate stop LSNs, most likely first], drop_lsn, xid) or None. Searched backwards from the segment where recovery stopped (pg_waldump).
    PostgreSQL damages the database BEFORE the drop commits and without a timestamp: from PG15 it first marks it INVALID with an in-place update (replayed even if the
    transaction's commit is beyond the target), then deletes its directory when redoing XLOG_DBASE_DROP. A time/xid target "just before the DROP's commit" is already too late;
    only an LSN before the dropping transaction's FIRST record gives back a usable database."""
    seg_size = ctx.seg_size
    first = chain[0]
    tli = int(chain[-1].get("timeline") or first.get("timeline") or 1)
    lo = wal_segno(lsn_to_int(first["start_lsn"]), seg_size)
    hi = wal_segno(lsn_to_int(reached_lsn), seg_size)
    exe = ctx.conn.exe("pg_waldump")
    tmp = tempfile.mkdtemp(prefix="pgarca-drop-")
    lsn_re = _re.compile(r"lsn: ([0-9A-Fa-f]+/[0-9A-Fa-f]+)")
    try:
        found = None
        names = {}
        for seg in range(hi, lo - 1, -1):
            name = wal_name(tli, seg, seg_size)
            if not ctx.wal.has_segment(name):
                continue
            code, msg = ctx.wal.retrieve_segment(name, os.path.join(tmp, name))
            if code != 0:
                continue
            names[seg] = name
            if found:
                continue
            for line in _waldump(exe, tmp, name, "-r", "Database"):
                if "DROP" in line and any(int(m.group(2)) == int(dboid) for m in _re.finditer(r"(\d+)/(\d+)", line.split("desc:", 1)[-1])):
                    m, x = lsn_re.search(line), _re.search(r"tx:\s*(\d+)", line)
                    if m and x:
                        found = (m.group(1), x.group(1), seg)          # keep scanning the segment: the LAST drop wins
            if found:
                break
        if not found:
            return None
        drop_lsn, xid, seg_hit = found
        dl = lsn_to_int(drop_lsn)
        cands = []
        for seg in range(seg_hit, max(lo, seg_hit - 1) - 1, -1):        # in-place updates of pg_database (1664/0/1262) just before the drop: they carry NO xid
            name = names.get(seg)
            if not name:
                continue
            if not os.path.exists(os.path.join(tmp, name)):
                if ctx.wal.retrieve_segment(name, os.path.join(tmp, name))[0] != 0:
                    continue
            for line in _waldump(exe, tmp, name, "-r", "Heap"):
                if "INPLACE" in line and "1664/0/1262" in line:
                    m = lsn_re.search(line)
                    if m and lsn_to_int(m.group(1)) < dl:
                        cands.append(lsn_to_int(m.group(1)))
        cands = sorted(set(cands), reverse=True)[:3]
        lsns = []
        for seg in range(seg_hit, lo - 1, -1):                       # the dropping transaction's first record (it has an xid once it deletes the pg_database row)
            name = names.get(seg)
            if not name:
                break
            if not os.path.exists(os.path.join(tmp, name)):
                if ctx.wal.retrieve_segment(name, os.path.join(tmp, name))[0] != 0:
                    break
            got = [lsn_to_int(m.group(1)) for m in (lsn_re.search(l) for l in _waldump(exe, tmp, name, "-x", xid)) if m]
            if not got:
                break
            lsns += got
        cands.append(min(lsns) if lsns else dl)
        fmt = lambda v: "%X/%08X" % (v >> 32, v & 0xFFFFFFFF)
        return [fmt(c) for c in cands], drop_lsn, xid
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _db_usable(eph, entry):
    """True when the recovered instance really holds a connectable database `entry` (not removed, not marked invalid by a DROP DATABASE that was partly replayed)."""
    if not os.path.isdir(os.path.join(eph.dir, "base", str(entry["oid"]))):
        eph.unusable = "directory base/%s missing" % entry["oid"]
        return False
    s = PgSession(eph.conn("postgres"), read_only=True)
    try:
        row = s.query("SELECT datconnlimit, pg_is_in_recovery(), (SELECT count(*) FROM pg_database) FROM pg_database WHERE oid = %s" % int(entry["oid"]))
        eph.unusable = "pg_database row: %r" % (row,)
        return bool(row) and row[0][0] != "-2"
    finally:
        s.close()


def _recover_db(ctx, chain, entry, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel):
    """_recover() for a recovery whose purpose is to read database `entry`: if that database was dropped right after the target, it is already damaged in the recovered
    instance (see find_drop_database_lsn). We then stop BEFORE the DROP DATABASE transaction (exclusive LSN) and say so (`stopped_before_drop`)."""
    eph, info = _recover(ctx, chain, {entry["oid"]}, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel)
    if _db_usable(eph, entry):
        return eph, info
    reached = info.get("reached_lsn")
    eph.cleanup()
    hit = find_drop_database_lsn(ctx, chain, entry["oid"], reached) if reached else None
    if not hit:
        raise EngineError("PGA-PITR-015", "database '%s' does not exist at the requested point (it is damaged or gone at %s and no DROP DATABASE was found in the WAL)" % (entry["name"], reached or "?"),
                          "choose an earlier time, or an earlier backup set that contains it")
    cands, drop_lsn, xid = hit
    for n, lsn in enumerate(cands):
        ctx.log("warning", "database '%s' was dropped right after the target: stopping just before the DROP DATABASE (xid %s) at %s" % (entry["name"], xid, lsn))
        if progress:
            progress({"phase": "recovery", "note": "database dropped right after the target: stopping before the DROP"})
        eph, info = _recover(ctx, chain, {entry["oid"]}, None, lsn, None, None, False, progress, cancel)
        if _db_usable(eph, entry):
            info["stopped_before_drop"] = {"lsn": lsn, "xid": xid, "message": "the database was dropped right after the requested point: recovered up to just before the DROP DATABASE (%s)" % lsn}
            return eph, info
        why = getattr(eph, "unusable", "?")
        eph.cleanup()
    raise EngineError("PGA-PITR-015", "database '%s' could not be recovered: it is not usable even before the DROP DATABASE (tried %s; %s)" % (entry["name"], ", ".join(cands), why),
                      "the base backup used does not contain the database: choose a later backup set")


def restore_database(ctx, db, set_spec=None, target_time=None, target_lsn=None, target_xid=None, target_name=None, inclusive=True,
                     into=None, new_name=None, jobs=2, dry_run=False, progress=None, cancel=None):
    target, chain, tt = _plan(ctx, set_spec, target_time, target_lsn, target_xid, target_name)
    cat = ctx.repo.load_catalog(target)
    if db not in cat["databases"]:
        raise EngineError("PGA-GEN-031", "database '%s' is not in backup %s" % (db, target["id"]), "available: %s" % ", ".join(sorted(cat["databases"])))
    entry = cat["databases"][db]
    new_name = new_name or (db + "_restored")
    _check_name(new_name, "destination database name")
    merged_sel, _ = merge_chain(ctx.repo, chain, sparse_filter({entry["oid"], 1, 5}))
    merged_all, _ = merge_chain(ctx.repo, chain)
    plan = {"set": target["id"], "chain": [c["id"] for c in chain], "database": db, "destination_database": new_name,
            "extract_bytes": estimate(merged_sel), "cluster_bytes": estimate(merged_all),
            "target": tt or target_lsn or target_xid or target_name or "end of archive"}
    plan["saved_pct"] = round(100.0 * (1 - plan["extract_bytes"] / float(max(plan["cluster_bytes"], 1))), 1)
    if dry_run:
        plan["dry_run"] = True
        return plan
    admin = _dest_conn(ctx, into)
    # fail fast BEFORE the long recovery
    s = PgSession(admin.with_db("postgres"), read_only=True)
    try:
        if s.scalar("SELECT 1 FROM pg_database WHERE datname=%s" % sql_lit(new_name)) == "1":
            raise EngineError("PGA-SEC-030", "destination database '%s' already exists" % new_name, "choose another name")
    finally:
        s.close()
    eph, info = _recover_db(ctx, chain, entry, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel)
    created = False
    tmp = tempfile.mkdtemp(prefix="pgarca-dump-")
    try:
        sess = PgSession(eph.conn(db), read_only=True)
        try:
            info["tables_at_target"] = int(sess.scalar("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') "
                                                       "AND n.nspname NOT IN ('pg_catalog','information_schema')"))
        finally:
            sess.close()
        if progress:
            progress({"phase": "transfer"})
        dumpfile = os.path.join(tmp, "db.dump")
        rc, out, err = run_tool(eph.conn(db), "pg_dump", eph.conn(db).args() + ["-Fc", "-Z", "3", "-f", dumpfile, "-d", db], timeout=None)
        if rc != 0:
            raise EngineError("PGA-GEN-070", "pg_dump from the recovered instance failed: %s" % err.strip()[:600],
                              "the sparse extraction may lack a page needed by this database; retry with a different base set")
        info["dump_bytes"] = os.path.getsize(dumpfile)
        _create_db(admin, new_name, entry)
        created = True
        _pg_restore(admin, new_name, dumpfile, jobs)
        v = PgSession(admin.with_db(new_name), read_only=True)
        try:
            info["tables_restored"] = int(v.scalar("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') "
                                                   "AND n.nspname NOT IN ('pg_catalog','information_schema')"))
        finally:
            v.close()
        if info["tables_restored"] != info["tables_at_target"]:
            raise EngineError("PGA-VRF-040", "verification failed: %d tables at target, %d restored" % (info["tables_at_target"], info["tables_restored"]))
        plan.update(info)
        plan["result_database"] = new_name
        return plan
    except BaseException:
        if created:
            _drop_db(admin, new_name)
        raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        eph.cleanup()


def restore_object(ctx, spec, set_spec=None, target_time=None, target_lsn=None, target_xid=None, target_name=None, inclusive=True,
                   into=None, stage_db=None, data_only=False, dry_run=False, progress=None, cancel=None, objects=None):
    """Recover tables / views / whole schemas (a list of `db.schema.name` or `db.schema`, all in one database) with everything around them, into a quarantine database.
    The selection is expanded to what it needs and what depends on it (foreign keys, types, functions, sequences, views, grants): see engine/objects.py.
    `data_only` is accepted for compatibility and ignored: the quarantine copy is always complete."""
    db, sel = objmod.parse_selection(spec, objects)
    target, chain, tt = _plan(ctx, set_spec, target_time, target_lsn, target_xid, target_name)
    cat = ctx.repo.load_catalog(target)
    if db not in cat["databases"]:
        raise EngineError("PGA-GEN-031", "database '%s' is not in the backup catalog" % db, "available: %s" % ", ".join(sorted(cat["databases"])))
    dbentry = cat["databases"][db]
    nrel = objmod.selection_in_catalog(dbentry, sel)
    label = ", ".join(("%s.%s" % (o["schema"], o["name"])) if o["kind"] == "rel" else ("schema %s" % o["schema"]) for o in sel)
    stage = stage_db or ("pgarca_stage_" + now_utc().strftime("%Y%m%dt%H%M%S"))
    if not stage.startswith("pgarca_stage_"):
        raise EngineError("PGA-GEN-081", "a quarantine database name must start with pgarca_stage_ (pg_arca drops it after promotion: it must never be a user database)")
    _check_name(stage, "quarantine database name")
    merged_sel, _ = merge_chain(ctx.repo, chain, sparse_filter({dbentry["oid"], 1, 5}))
    merged_all, _ = merge_chain(ctx.repo, chain)
    size_in_backup = sum(o["size"] for o in objmod_user_sizes(dbentry, sel))
    plan = {"set": target["id"], "chain": [c["id"] for c in chain], "object": label, "selection": sel, "relations_in_backup": nrel, "size_in_backup": size_in_backup,
            "quarantine_database": stage, "extract_bytes": estimate(merged_sel), "cluster_bytes": estimate(merged_all),
            "target": tt or target_lsn or target_xid or target_name or "end of archive"}
    plan["saved_pct"] = round(100.0 * (1 - plan["extract_bytes"] / float(max(plan["cluster_bytes"], 1))), 1)
    if dry_run:
        plan["dry_run"] = True
        return plan
    admin = _dest_conn(ctx, into)
    eph, info = _recover_db(ctx, chain, dbentry, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel)
    created = False
    try:
        src = PgSession(eph.conn(db), read_only=True)
        try:
            an = objmod.analyze(src, sel)
        finally:
            src.close()

        def make():
            _create_db(admin, stage, dbentry)
        created = True
        meta = objmod.build_stage(admin, eph, dbentry, sel, label, stage, an, plan, progress, create_db=make)
        info["rows_restored"] = sum(meta["counts"].values())
        info["rows_at_target"] = info["rows_restored"]
        info["dependencies"] = {"tables": len(meta["tables"]), "foreign_keys": len(meta["fks"]), "views": len(meta["views"]), "types": len(meta["prereq"]["types"]),
                                "functions": len(meta["prereq"]["functions"]), "sequences": len(meta["owned_sequences"]) + len(meta["sequences"]), "extensions": meta["prereq"]["extensions"],
                                "roles": meta["roles"], "missing_roles": meta.get("missing_roles_at_stage") or []}
        info["warnings"] = meta["warnings"]
        plan.update(info)
        plan["result_database"] = stage
        plan["tables"] = [("%s.%s" % (t["schema"], t["name"])) for t in meta["tables"]]
        plan["inspect"] = "database %s (schemas %s)" % (stage, ", ".join(sorted({t["schema"] for t in meta["tables"]})))
        return plan
    except BaseException:
        if created:
            _drop_db(admin, stage)
        raise
    finally:
        eph.cleanup()


def objmod_user_sizes(dbentry, sel):
    """Backup-catalog footprint (heap + TOAST + indexes + partitions) of the selected objects."""
    from pg_arca.engine.maintenance import user_objects
    objs, _ = user_objects(dbentry)
    out = []
    for o in objs:
        for s in sel:
            if s["schema"] == o["schema"] and (s["kind"] == "schema" or s["name"] == o["name"]):
                out.append(o)
                break
    return out


def restore_test(ctx, set_spec=None, progress=None, cancel=None):
    """Prove a set is recoverable by actually recovering it (sparse: postgres + template1 only, stop at consistency)."""
    target = ctx.repo.resolve_set(set_spec)
    chain = build_chain(ctx.repo, target)
    missing = check_wal_for_chain(ctx, chain)
    if missing:
        raise EngineError("PGA-WAL-022", "WAL archive is missing %d segment(s) (first: %s)" % (len(missing), missing[0]))
    eph, info = _recover(ctx, chain, set(), None, None, None, None, True, progress, cancel, immediate=True)
    try:
        s = PgSession(eph.conn("postgres"), read_only=True)
        try:
            info["postgres_db_readable"] = s.scalar("SELECT count(*) FROM pg_class") is not None
        finally:
            s.close()
    finally:
        eph.cleanup()
    info["set"] = target["id"]
    return info


def restore_drill(ctx, set_spec=None, progress=None, cancel=None):
    """Disaster-recovery drill: recover the WHOLE cluster from the repository into scratch space, start it, replay WAL to the end of the backup
    (or archive), connect to every database, then throw it away. The result is a MEASURED recovery time for this data volume on this host."""
    target = ctx.repo.resolve_set(set_spec)
    chain = build_chain(ctx.repo, target)
    missing = check_wal_for_chain(ctx, chain)
    if missing:
        raise EngineError("PGA-WAL-022", "WAL archive is missing %d segment(s) (first: %s)" % (len(missing), missing[0]))
    cat = ctx.repo.load_catalog(target)
    oids = set(int(d["oid"]) for d in cat["databases"].values())
    need = int((target.get("stats") or {}).get("bytes_logical") or sum(d.get("size", 0) for d in cat["databases"].values()))
    try:
        st = os.statvfs(ctx.scratch_dir if os.path.isdir(ctx.scratch_dir) else os.path.dirname(ctx.scratch_dir.rstrip("/")) or "/")
        free = st.f_bavail * st.f_frsize
    except OSError:
        free = None
    if free is not None and free < need * 1.15:
        raise EngineError("PGA-DRL-001", "not enough scratch space for a full drill: need about %s, %s free in %s" % (human(int(need * 1.15)), human(free), ctx.scratch_dir),
                          "free space or set scratch_dir on a bigger volume; a drill recovers the whole cluster")
    t0 = time.time()
    eph, info = _recover(ctx, chain, oids, None, None, None, None, True, progress, cancel, immediate=True)
    try:
        ok, bad = [], []
        s = PgSession(eph.conn("postgres"), read_only=True)
        try:
            names = [r[0] for r in s.query("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate")]
        finally:
            s.close()
        for n in names:
            try:
                d = PgSession(eph.conn(n), read_only=True)
                try:
                    d.scalar("SELECT count(*) FROM pg_class")
                    ok.append(n)
                finally:
                    d.close()
            except EngineError as e:
                bad.append({"database": n, "error": e.message})
        if bad:
            raise EngineError("PGA-DRL-002", "recovered cluster started but %d database(s) are not readable: %s" % (len(bad), bad[0]["error"]))
    finally:
        eph.cleanup()
    secs = round(time.time() - t0, 1)
    info.update(set=target["id"], databases_checked=ok, rto_seconds=secs, data_bytes=need,
                throughput_mb_s=round(need / 1048576.0 / max(secs, 0.1), 1), full_cluster=True)
    return info


def promote_object(ctx, stage_db, spec, mode="as_new", drop_stage=True, into=None, dry_run=False, progress=None):
    """
    Move a table recovered into a quarantine database back into the real database. Never destructive:
      as_new  : the recovered table appears next to the original as <name>_pitr_<ts>
      replace : the original is renamed <name>_old_<ts> (data kept), the recovered table takes its name
    Indexes and owned sequences of the table that gets the suffix are renamed too, so nothing collides. Foreign keys, views and
    functions that referenced the original keep pointing at it (we report how many), they are not rewired.
    """
    if mode not in ("as_new", "replace", "missing_only"):
        raise EngineError("PGA-GEN-080", "mode must be as_new, replace or missing_only")
    if not stage_db or not stage_db.startswith("pgarca_stage_"):
        raise EngineError("PGA-GEN-081", "only quarantine databases created by pg_arca can be promoted from (name starts with pgarca_stage_)")
    _check_name(stage_db, "quarantine database")
    v2 = objmod.promote(_dest_conn(ctx, into), stage_db, mode=mode, dry_run=dry_run, progress=progress)          # a stage built by restore_object v2 knows everything around its tables
    if v2 is not None:
        if drop_stage and not dry_run:
            _drop_db(_dest_conn(ctx, into), stage_db)
            v2["stage_dropped"] = True
        return v2
    if mode == "missing_only":
        raise EngineError("PGA-GEN-080", "missing_only needs a quarantine database made by the current restore_object (this one predates it): restore the object again")
    if dry_run:
        raise EngineError("PGA-GEN-080", "this quarantine database predates the dependency-aware restore: no plan available, restore the object again")
    parts = spec.split(".")
    if len(parts) != 3:
        raise EngineError("PGA-GEN-082", "object must be database.schema.name")
    dbname, schema, name = parts
    _check_name(stage_db, "quarantine database")
    admin = _dest_conn(ctx, into)
    ts = now_utc().strftime("%Y%m%d%H%M%S")
    work = "pgarca_pr_" + ts
    fq = "%s.%s" % (quote_ident(schema), quote_ident(name))
    tmp = tempfile.mkdtemp(prefix="pgarca-promote-")
    created_schema = False
    result = {"object": spec, "mode": mode}
    try:
        st = PgSession(admin.with_db(stage_db))
        try:
            if st.scalar("SELECT to_regclass(%s) IS NOT NULL" % sql_lit(fq)) != "t":
                raise EngineError("PGA-GEN-083", "table %s not found in %s" % (fq, stage_db))
            rows = int(st.scalar("SELECT count(*) FROM %s" % fq))
            st.query("ALTER SCHEMA %s RENAME TO %s" % (quote_ident(schema), quote_ident(work)))      # the dump now carries the work schema
        finally:
            st.close()
        dump = os.path.join(tmp, "p.dump")
        try:
            rc, out, err = run_tool(admin, "pg_dump", admin.args() + ["-Fc", "-Z", "3", "-t", "%s.%s" % (quote_ident(work), quote_ident(name)), "-f", dump, "-d", stage_db], timeout=None)
        finally:
            st = PgSession(admin.with_db(stage_db))             # leave the quarantine database exactly as we found it (it can be promoted again)
            try:
                st.query("ALTER SCHEMA %s RENAME TO %s" % (quote_ident(work), quote_ident(schema)))
            finally:
                st.close()
        if rc != 0:
            raise EngineError("PGA-GEN-084", "pg_dump failed: %s" % err.strip()[:500])
        tg = PgSession(admin.with_db(dbname))
        try:
            tg.query("CREATE SCHEMA %s" % quote_ident(work))
            created_schema = True
            _pg_restore(admin, dbname, dump, 1, extra=("-1",))
            got = int(tg.scalar("SELECT count(*) FROM %s.%s" % (quote_ident(work), quote_ident(name))))
            if got != rows:
                raise EngineError("PGA-VRF-040", "verification failed: %d rows in quarantine, %d copied" % (rows, got))

            def dependents(sch, tbl):
                idx = [r[0] for r in tg.query("SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=%s::regclass" % sql_lit("%s.%s" % (quote_ident(sch), quote_ident(tbl))))]
                seq = [r[0] for r in tg.query("SELECT s.relname FROM pg_depend d JOIN pg_class s ON s.oid=d.objid AND s.relkind='S' WHERE d.refobjid=%s::regclass AND d.deptype IN ('a','i')" % sql_lit("%s.%s" % (quote_ident(sch), quote_ident(tbl))))]
                return idx, seq

            def short(base, suffix):
                return (base[:63 - len(suffix)] + suffix)

            existing = tg.scalar("SELECT to_regclass(%s) IS NOT NULL" % sql_lit(fq)) == "t"
            if mode == "replace" and existing:
                nrefs = int(tg.scalar("SELECT count(*) FROM pg_constraint WHERE confrelid=%s::regclass" % sql_lit(fq)))
                sfx = "_old_" + ts
                keep_as = short(name, sfx)
                idx, seq = dependents(schema, name)
                tg.query("BEGIN")
                try:
                    tg.query("ALTER TABLE %s RENAME TO %s" % (fq, quote_ident(keep_as)))
                    for i in idx:
                        tg.query("ALTER INDEX %s.%s RENAME TO %s" % (quote_ident(schema), quote_ident(i), quote_ident(short(i, sfx))))
                    for s_ in seq:
                        tg.query("ALTER SEQUENCE %s.%s RENAME TO %s" % (quote_ident(schema), quote_ident(s_), quote_ident(short(s_, sfx))))
                    tg.query("ALTER TABLE %s.%s SET SCHEMA %s" % (quote_ident(work), quote_ident(name), quote_ident(schema)))
                    tg.query("COMMIT")
                except BaseException:
                    try:
                        tg.query("ROLLBACK")
                    except EngineError:
                        pass
                    raise
                result.update(promoted_as="%s.%s" % (schema, name), old_kept_as="%s.%s" % (schema, keep_as), referencing_foreign_keys=nrefs)
                if nrefs:
                    result["warning"] = "%d foreign key(s) still reference the previous table (now %s): they were not rewired" % (nrefs, keep_as)
            else:
                # 'replace' with nothing to replace (the table was dropped): it simply comes back under its OWN name, in its OWN schema (recreated if that was dropped too)
                comes_back = mode == "replace" and not existing
                new_name = name if comes_back else short(name, "_pitr_" + ts)
                sfx = "_pitr_" + ts
                idx, seq = ([], []) if comes_back else dependents(work, name)
                tg.query("BEGIN")
                try:
                    for i in idx:
                        tg.query("ALTER INDEX %s.%s RENAME TO %s" % (quote_ident(work), quote_ident(i), quote_ident(short(i, sfx))))
                    for s_ in seq:
                        tg.query("ALTER SEQUENCE %s.%s RENAME TO %s" % (quote_ident(work), quote_ident(s_), quote_ident(short(s_, sfx))))
                    if new_name != name:
                        tg.query("ALTER TABLE %s.%s RENAME TO %s" % (quote_ident(work), quote_ident(name), quote_ident(new_name)))
                    tg.query("CREATE SCHEMA IF NOT EXISTS %s" % quote_ident(schema))
                    tg.query("ALTER TABLE %s.%s SET SCHEMA %s" % (quote_ident(work), quote_ident(new_name), quote_ident(schema)))
                    tg.query("COMMIT")
                except BaseException:
                    try:
                        tg.query("ROLLBACK")
                    except EngineError:
                        pass
                    raise
                result.update(promoted_as="%s.%s" % (schema, new_name), old_kept_as=("%s.%s" % (schema, name)) if existing else None)
                if comes_back:
                    result["note"] = "the table no longer existed: it came back under its original name in schema %s" % schema
            tg.query("DROP SCHEMA %s" % quote_ident(work))              # empty by now (RESTRICT): anything left means something unexpected
            created_schema = False
            result["rows"] = rows
        finally:
            if created_schema:
                try:
                    tg.query("DROP SCHEMA IF EXISTS %s CASCADE" % quote_ident(work))
                except EngineError:
                    pass
            tg.close()
        if drop_stage:
            _drop_db(admin, stage_db)
            result["stage_dropped"] = True
        return result
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------------------------------------------- row-level recovery
ROW_DIFF_MAX = 2000000


def _table_info(sess, fq):
    """Primary key columns, the columns we may write (not generated) and whether an identity ALWAYS column needs OVERRIDING."""
    reg = sess.scalar("SELECT to_regclass(%s) IS NOT NULL" % sql_lit(fq))
    if reg != "t":
        return None
    cols = [r[0] for r in sess.query("SELECT attname FROM pg_attribute WHERE attrelid=%s::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum" % sql_lit(fq))]
    gen = set(r[0] for r in sess.query("SELECT attname FROM pg_attribute WHERE attrelid=%s::regclass AND attnum>0 AND NOT attisdropped AND attgenerated<>''" % sql_lit(fq)))
    pk = [r[0] for r in sess.query("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=%s::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)" % sql_lit(fq))]
    always = sess.scalar("SELECT count(*)>0 FROM pg_attribute WHERE attrelid=%s::regclass AND attnum>0 AND attidentity='a'" % sql_lit(fq)) == "t"
    return {"cols": cols, "generated": gen, "pk": pk, "identity_always": always}


def _keyhash(sess, fq, pk, common):
    ex = "ARRAY[%s]::text[]" % ",".join(sql_lit(c) for c in common["drop"]) if common["drop"] else "ARRAY[]::text[]"
    keyexpr = "jsonb_build_array(%s)::text" % ",".join("t.%s" % quote_ident(c) for c in pk)
    out = {}
    for r in sess.query("SELECT %s, md5((to_jsonb(t) - %s)::text) FROM %s t" % (keyexpr, ex, fq)):
        out[r[0]] = r[1]
    return out


def _sample(sess, fq, pk, keys):
    keyexpr = "jsonb_build_array(%s)::text" % ",".join("t.%s" % quote_ident(c) for c in pk)
    res = {}
    for i in range(0, len(keys), 200):
        part = keys[i:i + 200]
        for r in sess.query("SELECT %s, to_jsonb(t)::text FROM %s t WHERE %s = ANY(ARRAY[%s])" % (keyexpr, fq, keyexpr, ",".join(sql_lit(k) for k in part))):
            res[r[0]] = r[1]
    return res


def diff_object(ctx, stage_db, spec, into=None, limit=200):
    """Compare a table recovered into a quarantine database with the live table (matched on primary key).
    Returns what exists only in the recovered copy (deleted since), only in the live table (added since) and what changed.
    Read-only on both sides."""
    import json
    parts = (spec or "").split(".")
    if len(parts) != 3:
        raise EngineError("PGA-GEN-082", "object must be database.schema.name")
    dbname, schema, name = parts
    if not (stage_db or "").startswith("pgarca_stage_"):
        raise EngineError("PGA-GEN-081", "only quarantine databases created by pg_arca can be compared (name starts with pgarca_stage_)")
    _check_name(stage_db, "quarantine database")
    admin = _dest_conn(ctx, into)
    fq = "%s.%s" % (quote_ident(schema), quote_ident(name))
    st = PgSession(admin.with_db(stage_db), read_only=True)
    lv = PgSession(admin.with_db(dbname), read_only=True)
    try:
        si, li = _table_info(st, fq), _table_info(lv, fq)
        if si is None:
            raise EngineError("PGA-GEN-083", "table %s not found in %s" % (fq, stage_db))
        if li is None:
            raise EngineError("PGA-GEN-085", "table %s does not exist in %s any more: use promote to bring it back as a whole" % (fq, dbname))
        if not si["pk"] or si["pk"] != li["pk"]:
            raise EngineError("PGA-GEN-086", "row-level comparison needs the same primary key on both sides (restored: %s, live: %s)" % (si["pk"] or "none", li["pk"] or "none"),
                              "tables without a primary key can only be recovered as a whole (promote)")
        for s_, label in ((st, "recovered"), (lv, "live")):
            n = int(s_.scalar("SELECT count(*) FROM %s" % fq))
            if n > ROW_DIFF_MAX:
                raise EngineError("PGA-GEN-087", "%s table has %d rows (limit %d for row-level comparison)" % (label, n, ROW_DIFF_MAX), "use promote, or restore into a side table and compare in SQL")
        common = [c for c in si["cols"] if c in li["cols"]]
        sdrop = {"drop": [c for c in si["cols"] if c not in common]}
        ldrop = {"drop": [c for c in li["cols"] if c not in common]}
        a = _keyhash(st, fq, si["pk"], sdrop)
        b = _keyhash(lv, fq, li["pk"], ldrop)
        only_old = sorted(k for k in a if k not in b)
        only_new = sorted(k for k in b if k not in a)
        changed = sorted(k for k in a if k in b and a[k] != b[k])
        out = {"object": spec, "primary_key": si["pk"], "restored_rows": len(a), "live_rows": len(b), "columns_only_in_one_side": sorted(set(si["cols"]) ^ set(li["cols"])),
               "counts": {"missing_now": len(only_old), "added_since": len(only_new), "changed": len(changed)}, "limit": limit}
        out["missing_now"] = [{"key": json.loads(k), "restored": json.loads(v)} for k, v in sorted(_sample(st, fq, si["pk"], only_old[:limit]).items())]
        out["added_since"] = [{"key": json.loads(k), "live": json.loads(v)} for k, v in sorted(_sample(lv, fq, li["pk"], only_new[:limit]).items())]
        sr, lr = _sample(st, fq, si["pk"], changed[:limit]), _sample(lv, fq, li["pk"], changed[:limit])
        out["changed"] = [{"key": json.loads(k), "restored": json.loads(sr[k]), "live": json.loads(lr[k])} for k in sorted(sr) if k in lr]
        return out
    finally:
        st.close()
        lv.close()


def apply_rows(ctx, stage_db, spec, restore_keys=(), delete_keys=(), into=None, dry_run=False):
    """Put selected rows from the quarantine copy back into the live table, in ONE transaction.
      restore_keys : primary keys (JSON arrays) to insert if missing or overwrite with the recovered version
      delete_keys  : primary keys (JSON arrays) of rows added after the restore point that should be removed
    Before touching anything the current version of every affected row is saved in pgarca_rowsafe_<ts>_<table>.
    Nothing is applied if any key cannot be found or the table definitions differ in a way that makes the copy unsafe."""
    import json
    parts = (spec or "").split(".")
    if len(parts) != 3:
        raise EngineError("PGA-GEN-082", "object must be database.schema.name")
    dbname, schema, name = parts
    if not (stage_db or "").startswith("pgarca_stage_"):
        raise EngineError("PGA-GEN-081", "only quarantine databases created by pg_arca can be used as source")
    _check_name(stage_db, "quarantine database")
    restore_keys, delete_keys = list(restore_keys or []), list(delete_keys or [])
    if not restore_keys and not delete_keys:
        raise EngineError("PGA-GEN-088", "no rows selected")
    if len(restore_keys) + len(delete_keys) > 50000:
        raise EngineError("PGA-GEN-089", "too many rows for one transaction (max 50000): use promote for large recoveries")
    for k in restore_keys + delete_keys:
        try:
            if not isinstance(json.loads(k), list):
                raise ValueError()
        except ValueError:
            raise EngineError("PGA-GEN-090", "invalid key %r (expected a JSON array of the primary key values)" % (k,))
    admin = _dest_conn(ctx, into)
    fq = "%s.%s" % (quote_ident(schema), quote_ident(name))
    st = PgSession(admin.with_db(stage_db), read_only=True)
    tg = PgSession(admin.with_db(dbname))
    try:
        si, li = _table_info(st, fq), _table_info(tg, fq)
        if si is None or li is None:
            raise EngineError("PGA-GEN-083", "table %s must exist both in the quarantine database and in %s" % (fq, dbname))
        if not li["pk"] or si["pk"] != li["pk"]:
            raise EngineError("PGA-GEN-086", "primary key differs or is missing (restored: %s, live: %s)" % (si["pk"] or "none", li["pk"] or "none"))
        writable = [c for c in li["cols"] if c in si["cols"] and c not in li["generated"]]
        missing = [c for c in li["cols"] if c not in si["cols"] and c not in li["generated"]]
        if missing and restore_keys:
            raise EngineError("PGA-GEN-091", "live table has columns that the restored table does not have (%s): rows would lose those values" % ", ".join(missing),
                              "use promote, or restore only after the columns were removed")
        keyexpr = "jsonb_build_array(%s)::text" % ",".join("t.%s" % quote_ident(c) for c in li["pk"])
        rows = _sample(st, fq, si["pk"], restore_keys) if restore_keys else {}
        absent = [k for k in restore_keys if k not in rows]
        if absent:
            raise EngineError("PGA-GEN-092", "%d key(s) not found in the recovered table, e.g. %s" % (len(absent), absent[0]))
        cur = _sample(tg, fq, li["pk"], restore_keys + delete_keys)
        will_insert = [k for k in restore_keys if k not in cur]
        will_update = [k for k in restore_keys if k in cur]
        will_delete = [k for k in delete_keys if k in cur]
        res = {"object": spec, "inserted": len(will_insert), "updated": len(will_update), "deleted": len(will_delete),
               "ignored_delete_keys": len(delete_keys) - len(will_delete), "dry_run": bool(dry_run)}
        if dry_run:
            return res
        ts = now_utc().strftime("%Y%m%d%H%M%S")
        safe = ("pgarca_rowsafe_%s_%s" % (ts, name))[:63]
        collist = ",".join(quote_ident(c) for c in writable)
        setlist = ",".join("%s=EXCLUDED.%s" % (quote_ident(c), quote_ident(c)) for c in writable if c not in li["pk"])
        ovr = " OVERRIDING SYSTEM VALUE" if li["identity_always"] else ""
        tg.query("BEGIN")
        try:
            touched = [k for k in restore_keys + delete_keys if k in cur]
            if touched:
                tg.query("CREATE TABLE %s.%s AS SELECT t.* FROM %s t WHERE %s = ANY(ARRAY[%s])" % (quote_ident(schema), quote_ident(safe), fq, keyexpr, ",".join(sql_lit(k) for k in touched)))
                res["safety_copy"] = "%s.%s" % (schema, safe)
            for i in range(0, len(restore_keys), 500):
                part = restore_keys[i:i + 500]
                doc = "[" + ",".join(rows[k] for k in part) + "]"      # rows[k] is already JSON text from to_jsonb(): re-encoding via Python floats would round numeric(38,x)
                conflict = ("DO UPDATE SET " + setlist) if setlist else "DO NOTHING"
                tg.query("INSERT INTO %s (%s)%s SELECT %s FROM jsonb_populate_recordset(NULL::%s, %s::jsonb) ON CONFLICT (%s) %s"
                         % (fq, collist, ovr, collist, fq, sql_lit(doc), ",".join(quote_ident(c) for c in li["pk"]), conflict))
            for i in range(0, len(will_delete), 500):
                part = will_delete[i:i + 500]
                tg.query("DELETE FROM %s t WHERE %s = ANY(ARRAY[%s])" % (fq, keyexpr, ",".join(sql_lit(k) for k in part)))
            tg.query("COMMIT")
        except BaseException:
            try:
                tg.query("ROLLBACK")
            except EngineError:
                pass
            raise
        return res
    finally:
        st.close()
        tg.close()
