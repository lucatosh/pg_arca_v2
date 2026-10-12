"""Granular restore: a whole database or a single object at any point in time, via a sparse ephemeral instance.

Nothing existing is ever overwritten: databases are restored under a NEW name, objects into a NEW quarantine database.
Failure after the destination DB was created drops it again (all-or-nothing from the operator's point of view).
"""

import json
import os
import shutil
import subprocess
import tempfile
import time

from pg_arca.engine.backup import build_chain
from pg_arca.engine import objects as objmod, restorecheck
from pg_arca.engine.catalog import find_object
from pg_arca.engine.ephemeral import Ephemeral, TargetNotReached
from pg_arca.engine.pgsession import PgConn, PgSession, run_dump, run_tool
from pg_arca.engine.restore import check_wal_for_chain, flush_current_wal, choose_set, count_targets, estimate, merge_chain, sparse_filter, system_db_oids
from pg_arca.engine.util import EngineError, human, lsn_to_int, now_utc, parse_target_time, quote_ident, sql_lit, target_time_to_dt, wal_name, wal_segno

import re as _re
_ID_OK = _re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,62}$")


def default_restore_name(db):
    """<db>_restored as a plain identifier: a source named 'Vendite Q1-2026' or "l'archivio" gives Vendite_Q1_2026_restored / l_archivio_restored."""
    import unicodedata
    base = unicodedata.normalize("NFKD", db).encode("ascii", "ignore").decode("ascii")
    base = _re.sub(r"[^A-Za-z0-9_]+", "_", base).strip("_") or "db"
    if base[0].isdigit():
        base = "db_" + base
    return base[:63 - len("_restored")] + "_restored"


def _check_name(n, what):
    if not _ID_OK.match(n or ""):
        raise EngineError("PGA-GEN-065", "invalid %s %r (letters, digits, _ and $; max 63; must not start with a digit)" % (what, n))


RESTORING_MARK = "pg_arca: restore IN PROGRESS"


def _create_placeholder_roles(admin, eph, names, db, warnings):
    """Roles the restored objects need, created as NOLOGIN placeholders: no password, no login, no superuser/createdb/createrole/replication/bypassrls,
    no memberships - an account deleted on purpose is never brought back to life; its objects simply keep their owner and grants. Returns the created names."""
    attrs = {}
    try:
        s = PgSession(eph.conn("postgres"), read_only=True)
        try:
            for r in s.query("SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname = ANY(ARRAY[%s])" % ",".join(sql_lit(n) for n in names)):
                attrs[r[0]] = "login" if r[1] == "t" else "nologin"
        finally:
            s.close()
    except EngineError:
        pass
    made = []
    d = PgSession(admin.with_db("postgres"))
    try:
        for n in names:
            try:
                d.query("CREATE ROLE %s NOLOGIN" % quote_ident(n))
                d.query("COMMENT ON ROLE %s IS %s" % (quote_ident(n), sql_lit("pg_arca: placeholder created %s by the restore of database %s (in the backup it was a %s role): "
                                                                           "it owns/holds grants of restored objects; no login, no password, no memberships"
                                                                           % (now_utc().strftime("%Y-%m-%d %H:%M UTC"), db, attrs.get(n, "?")))))
                made.append(n)
            except EngineError as e:
                warnings.append("role %s could not be created as a placeholder: %s" % (n, e.message[:160]))
    finally:
        d.close()
    if made:
        warnings.append("roles created as NOLOGIN placeholders (no password, no login, no memberships) to keep owners and privileges: %s" % ", ".join(made[:8]))
    return made


def _detach_subscriptions(admin, name, warnings):
    """Logical replication subscriptions come back DISABLED (pg_dump writes connect = false) but still carry the publisher's slot name: enabling
    one would take the real subscriber's slot, and a DROP SUBSCRIPTION to clean the copy up would connect to the publisher and DROP that slot,
    breaking production's replication. The copy's subscriptions are detached from the slot (slot_name = NONE): DROP is then local only."""
    s = PgSession(admin.with_db(name))
    try:
        subs = [r[0] for r in s.query("SELECT subname FROM pg_subscription WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database()) "
                                      "AND subslotname IS NOT NULL") if r and r[0]]
        done = []
        for sub in subs:
            try:
                s.query("ALTER SUBSCRIPTION %s DISABLE" % quote_ident(sub))
                s.query("ALTER SUBSCRIPTION %s SET (slot_name = NONE)" % quote_ident(sub))
                done.append(sub)
            except EngineError as e:
                warnings.append("subscription %s: could not be detached from the publisher's slot (%s) - do NOT enable or drop it before "
                                "ALTER SUBSCRIPTION %s SET (slot_name = NONE)" % (sub, e.message[:160], sub))
        if done:
            warnings.append("logical replication subscriptions restored DISABLED and detached from the publisher's slot (%s): dropping them is safe; to make "
                            "this copy a subscriber create a NEW slot on the publisher and ALTER SUBSCRIPTION ... SET (slot_name = '<new>') ... ENABLE"
                            % ", ".join(done[:6]))
    except EngineError as e:
        warnings.append("logical replication subscriptions not checked: %s" % e.message[:160])
    finally:
        s.close()


def _mark_db(admin, name, text):
    """A database being filled by a restore carries a comment saying so: if the agent dies half-way, the telemetry shows it as incomplete
    (never mistaken for a good copy). None removes it."""
    try:
        s = PgSession(admin.with_db("postgres"))
        try:
            s.query("COMMENT ON DATABASE %s IS %s" % (quote_ident(name), sql_lit(text) if text else "NULL"))
        finally:
            s.close()
    except EngineError:
        pass


def _stage_complete(admin, stage_db):
    s = PgSession(admin.with_db(stage_db), read_only=True)
    try:
        m = objmod.read_meta(s)
    finally:
        s.close()
    if m and m.get("building"):
        raise EngineError("PGA-GEN-094", "the quarantine database %s is incomplete: the restore that was building it did not finish" % stage_db,
                          "drop it and restore the objects again")


