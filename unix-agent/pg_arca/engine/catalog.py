"""Catalog snapshot: database -> schema -> object -> relfilenode. It is what makes granular restore possible."""

from pg_arca.engine.pgsession import PgSession
from pg_arca.engine.util import EngineError, iso

CATALOG_SQL = """
SELECT c.oid, n.nspname, c.relname, c.relkind, COALESCE(pg_relation_filenode(c.oid),0), c.reltablespace,
       COALESCE(pg_relation_size(c.oid), 0), COALESCE(c.reltoastrelid, 0), c.relpersistence,
       COALESCE(i.indrelid, 0), COALESCE(h.inhparent, 0)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_index i ON i.indexrelid = c.oid
LEFT JOIN pg_inherits h ON h.inhrelid = c.oid AND c.relispartition
WHERE c.relkind IN ('r','i','S','t','m','p','v','f','c') ORDER BY c.oid
"""


ROLES_USED_SQL = """
WITH o(r) AS (
  SELECT relowner FROM pg_class WHERE oid >= 16384 UNION SELECT nspowner FROM pg_namespace WHERE oid >= 16384 UNION SELECT proowner FROM pg_proc WHERE oid >= 16384
  UNION SELECT typowner FROM pg_type WHERE oid >= 16384 UNION SELECT oprowner FROM pg_operator WHERE oid >= 16384 UNION SELECT collowner FROM pg_collation WHERE oid >= 16384
  UNION SELECT conowner FROM pg_conversion WHERE oid >= 16384 UNION SELECT defaclrole FROM pg_default_acl UNION SELECT lomowner FROM pg_largeobject_metadata
  UNION SELECT evtowner FROM pg_event_trigger UNION SELECT stxowner FROM pg_statistic_ext UNION SELECT pubowner FROM pg_publication
  UNION SELECT fdwowner FROM pg_foreign_data_wrapper WHERE oid >= 16384 UNION SELECT srvowner FROM pg_foreign_server
  UNION SELECT umuser FROM pg_user_mapping WHERE umuser <> 0 UNION SELECT unnest(polroles) FROM pg_policy
  UNION SELECT opcowner FROM pg_opclass WHERE oid >= 16384 UNION SELECT opfowner FROM pg_opfamily WHERE oid >= 16384
  UNION SELECT dictowner FROM pg_ts_dict WHERE oid >= 16384 UNION SELECT cfgowner FROM pg_ts_config WHERE oid >= 16384
  UNION SELECT subowner FROM pg_subscription WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())
), a(acl) AS (
  SELECT relacl FROM pg_class WHERE relacl IS NOT NULL AND oid >= 16384 UNION ALL SELECT attacl FROM pg_attribute WHERE attacl IS NOT NULL AND attrelid >= 16384
  UNION ALL SELECT nspacl FROM pg_namespace WHERE nspacl IS NOT NULL AND oid >= 16384 UNION ALL SELECT proacl FROM pg_proc WHERE proacl IS NOT NULL AND oid >= 16384
  UNION ALL SELECT typacl FROM pg_type WHERE typacl IS NOT NULL AND oid >= 16384 UNION ALL SELECT defaclacl FROM pg_default_acl
  UNION ALL SELECT lomacl FROM pg_largeobject_metadata WHERE lomacl IS NOT NULL UNION ALL SELECT srvacl FROM pg_foreign_server WHERE srvacl IS NOT NULL
  UNION ALL SELECT fdwacl FROM pg_foreign_data_wrapper WHERE fdwacl IS NOT NULL AND oid >= 16384
), g(r) AS (SELECT (aclexplode(acl)).grantee FROM a UNION SELECT (aclexplode(acl)).grantor FROM a)
SELECT DISTINCT rolname FROM pg_roles WHERE oid IN (SELECT r FROM o UNION SELECT r FROM g) ORDER BY 1"""


def snapshot_catalog(conn, log=None):
    ctl = PgSession(conn, read_only=True)
    try:
        dbs = ctl.query("SELECT oid, datname, pg_encoding_to_char(encoding), datallowconn, COALESCE(pg_database_size(oid),0), "
                        "datcollate, datctype, dattablespace FROM pg_database ORDER BY oid")
        tbs = ctl.query("SELECT oid, spcname, COALESCE(pg_tablespace_location(oid),'') FROM pg_tablespace ORDER BY oid")
        try:
            spl = ctl.scalar("SELECT current_setting('shared_preload_libraries')")
        except EngineError:
            spl = None
        try:                                                # logical replication subscriptions (a restored copy must be told how to handle them)
            subs = ctl.query("SELECT d.datname, s.subname, COALESCE(s.subslotname, ''), s.subenabled FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid ORDER BY 1, 2")
        except EngineError:
            subs = []
    finally:
        ctl.close()
    cat = {"captured": iso(), "databases": {}, "tablespaces": {r[0]: {"name": r[1], "location": r[2]} for r in tbs if len(r) >= 3}}
    if spl is not None:
        cat["settings"] = {"shared_preload_libraries": spl}
    cat["subscriptions"] = [{"db": r[0], "name": r[1], "slot": r[2], "enabled": r[3] == "t"} for r in subs if len(r) >= 4]
    for row in dbs:
        if len(row) < 8:
            continue
        oid, name, enc, allow, size, coll, ctype, dts = row[:8]
        entry = {"oid": int(oid), "name": name, "encoding": enc, "size": int(size or 0), "collate": coll, "ctype": ctype,
                 "connectable": allow == "t", "tablespace": int(dts or 0), "relations": []}
        if allow == "t":
            try:
                s = PgSession(conn.with_db(name), read_only=True)
                try:
                    for r in s.query(CATALOG_SQL):
                        if len(r) < 9:
                            continue
                        entry["relations"].append({"oid": int(r[0]), "schema": r[1], "name": r[2], "kind": r[3], "relfilenode": int(r[4] or 0),
                                                   "tablespace": int(r[5] or 0), "size": int(r[6] or 0), "toast": int(r[7] or 0), "persistence": r[8],
                                                   "index_of": int(r[9] or 0) if len(r) > 9 else 0, "parent": int(r[10] or 0) if len(r) > 10 else 0})
                    try:                                    # roles the database's objects name (owners, grants, policies): a restore elsewhere needs them
                        entry["roles"] = [r[0] for r in s.query(ROLES_USED_SQL) if r and r[0]]
                    except EngineError:
                        pass
                finally:
                    s.close()
            except EngineError as e:
                entry["catalog_error"] = e.message
                if log:
                    log("warn", "catalog of '%s' not captured: %s" % (name, e.message))
        cat["databases"][name] = entry
    return cat


def find_object(cat, spec):
    from pg_arca.engine.util import split_spec
    try:
        parts = split_spec(spec)
    except ValueError:
        parts = []
    if len(parts) != 3:
        raise EngineError("PGA-GEN-030", "invalid object spec %r" % spec, "use database.schema.object (e.g. billing.public.invoices)")
    db, sch, obj = parts
    d = cat["databases"].get(db)
    if not d:
        raise EngineError("PGA-GEN-031", "database '%s' is not in the backup catalog" % db,
                          "available: %s" % ", ".join(sorted(cat["databases"])))
    for r in d["relations"]:
        if r["schema"] == sch and r["name"] == obj and r["kind"] in ("r", "p", "m", "S", "v", "f"):
            return d, r
    raise EngineError("PGA-GEN-032", "object '%s' not found in the backup" % spec)
