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


def snapshot_catalog(conn, log=None):
    ctl = PgSession(conn, read_only=True)
    try:
        dbs = ctl.query("SELECT oid, datname, pg_encoding_to_char(encoding), datallowconn, COALESCE(pg_database_size(oid),0), "
                        "datcollate, datctype, dattablespace FROM pg_database ORDER BY oid")
        tbs = ctl.query("SELECT oid, spcname, COALESCE(pg_tablespace_location(oid),'') FROM pg_tablespace ORDER BY oid")
    finally:
        ctl.close()
    cat = {"captured": iso(), "databases": {}, "tablespaces": {r[0]: {"name": r[1], "location": r[2]} for r in tbs if len(r) >= 3}}
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
                finally:
                    s.close()
            except EngineError as e:
                entry["catalog_error"] = e.message
                if log:
                    log("warn", "catalog of '%s' not captured: %s" % (name, e.message))
        cat["databases"][name] = entry
    return cat


def find_object(cat, spec):
    parts = spec.split(".")
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