def _check_cancel(cancel):
    if cancel and cancel():
        from pg_arca.engine.util import Cancelled
        raise Cancelled()


def _spec3(spec):
    """db.schema.name with quoted parts allowed (a name with a dot: db."a.b".t); [] when malformed."""
    from pg_arca.engine.util import split_spec
    try:
        return split_spec(spec or "")
    except ValueError:
        return []


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
    missing = check_wal_for_chain(ctx, chain, target_lsn, target_time=tt, to_end=not (tt or target_lsn or target_xid or target_name or immediate))
    if missing:
        raise EngineError("PGA-WAL-022", "WAL archive is missing %d segment(s) required (first: %s)" % (len(missing), missing[0]),
                          "recovery past the gap is impossible; choose an earlier point in time, another set, or repair the archive (WAL rescue / the primary's pg_wal)")
    return target, chain, tt


def _plan_for_db(ctx, db, set_spec, target_time, target_lsn, target_xid, target_name, immediate=False):
    """_plan() for a restore that is about ONE database. When nothing pins the point in time and the database is not in the newest backup (it was dropped before that backup
    was taken), the newest backup that still contains it is used and recovery runs to the end of the archive: _recover_db stops just before the DROP DATABASE. Returns (target, chain, tt, note)."""
    target, chain, tt = _plan(ctx, set_spec, target_time, target_lsn, target_xid, target_name, immediate)
    if set_spec or target_time or target_lsn or target_xid or target_name or immediate:
        return target, chain, tt, None
    try:
        if db in ctx.repo.load_catalog(target)["databases"]:
            return target, chain, tt, None
    except EngineError:
        return target, chain, tt, None
    for s in reversed(ctx.repo.complete_sets()):
        if s["id"] == target["id"]:
            continue
        try:
            if db in ctx.repo.load_catalog(s)["databases"]:
                t2, c2, tt2 = _plan(ctx, s["id"], None, None, None, None)
                return t2, c2, tt2, "database '%s' is not in the newest backup (it was dropped earlier): restored from %s, up to just before it was dropped" % (db, s["id"])
        except EngineError:
            continue
    return target, chain, tt, None


# GUCs whose value is a list of quoted items (pg_dump's variable_is_guc_list_quote): ALTER DATABASE ... SET needs each item as its own literal
_GUC_LIST_QUOTE = ("local_preload_libraries", "search_path", "session_preload_libraries", "shared_preload_libraries", "temp_tablespaces", "unix_socket_directories")


def _guc_set_value(name, value):
    if name.lower() in _GUC_LIST_QUOTE:
        items, cur, q = [], "", False
        for ch in value:
            if ch == '"':
                q = not q
                cur += ch
            elif ch == "," and not q:
                items.append(cur.strip())
                cur = ""
            else:
                cur += ch
        items.append(cur.strip())
        return ", ".join(sql_lit(x) for x in items if x != "") or "''"
    return sql_lit(value)


def db_props(eph, db):
    """What pg_dump (without --create) leaves out about a DATABASE: owner, privileges, connection limit, comment, locale provider, database-wide and
    per-role settings. Read from the recovered instance (the state at the target)."""
    s = PgSession(eph.conn("postgres"), read_only=True)
    try:
        major = int(s.scalar("SHOW server_version_num")) // 10000
        loc = "NULL::text, NULL::text, NULL::text"
        if major >= 17:
            loc = "d.datlocprovider::text, d.datlocale, d.daticurules"
        elif major >= 16:
            loc = "d.datlocprovider::text, d.daticulocale, d.daticurules"
        elif major >= 15:
            loc = "d.datlocprovider::text, d.daticulocale, NULL::text"
        r = s.scalar("""SELECT json_build_object('owner', pg_get_userbyid(d.datdba), 'connlimit', d.datconnlimit, 'comment', shobj_description(d.oid, 'pg_database'),
  'tablespace', (SELECT spcname FROM pg_tablespace WHERE oid = d.dattablespace),
  'acl', CASE WHEN d.datacl IS NULL THEN NULL ELSE (SELECT coalesce(json_agg(json_build_object('g', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
         'p', a.privilege_type, 'o', a.is_grantable)), '[]'::json) FROM aclexplode(d.datacl) a) END,
  'provider', x.p, 'locale', x.l, 'rules', x.r,
  'settings', (SELECT coalesce(json_agg(json_build_object('role', CASE WHEN st.setrole = 0 THEN NULL ELSE pg_get_userbyid(st.setrole) END, 'config', st.setconfig)), '[]'::json)
               FROM pg_db_role_setting st WHERE st.setdatabase = d.oid))::text
FROM pg_database d, LATERAL (SELECT %s) x(p, l, r) WHERE d.datname = %s""" % (loc, sql_lit(db)))
        return json.loads(r) if r else None
    except EngineError:
        return None
    finally:
        s.close()


