"""Granular restore: a whole database or a single object at any point in time, via a sparse ephemeral instance.

Nothing existing is ever overwritten: databases are restored under a NEW name, objects into a NEW quarantine database.
Failure after the destination DB was created drops it again (all-or-nothing from the operator's point of view).
"""

import os
import shutil
import tempfile
import time

from pg_arca.engine.backup import build_chain
from pg_arca.engine.catalog import find_object
from pg_arca.engine.ephemeral import Ephemeral
from pg_arca.engine.pgsession import PgConn, PgSession, run_tool
from pg_arca.engine.restore import check_wal_for_chain, choose_set, count_targets, estimate, merge_chain, sparse_filter
from pg_arca.engine.util import EngineError, human, now_utc, parse_target_time, quote_ident, sql_lit

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
    target = choose_set(ctx.repo, set_spec, tt, target_lsn)
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


def _recover(ctx, chain, keep_oids, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel, name=None, immediate=False):
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
    eph, info = _recover(ctx, chain, {entry["oid"]}, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel)
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
                   into=None, stage_db=None, data_only=False, dry_run=False, progress=None, cancel=None):
    target, chain, tt = _plan(ctx, set_spec, target_time, target_lsn, target_xid, target_name)
    cat = ctx.repo.load_catalog(target)
    dbentry, rel = find_object(cat, spec)
    stage = stage_db or ("pgarca_stage_" + now_utc().strftime("%Y%m%dt%H%M%S"))
    _check_name(stage, "quarantine database name")
    merged_sel, _ = merge_chain(ctx.repo, chain, sparse_filter({dbentry["oid"], 1, 5}))
    merged_all, _ = merge_chain(ctx.repo, chain)
    plan = {"set": target["id"], "chain": [c["id"] for c in chain], "object": spec, "kind": rel["kind"], "size_in_backup": rel["size"],
            "quarantine_database": stage, "extract_bytes": estimate(merged_sel), "cluster_bytes": estimate(merged_all),
            "target": tt or target_lsn or target_xid or target_name or "end of archive"}
    plan["saved_pct"] = round(100.0 * (1 - plan["extract_bytes"] / float(max(plan["cluster_bytes"], 1))), 1)
    if dry_run:
        plan["dry_run"] = True
        return plan
    admin = _dest_conn(ctx, into)
    eph, info = _recover(ctx, chain, {dbentry["oid"]}, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel)
    created = False
    tmp = tempfile.mkdtemp(prefix="pgarca-obj-")
    fq = "%s.%s" % (quote_ident(rel["schema"]), quote_ident(rel["name"]))
    try:
        src = PgSession(eph.conn(dbentry["name"]), read_only=True)
        try:
            cnt = None
            if rel["kind"] in ("r", "p", "m"):
                cnt = src.scalar("SELECT count(*) FROM %s" % fq)
            info["rows_at_target"] = int(cnt) if cnt is not None else None
        except EngineError as e:
            raise EngineError("PGA-GEN-071", "object %s is not readable at the requested point in time: %s" % (spec, e.message),
                              "it may not exist yet at that time; choose a later target or inspect with the catalog")
        finally:
            src.close()
        if progress:
            progress({"phase": "transfer"})
        dumpfile = os.path.join(tmp, "obj.dump")
        args = eph.conn().args() + ["-Fc", "-Z", "3", "-t", fq, "-f", dumpfile, "-d", dbentry["name"]]
        if data_only:
            args.append("--data-only")
        rc, out, err = run_tool(eph.conn(), "pg_dump", args, timeout=None)
        if rc != 0:
            raise EngineError("PGA-GEN-072", "pg_dump of the object failed: %s" % err.strip()[:600])
        info["dump_bytes"] = os.path.getsize(dumpfile)
        _create_db(admin, stage, dbentry)
        created = True
        sc = PgSession(admin.with_db(stage))
        try:
            sc.query("CREATE SCHEMA IF NOT EXISTS %s" % quote_ident(rel["schema"]))
        finally:
            sc.close()
        _pg_restore(admin, stage, dumpfile, 1)
        if info["rows_at_target"] is not None:
            v = PgSession(admin.with_db(stage), read_only=True)
            try:
                got = int(v.scalar("SELECT count(*) FROM %s" % fq))
            finally:
                v.close()
            info["rows_restored"] = got
            if got != info["rows_at_target"]:
                raise EngineError("PGA-VRF-040", "verification failed: %d rows at target, %d restored" % (info["rows_at_target"], got))
        plan.update(info)
        plan["result_database"] = stage
        plan["inspect"] = "SELECT * FROM %s.%s LIMIT 20  (database %s)" % (rel["schema"], rel["name"], stage)
        plan["promote_hint"] = "pg_dump -Fc -t %s.%s %s | pg_restore -d <target_db> --no-owner   -- then DROP DATABASE %s" % (rel["schema"], rel["name"], stage, stage)
        return plan
    except BaseException:
        if created:
            _drop_db(admin, stage)
        raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        eph.cleanup()


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


def promote_object(ctx, stage_db, spec, mode="as_new", drop_stage=True, into=None):
    """
    Move a table recovered into a quarantine database back into the real database. Never destructive:
      as_new  : the recovered table appears next to the original as <name>_pitr_<ts>
      replace : the original is renamed <name>_old_<ts> (data kept), the recovered table takes its name
    Indexes and owned sequences of the table that gets the suffix are renamed too, so nothing collides. Foreign keys, views and
    functions that referenced the original keep pointing at it (we report how many), they are not rewired.
    """
    if mode not in ("as_new", "replace"):
        raise EngineError("PGA-GEN-080", "mode must be as_new or replace")
    if not stage_db or not stage_db.startswith("pgarca_stage_") and not stage_db.startswith("stage_"):
        raise EngineError("PGA-GEN-081", "only quarantine databases created by pg_arca can be promoted from (name starts with pgarca_stage_)")
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
                new_name = short(name, "_pitr_" + ts)
                sfx = "_pitr_" + ts
                idx, seq = dependents(work, name)
                tg.query("BEGIN")
                try:
                    for i in idx:
                        tg.query("ALTER INDEX %s.%s RENAME TO %s" % (quote_ident(work), quote_ident(i), quote_ident(short(i, sfx))))
                    for s_ in seq:
                        tg.query("ALTER SEQUENCE %s.%s RENAME TO %s" % (quote_ident(work), quote_ident(s_), quote_ident(short(s_, sfx))))
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