def _apply_db_props(admin, name, props, warnings):
    """Give the new database the properties of the original (roles that do not exist here are skipped and reported). Never fails the restore."""
    if not props:
        return
    s = PgSession(admin.with_db("postgres"))
    try:
        roles = {r[0] for r in s.query("SELECT rolname FROM pg_roles")}
        qn = quote_ident(name)

        def run(sql, what):
            try:
                s.query(sql)
            except EngineError as e:
                warnings.append("database %s: %s not applied (%s)" % (name, what, e.message[:160]))
        own = props.get("owner")
        if own and own in roles:
            run("ALTER DATABASE %s OWNER TO %s" % (qn, quote_ident(own)), "owner %s" % own)
        elif own:
            warnings.append("database %s: owner %s does not exist on this server, the database belongs to %s" % (name, own, admin.user or "the connecting user"))
        if props.get("connlimit") not in (None, -1):
            run("ALTER DATABASE %s CONNECTION LIMIT %d" % (qn, int(props["connlimit"])), "connection limit")
        if props.get("comment"):
            run("COMMENT ON DATABASE %s IS %s" % (qn, sql_lit(props["comment"])), "comment")
        if props.get("acl") is not None:                    # NULL = the defaults (CONNECT + TEMP to PUBLIC), already what a new database has
            run("REVOKE ALL ON DATABASE %s FROM PUBLIC" % qn, "privileges")
            for a in props["acl"]:
                if a["g"] != "PUBLIC" and a["g"] not in roles:
                    warnings.append("database %s: %s for role %s not granted (the role does not exist here)" % (name, a["p"], a["g"]))
                    continue
                run("GRANT %s ON DATABASE %s TO %s%s" % (a["p"], qn, "PUBLIC" if a["g"] == "PUBLIC" else quote_ident(a["g"]), " WITH GRANT OPTION" if a.get("o") else ""),
                    "%s for %s" % (a["p"], a["g"]))
        for st in props.get("settings") or []:
            role = st.get("role")
            if role and role not in roles:
                warnings.append("database %s: settings of role %s not applied (the role does not exist here)" % (name, role))
                continue
            for kv in st.get("config") or []:
                k, _, v = kv.partition("=")
                if not _re.match(r"^[A-Za-z_][A-Za-z0-9_.]*$", k):
                    continue
                pre = ("ALTER ROLE %s IN DATABASE %s" % (quote_ident(role), qn)) if role else ("ALTER DATABASE %s" % qn)
                run("%s SET %s = %s" % (pre, k, _guc_set_value(k, v)), "setting %s" % k)
    finally:
        s.close()


def _create_db(admin, name, entry, props=None):
    s = PgSession(admin.with_db("postgres"))
    try:
        if s.scalar("SELECT 1 FROM pg_database WHERE datname=%s" % sql_lit(name)) == "1":
            raise EngineError("PGA-SEC-030", "destination database '%s' already exists" % name, "choose another name; existing databases are never overwritten")
        enc = entry.get("encoding") or "UTF8"
        extra = ""
        if entry.get("collate") and entry.get("ctype"):
            extra = " LC_COLLATE %s LC_CTYPE %s" % (sql_lit(entry["collate"]), sql_lit(entry["ctype"]))
        dmajor = int(s.scalar("SHOW server_version_num")) // 10000
        ts = (props or {}).get("tablespace")
        if ts and ts != "pg_default":                    # the database lived in its own default tablespace: same here when it exists
            if s.scalar("SELECT 1 FROM pg_tablespace WHERE spcname = %s" % sql_lit(ts)) == "1":
                extra += " TABLESPACE %s" % quote_ident(ts)
            else:
                props.setdefault("_warnings", []).append("database %s: created in pg_default, the original default tablespace %s does not exist on this server" % (name, ts))
        prov = (props or {}).get("provider")
        if prov == "i" and (props or {}).get("locale") and dmajor >= 15:         # ICU: same provider and locale (sorting / unique indexes on text behave the same)
            extra += " LOCALE_PROVIDER icu ICU_LOCALE %s" % sql_lit(props["locale"])
            if props.get("rules") and dmajor >= 16:
                extra += " ICU_RULES %s" % sql_lit(props["rules"])
        elif prov == "b" and (props or {}).get("locale") and dmajor >= 17:
            extra += " LOCALE_PROVIDER builtin BUILTIN_LOCALE %s" % sql_lit(props["locale"])
        try:
            s.query("CREATE DATABASE %s TEMPLATE template0 ENCODING %s%s" % (quote_ident(name), sql_lit(enc), extra))
        except EngineError:
            s.query("CREATE DATABASE %s TEMPLATE template0 ENCODING %s" % (quote_ident(name), sql_lit(enc)))
            if prov in ("i", "b"):
                (props.setdefault("_warnings", [])).append("database %s: created WITHOUT the original locale provider (%s %s): not available on this server" % (name, "ICU" if prov == "i" else "builtin", props.get("locale")))
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


from pg_arca.engine.catalog import ROLES_USED_SQL  # noqa: E402  (one definition: the backup catalog records it per database too)


def roles_used(conn):
    """Every role a database's objects mention (owners, grantees and grantors, policy roles, default privileges): restoring owners and privileges
    needs all of them on the destination."""
    s = PgSession(conn, read_only=True)
    try:
        return [r[0] for r in s.query(ROLES_USED_SQL) if r and r[0]]
    finally:
        s.close()


def _pg_restore(admin, dbname, dumpfile, jobs, extra=(), keep_owners=False, cancel=None):
    args = admin.args() + ["-d", dbname] + ([] if keep_owners else ["--no-owner", "--no-acl"]) + ["--exit-on-error", "-j", str(max(1, jobs))] + list(extra) + [dumpfile]
    rc, out, err = run_tool(admin, "pg_restore", args, timeout=None, cancel=cancel)
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
    PostgreSQL damages the database BEFORE the drop commits and without a timestamp: from PG15 (and PG 12-14 since their 2023 minor releases) it first marks it INVALID with an in-place update (replayed even if the
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
            # the previous segment was never fetched by the search above (it stops at the segment holding the DROP), but the invalid-marking can sit at its
            # very end when the DROP DATABASE straddles a segment boundary (seen on PostgreSQL 14 in the matrix: only the DROP's segment was looked at)
            name = names.get(seg) or (wal_name(tli, seg, seg_size) if ctx.wal.has_segment(wal_name(tli, seg, seg_size)) else None)
            if not name:
                continue
            names[seg] = name
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
            name = names.get(seg) or (wal_name(tli, seg, seg_size) if ctx.wal.has_segment(wal_name(tli, seg, seg_size)) else None)
            if not name:
                break
            names[seg] = name
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
    s = PgSession(eph.conn("postgres"), read_only=True)
    try:
        row = s.query("SELECT datconnlimit, dattablespace::int, (SELECT spcname FROM pg_tablespace WHERE oid = dattablespace) FROM pg_database WHERE oid = %s" % int(entry["oid"]))
    finally:
        s.close()
    if not row or not row[0]:
        eph.unusable = "no pg_database row for oid %s" % entry["oid"]
        return False
    # the database's directory lives in its DEFAULT tablespace: base/<oid> for pg_default, pg_tblspc/<spc>/PG_<ver>_<cat>/<oid> otherwise
    if row[0][2] == "pg_default":
        found = os.path.isdir(os.path.join(eph.dir, "base", str(entry["oid"])))
    else:
        import glob as _glob
        found = bool(_glob.glob(os.path.join(eph.dir, "pg_tblspc", str(row[0][1]), "*", str(entry["oid"]))))
    if not found:
        eph.unusable = "directory of database oid %s missing (tablespace %s)" % (entry["oid"], row[0][2])
        return False
    eph.unusable = "pg_database row: %r" % (row,)
    return row[0][0] != "-2"


def _late_entry(ctx, cat, db, target, tt, target_lsn, target_xid, target_name):
    """Catalog entry of `db` in the base backup, or - when the database was CREATED AFTER that backup - a placeholder: the recovery rebuilds it from the WAL alone
    (CREATE DATABASE is replayed; its oid, encoding and size are read from the recovered instance). Only possible when the recovery really goes past the backup."""
    if db in cat["databases"]:
        return cat["databases"][db]
    return {"name": db, "oid": None, "size": 0, "relations": [], "late": True, "base_set": target["id"]}


def _all_live(ctx, db, sel, dbentry):
    """True when every selected object that the base backup's catalog does not know exists in the live database now."""
    rels = dbentry.get("relations", [])
    try:
        s = PgSession(ctx.conn.with_db(db), read_only=True)
    except EngineError:
        return False
    try:
        for o in sel:
            if o["kind"] == "schema":
                if any(r["schema"] == o["schema"] for r in rels):
                    continue
                if s.scalar("SELECT to_regnamespace(%s) IS NOT NULL" % sql_lit(quote_ident(o["schema"]))) != "t":
                    return False
            else:
                if any(r["schema"] == o["schema"] and r["name"] == o["name"] for r in rels):
                    continue
                if s.scalar("SELECT to_regclass(%s) IS NOT NULL" % sql_lit(objmod.qi(o["schema"], o["name"]))) != "t":
                    return False
        return True
    except EngineError:
        return False
    finally:
        s.close()


def _late_check(entry, what):
    return {"id": "late_db", "level": "warn",
            "text": "%s is not in backup %s: it was created after that backup, so it is rebuilt from the WAL alone (size unknown in advance)" % (what, entry.get("base_set") or "?"),
            "fix": "if it did not exist yet at the chosen time the restore stops after the recovery and says so; a later backup makes this faster and cheaper"}


def _recover_db(ctx, chain, entry, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel):
    """_recover() for a recovery whose purpose is to read database `entry`: if that database was dropped right after the target, it is already damaged in the recovered
    instance (see find_drop_database_lsn). We then stop BEFORE the DROP DATABASE transaction (exclusive LSN) and say so (`stopped_before_drop`)."""
    if entry.get("oid") is None:                          # created after the base backup: only the WAL knows it
        # CREATE DATABASE with the FILE_COPY strategy (the only one up to PostgreSQL 14, optional later) is replayed by COPYING the template's files:
        # template1 is always extracted, template0 must be too (CREATE DATABASE ... TEMPLATE template0 is common for a specific encoding/locale)
        keep = set()
        try:
            cat = ctx.repo.load_catalog(chain[-1])
            t0 = cat["databases"].get("template0")
            if t0 and t0.get("oid"):
                keep.add(int(t0["oid"]))
            # a USER database used as template (CREATE DATABASE b TEMPLATE a, FILE_COPY): its files are copied by the replay -> extract it too.
            # Found in the WAL since the backup (Database records only: cheap, cached)
            from pg_arca.engine import walscan
            known = set(int(d["oid"]) for d in cat["databases"].values() if d.get("oid"))
            r = walscan.scan(ctx, mode="databases", since_backup=True, limit=200, cache_dir=getattr(ctx, "forensics_cache", None), budget_sec=300, keep_creates=True)
            for e in r.get("creates") or []:
                src = int(e["rels"][0][0])
                if src in known:
                    keep.add(src)
        except EngineError as e:
            ctx.log("warning", "templates of databases created after the backup not determined: %s" % e.message)
        eph, info = _recover(ctx, chain, keep, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel)
        s = PgSession(eph.conn("postgres"), read_only=True)
        try:
            row = s.query("SELECT oid::int, pg_encoding_to_char(encoding), datcollate, datctype FROM pg_database WHERE datname = %s" % sql_lit(entry["name"]))
        finally:
            s.close()
        if row and row[0]:
            entry.update(oid=int(row[0][0]), encoding=row[0][1], collate=row[0][2], ctype=row[0][3])
            if _db_usable(eph, entry):
                info["created_after_backup"] = True
                return eph, info
        eph.cleanup()
        raise EngineError("PGA-PITR-016", "database '%s' did not exist yet at the requested point: it is not in backup %s and the WAL up to the target does not create it"
                          % (entry["name"], entry.get("base_set") or "?"), "choose a later time")
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
                     into=None, new_name=None, jobs=2, dry_run=False, progress=None, cancel=None, create_missing_roles=False):
    """create_missing_roles: roles the database's objects name that the destination does not have are created as NOLOGIN placeholders without password
    (never a reactivated account), so owners and privileges are kept exactly; otherwise owners/privileges are skipped and the roles listed."""
    target, chain, tt, note = _plan_for_db(ctx, db, set_spec, target_time, target_lsn, target_xid, target_name)
    cat = ctx.repo.load_catalog(target)
    entry = _late_entry(ctx, cat, db, target, tt, target_lsn, target_xid, target_name)
    new_name = new_name or default_restore_name(db)
    _check_name(new_name, "destination database name")
    merged_sel, _ = merge_chain(ctx.repo, chain, sparse_filter(({entry["oid"]} if entry["oid"] is not None else set()) | system_db_oids(cat)))
    merged_all, _ = merge_chain(ctx.repo, chain)
    plan = {"set": target["id"], "chain": [c["id"] for c in chain], "database": db, "destination_database": new_name,
            "extract_bytes": estimate(merged_sel), "cluster_bytes": estimate(merged_all),
            "target": tt or target_lsn or target_xid or target_name or "end of archive"}
    if note:
        plan["note"] = note
    plan["saved_pct"] = round(100.0 * (1 - plan["extract_bytes"] / float(max(plan["cluster_bytes"], 1))), 1)
    plan["database_bytes"] = entry["size"]
    taken = None
    dest_err = None
    dest_standby = False
    try:                                                                                 # fail fast BEFORE the long recovery (and show it in the plan)
        admin = _dest_conn(ctx, into)
        s = PgSession(admin.with_db("postgres"), read_only=True)
        try:
            if s.scalar("SELECT 1 FROM pg_database WHERE datname=%s" % sql_lit(new_name)) == "1":
                taken = new_name
            dest_standby = s.scalar("SELECT pg_is_in_recovery()") == "t"
            if entry.get("roles"):                          # recorded by the backup's catalog: known before the recovery
                have = {r[0] for r in s.query("SELECT rolname FROM pg_roles")}
                plan["missing_roles"] = [r for r in entry["roles"] if r not in have]
        finally:
            s.close()
    except Exception as e:
        if not dry_run:
            raise
        dest_err = str(e)                                  # the plan still shows everything else; the unreachable destination becomes a blocker in it
        ctx.log("warning", "plan: cannot look at the live cluster: %s" % e)
    if entry.get("late") and not entry["size"] and not dest_err:
        try:                                               # best guess for the space check: the database as it is now
            s = PgSession(admin.with_db("postgres"), read_only=True)
            try:
                v = s.scalar("SELECT pg_database_size(oid) FROM pg_database WHERE datname = %s" % sql_lit(db))
                entry["size"] = int(v) if v and v.isdigit() else 0
            finally:
                s.close()
        except Exception:
            pass
    checks = restorecheck.check(ctx, plan, merged_sel, target, need_dest=entry["size"], into=into, name_taken=taken)
    if entry.get("late"):
        checks.append(_late_check(entry, "database '%s'" % db))
        plan["created_after_backup"] = True
    if plan.get("missing_roles"):
        mr = ", ".join(plan["missing_roles"][:8])
        if create_missing_roles:
            checks.append({"id": "roles", "level": "ok", "text": "roles missing on the destination (%s) will be created as NOLOGIN placeholders without password: owners and privileges are kept" % mr})
        else:
            checks.append({"id": "roles", "level": "warn", "text": "roles missing on the destination (%s): owners and privileges of the database's objects will NOT be restored" % mr,
                           "fix": "create those roles first, or let the restore create them as NOLOGIN placeholders (no password, no login)"})
    if dest_standby:
        checks.append({"id": "dest_standby", "level": "bad", "text": "the server that would receive the result is a standby (read-only): nothing can be created there",
                       "fix": "run the restore from the primary's node, or set the delivery address in the recovery instance settings to the primary (HAProxy / VIP of the leader)"})
    if dest_err:
        where = ("%s:%s" % (into.get("host"), into.get("port", 5432))) if isinstance(into, dict) else "the local PostgreSQL"
        last = dest_err.strip().splitlines()[-1] if dest_err.strip() else dest_err
        checks.append({"id": "dest_reach", "level": "bad", "text": "the recovery host cannot reach the cluster that receives the result (%s): %s" % (where, last[:200]),
                       "fix": "set the delivery address in the recovery instance settings (e.g. the HAProxy / VIP of the leader), or open network and pg_hba from this host"})
    plan["preflight"] = restorecheck.summarize(checks)
    if dry_run:
        plan["dry_run"] = True
        return plan
    restorecheck.enforce(checks)
    if progress:
        progress({"phase": "wal_flush"})
    flushed = flush_current_wal(ctx, chain, tt, target_lsn, target_xid, target_name, cancel=cancel)
    eph, info = _recover_db(ctx, chain, entry, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel)
    if flushed:
        info["wal_flushed"] = flushed
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
        rc, out, err = run_dump(eph.conn(db), eph.conn(db).args() + ["-f", dumpfile, "-d", db], cancel=cancel)
        if rc != 0:
            raise EngineError("PGA-GEN-070", "pg_dump from the recovered instance failed: %s" % err.strip()[:600],
                              "the sparse extraction may lack a page needed by this database; retry with a different base set")
        info["dump_bytes"] = os.path.getsize(dumpfile)
        _check_cancel(cancel)
        props = db_props(eph, db)
        warns = []
        # owners and privileges come back too, unless the destination lacks some of the roles they name (then: none of them, and the list says which roles)
        try:
            used = roles_used(eph.conn(db))
        except EngineError as e:
            used, warns = None, ["could not list the roles the database uses (%s): owners and privileges were NOT restored" % e.message[:120]]
        missing = []
        if used is not None:
            d = PgSession(admin.with_db("postgres"), read_only=True)
            try:
                have = {r[0] for r in d.query("SELECT rolname FROM pg_roles")}
            finally:
                d.close()
            missing = [r for r in used if r not in have]
        if missing and create_missing_roles:
            made = _create_placeholder_roles(admin, eph, missing, db, warns)
            info["roles_created"] = made
            missing = [r for r in missing if r not in made]
        keep = used is not None and not missing
        if missing:
            warns.append("roles missing on this server (%s): object owners and privileges were NOT restored; create the roles and restore again to keep them" % ", ".join(missing[:8]))
        info["owners_and_privileges"] = keep
        extra = []
        used_ts = []
        try:
            ts_s = PgSession(eph.conn(db), read_only=True)
            try:
                used_ts = [r[0] for r in ts_s.query("SELECT DISTINCT t.spcname FROM pg_class c JOIN pg_tablespace t ON t.oid = c.reltablespace "
                                                    "WHERE c.reltablespace <> 0 AND t.spcname NOT IN ('pg_default', 'pg_global')")]
            finally:
                ts_s.close()
        except EngineError:
            pass
        if used_ts:
            d = PgSession(admin.with_db("postgres"), read_only=True)
            try:
                have_ts = {r[0] for r in d.query("SELECT spcname FROM pg_tablespace")}
            finally:
                d.close()
            gone_ts = [t for t in used_ts if t not in have_ts]
            if gone_ts:
                extra.append("--no-tablespaces")
                warns.append("tablespaces missing on this server (%s): every object was created in the database's default tablespace" % ", ".join(gone_ts))
        _create_db(admin, new_name, entry, props)
        created = True
        _mark_db(admin, new_name, "%s since %s (from %s at %s): incomplete until this comment is gone - do not use" % (RESTORING_MARK, now_utc().isoformat(timespec="seconds"), db, plan.get("target")))
        _pg_restore(admin, new_name, dumpfile, jobs, extra=extra, keep_owners=keep, cancel=cancel)
        _check_cancel(cancel)                              # cancelled while the last step finished: the new database is removed, as promised
        _detach_subscriptions(admin, new_name, warns)
        try:
            us = PgSession(admin.with_db(new_name), read_only=True)
            try:
                unl = [r[0] for r in us.query("SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relpersistence = 'u' "
                                             "AND c.relkind IN ('r', 'p') ORDER BY 1") if r and r[0]]
            finally:
                us.close()
            if unl:
                warns.append("%d UNLOGGED table(s) restored EMPTY: their rows are in no backup (%s)" % (len(unl), ", ".join(unl[:6])))
        except EngineError:
            pass
        warns += list((props or {}).pop("_warnings", []) if props else [])
        _mark_db(admin, new_name, None)                    # complete: the marker goes (the original comment, if any, is set right after)
        _apply_db_props(admin, new_name, props, warns)
        if warns:
            info["warnings"] = (info.get("warnings") or []) + warns
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
    target, chain, tt, _note = _plan_for_db(ctx, db, set_spec, target_time, target_lsn, target_xid, target_name)
    cat = ctx.repo.load_catalog(target)
    dbentry = _late_entry(ctx, cat, db, target, tt, target_lsn, target_xid, target_name)
    late_objs, late_live = None, False
    try:
        nrel = objmod.selection_in_catalog(dbentry, sel) if not dbentry.get("late") else None
    except EngineError as e:
        if e.code != "PGA-GEN-032":
            raise
        # not in the base backup: created after it (the recovery replays it from the WAL). Typical: made this morning, dropped by mistake at noon - so it
        # is NOT refused when it is missing now too; the plan says clearly that a wrong name is only found after the recovery
        nrel, late_objs = None, e.message
        late_live = _all_live(ctx, db, sel, dbentry)
    label = ", ".join(("%s.%s" % (o["schema"], o["name"])) if o["kind"] == "rel" else ("schema %s" % o["schema"]) for o in sel)
    stage = stage_db or ("pgarca_stage_" + now_utc().strftime("%Y%m%dt%H%M%S"))
    if not stage.startswith("pgarca_stage_"):
        raise EngineError("PGA-GEN-081", "a quarantine database name must start with pgarca_stage_ (pg_arca drops it after promotion: it must never be a user database)")
    _check_name(stage, "quarantine database name")
    merged_sel, _ = merge_chain(ctx.repo, chain, sparse_filter(({dbentry["oid"]} if dbentry["oid"] is not None else set()) | system_db_oids(cat)))
    merged_all, _ = merge_chain(ctx.repo, chain)
    size_in_backup = sum(o["size"] for o in objmod_user_sizes(dbentry, sel))
    plan = {"set": target["id"], "chain": [c["id"] for c in chain], "object": label, "selection": sel, "relations_in_backup": nrel, "size_in_backup": size_in_backup,
            "quarantine_database": stage, "extract_bytes": estimate(merged_sel), "cluster_bytes": estimate(merged_all),
            "target": tt or target_lsn or target_xid or target_name or "end of archive"}
    plan["saved_pct"] = round(100.0 * (1 - plan["extract_bytes"] / float(max(plan["cluster_bytes"], 1))), 1)
    taken = None
    dest_err = None
    dest_standby = False
    try:
        admin = _dest_conn(ctx, into)
        s = PgSession(admin.with_db("postgres"), read_only=True)
        try:
            if s.scalar("SELECT 1 FROM pg_database WHERE datname=%s" % sql_lit(stage)) == "1":
                taken = stage
            dest_standby = s.scalar("SELECT pg_is_in_recovery()") == "t"
        finally:
            s.close()
    except Exception as e:
        if not dry_run:
            raise
        dest_err = str(e)                                  # the plan still shows everything else; the unreachable destination becomes a blocker in it
        ctx.log("warning", "plan: cannot look at the live cluster: %s" % e)
    checks = restorecheck.check(ctx, plan, merged_sel, target, need_dest=size_in_backup, into=into, name_taken=taken, scope="object")
    if dbentry.get("late"):
        checks.append(_late_check(dbentry, "database '%s'" % db))
        plan["created_after_backup"] = True
    elif late_objs:
        if late_live:
            checks.append({"id": "late_obj", "level": "warn", "text": "%s %s: it was created after that backup and is rebuilt from the WAL" % (late_objs, target["id"]),
                           "fix": "if it did not exist yet at the chosen time the restore stops after the recovery and says so"})
        else:
            checks.append({"id": "late_obj_unknown", "level": "warn",
                           "text": "%s %s and it does not exist in %s now: it comes back only if it was created after that backup (and dropped since)" % (late_objs, target["id"], db),
                           "fix": "check the name: a wrong one is only found after the recovery; tables created and dropped after the backup are listed by the WAL forensics"})
        plan["created_after_backup"] = True
    if dest_standby:
        checks.append({"id": "dest_standby", "level": "bad", "text": "the server that would receive the result is a standby (read-only): nothing can be created there",
                       "fix": "run the restore from the primary's node, or set the delivery address in the recovery instance settings to the primary (HAProxy / VIP of the leader)"})
    if dest_err:
        where = ("%s:%s" % (into.get("host"), into.get("port", 5432))) if isinstance(into, dict) else "the local PostgreSQL"
        last = dest_err.strip().splitlines()[-1] if dest_err.strip() else dest_err
        checks.append({"id": "dest_reach", "level": "bad", "text": "the recovery host cannot reach the cluster that receives the result (%s): %s" % (where, last[:200]),
                       "fix": "set the delivery address in the recovery instance settings (e.g. the HAProxy / VIP of the leader), or open network and pg_hba from this host"})
    plan["preflight"] = restorecheck.summarize(checks)
    if dry_run:
        plan["dry_run"] = True
        return plan
    restorecheck.enforce(checks)
    if progress:
        progress({"phase": "wal_flush"})
    flushed = flush_current_wal(ctx, chain, tt, target_lsn, target_xid, target_name, cancel=cancel)
    eph, info = _recover_db(ctx, chain, dbentry, tt, target_lsn, target_xid, target_name, inclusive, progress, cancel)
    if flushed:
        info["wal_flushed"] = flushed
    created = False
    try:
        src = PgSession(eph.conn(db), read_only=True)
        try:
            an = objmod.analyze(src, sel)
        finally:
            src.close()

        sprops = db_props(eph, db)

        def make():
            _create_db(admin, stage, dbentry, {k: v for k, v in (sprops or {}).items() if k in ("provider", "locale", "rules")})
        created = True
        meta = objmod.build_stage(admin, eph, dbentry, sel, label, stage, an, plan, progress, create_db=make, cancel=cancel)
        _check_cancel(cancel)
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


def _promote_space(ctx, stage_db, into):
    """The promotion copies the quarantined tables INTO the live database (the old ones are kept as _old_<ts> with replace): the live data volume needs about
    the size of the quarantined tables again, while the quarantine database still exists. Checked before anything is touched. None when it cannot be known."""
    if into or not ctx.pgdata:
        return None
    try:
        s = PgSession(_dest_conn(ctx, None).with_db(stage_db), read_only=True)
        try:
            need = int(s.scalar("SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                                "WHERE c.relkind IN ('r','m') AND n.nspname NOT IN ('pg_catalog','information_schema','pgarca_meta') AND n.nspname NOT LIKE 'pg\\_%'") or 0)
        finally:
            s.close()
    except Exception as e:
        ctx.log("warning", "promotion space check skipped: %s" % e)
        return None
    checks = []
    vols = restorecheck.volumes([("data", ctx.pgdata, int(need * 1.1))])
    restorecheck.space_checks(vols, lambda cid, level, text, fix=None, **kw: checks.append(dict({"id": cid, "level": level, "text": text}, **({"fix": fix} if fix else {}))))
    out = restorecheck.summarize(checks)
    out["space"] = [{"paths": v["paths"], "roles": v["roles"], "need": v["need"], "free": v["free"], "total": v["total"], "free_after": v.get("free_after")} for v in vols]
    return out


def _process_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def cleanup_interrupted_promotions(ctx):
    """Promotions whose agent died between loading the recovered tables under temporary names and the swap (journal left on disk): drop exactly the
    temporary tables / sequences they had created (names with the promotion's own timestamp suffix) and forget the journal. Returns what was removed."""
    import json
    jdir = getattr(ctx, "promote_journal_dir", None)
    out = []
    if not jdir or not os.path.isdir(jdir):
        return out
    for f in sorted(os.listdir(jdir)):
        if not f.startswith("promote-") or not f.endswith(".json"):
            continue
        p = os.path.join(jdir, f)
        try:
            with open(p) as fh:
                j = json.load(fh)
        except (OSError, ValueError):
            continue
        if p in objmod.ACTIVE_JOURNALS:
            continue                                      # a promotion running right now in this agent (another cluster's lane)
        pid = int(j.get("pid") or 0)
        if pid and pid != os.getpid() and _process_alive(pid):
            continue                                      # another live process owns it (a second agent / a CLI run): not interrupted
        sfx = j.get("suffix") or ""
        try:
            admin = _dest_conn(ctx, j.get("into"))
            s = PgSession(admin.with_db(j["database"]))
            try:
                for sch, nm in j.get("tables") or []:
                    if sfx and sfx in nm:                                                       # only the temporary names of that promotion
                        if s.scalar("SELECT to_regclass(%s) IS NOT NULL" % sql_lit("%s.%s" % (quote_ident(sch), quote_ident(nm)))) == "t":
                            s.query("DROP TABLE %s.%s CASCADE" % (quote_ident(sch), quote_ident(nm)))
                            out.append("%s.%s" % (sch, nm))
                for sch, nm in j.get("sequences") or []:
                    # a sequence created ONLY for that promotion (it did not exist live): dropped only when nothing uses it now
                    if s.scalar("SELECT to_regclass(%s) IS NOT NULL" % sql_lit("%s.%s" % (quote_ident(sch), quote_ident(nm)))) == "t" and \
                            s.scalar("SELECT count(*) FROM pg_depend WHERE refobjid = %s::regclass AND deptype = 'n'" % sql_lit("%s.%s" % (quote_ident(sch), quote_ident(nm)))) == "0":
                        s.query("DROP SEQUENCE %s.%s" % (quote_ident(sch), quote_ident(nm)))
                        out.append("%s.%s" % (sch, nm))
            finally:
                s.close()
            os.unlink(p)
            ctx.log("warning", "interrupted promotion into %s cleaned up: %s" % (j.get("database"), ", ".join(out) or "nothing left"))
        except EngineError as e:
            ctx.log("warning", "interrupted promotion journal %s not cleaned yet: %s" % (f, e.message[:200]))
    return out


def promote_object(ctx, stage_db, spec, mode="as_new", drop_stage=True, into=None, dry_run=False, progress=None, target_schema=None):
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
    space = _promote_space(ctx, stage_db, into)
    if not dry_run and space and not space["ok"]:
        bad = [c for c in space["checks"] if c["level"] == "bad"]
        raise EngineError("PGA-RST-032", "promotion not started: %s" % bad[0]["text"], bad[0].get("fix"))
    cleanup_interrupted_promotions(ctx)
    jdir = getattr(ctx, "promote_journal_dir", None)
    journal = os.path.join(jdir, "promote-%s-%d.json" % (stage_db, int(time.time() * 1000))) if jdir and not dry_run else None
    v2 = objmod.promote(_dest_conn(ctx, into), stage_db, mode=mode, dry_run=dry_run, progress=progress, target_schema=target_schema or None,
                        journal=journal, journal_info={"into": into} if into else None)          # a stage built by restore_object v2 knows everything around its tables
    if v2 is not None and space:
        v2["preflight"] = space; v2["space"] = space.get("space")
    if v2 is not None:
        if drop_stage and not dry_run:
            _drop_db(_dest_conn(ctx, into), stage_db)
            v2["stage_dropped"] = True
        return v2
    if target_schema:
        raise EngineError("PGA-GEN-087", "a target schema needs a quarantine database made by the current restore_object: restore the object again")
    if mode == "missing_only":
        raise EngineError("PGA-GEN-080", "missing_only needs a quarantine database made by the current restore_object (this one predates it): restore the object again")
    if dry_run:
        raise EngineError("PGA-GEN-080", "this quarantine database predates the dependency-aware restore: no plan available, restore the object again")
    parts = _spec3(spec)
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
            rc, out, err = run_dump(admin, admin.args() + ["-t", "%s.%s" % (quote_ident(work), quote_ident(name)), "-f", dump, "-d", stage_db])
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
    if sess.scalar("SELECT relpersistence FROM pg_class WHERE oid = %s::regclass" % sql_lit(fq)) == "u":
        # an UNLOGGED table has no rows in any backup: comparing would call every live row "added since" and offer to delete them all
        raise EngineError("PGA-GEN-095", "%s is UNLOGGED: PostgreSQL does not write its rows to the WAL, so no backup contains them - there is nothing to compare or recover" % fq,
                          "rows of an unlogged table cannot be recovered from backups; the live table was not touched")
    cols = [r[0] for r in sess.query("SELECT attname FROM pg_attribute WHERE attrelid=%s::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum" % sql_lit(fq))]
    gen = set(r[0] for r in sess.query("SELECT attname FROM pg_attribute WHERE attrelid=%s::regclass AND attnum>0 AND NOT attisdropped AND attgenerated<>''" % sql_lit(fq)))
    pk = [r[0] for r in sess.query("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=%s::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)" % sql_lit(fq))]
    key_from = "primary key" if pk else None
    if not pk:
        # no primary key: a UNIQUE index on NOT NULL plain columns (not partial, no expressions) identifies a row just as well - the narrowest one
        r = sess.scalar("""SELECT json_build_object('idx', c.relname, 'cols', (SELECT json_agg(a.attname ORDER BY k.o) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(n, o)
                                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n))::text
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = %s::regclass AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL AND NOT (0 = ANY(i.indkey::int2[]))
  AND NOT EXISTS (SELECT 1 FROM unnest(i.indkey::int2[]) k(n) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n WHERE NOT a.attnotnull)
ORDER BY array_length(i.indkey::int2[], 1), c.relname LIMIT 1""" % sql_lit(fq))
        if r:
            j = json.loads(r)
            pk, key_from = list(j["cols"]), "unique index %s" % j["idx"]
    always = sess.scalar("SELECT count(*)>0 FROM pg_attribute WHERE attrelid=%s::regclass AND attnum>0 AND attidentity='a'" % sql_lit(fq)) == "t"
    return {"cols": cols, "generated": gen, "pk": pk, "identity_always": always, "key_from": key_from}


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
    parts = _spec3(spec)
    if len(parts) != 3:
        raise EngineError("PGA-GEN-082", "object must be database.schema.name")
    dbname, schema, name = parts
    if not (stage_db or "").startswith("pgarca_stage_"):
        raise EngineError("PGA-GEN-081", "only quarantine databases created by pg_arca can be compared (name starts with pgarca_stage_)")
    _check_name(stage_db, "quarantine database")
    admin = _dest_conn(ctx, into)
    fq = "%s.%s" % (quote_ident(schema), quote_ident(name))
    _stage_complete(admin, stage_db)
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
                              "tables without a primary key or a unique index on NOT NULL columns can only be recovered as a whole (promote)")
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
        out = {"object": spec, "primary_key": si["pk"], "key_from": li.get("key_from"), "restored_rows": len(a), "live_rows": len(b), "columns_only_in_one_side": sorted(set(si["cols"]) ^ set(li["cols"])),
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
    parts = _spec3(spec)
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
    _stage_complete(admin, stage_db)
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
        # columns added after the restore point (a migration): only the columns both sides have are written - an updated row keeps its current
        # value in the new columns, a re-inserted row gets their DEFAULT (a NOT NULL column without default makes the whole transaction fail: said)
        res_note = ("columns only in the live table (%s): kept as they are for updated rows, DEFAULT for re-inserted rows" % ", ".join(missing)) if missing else None
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
        if res_note:
            res["note"] = res_note
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
        except BaseException as e:
            try:
                tg.query("ROLLBACK")
            except EngineError:
                pass
            if isinstance(e, EngineError) and missing and "null value" in e.message:
                raise EngineError("PGA-GEN-091", "nothing applied: a column added after the restore point is NOT NULL without a default (%s): re-inserted rows have no value for it"
                                  % ", ".join(missing), "update only rows that still exist, or give the column a default")
            raise
        return res
    finally:
        st.close()
        tg.close()
