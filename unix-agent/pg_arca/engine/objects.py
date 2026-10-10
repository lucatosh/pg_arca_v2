"""Object restore with its surroundings: tables, views and whole schemas, at any point in time.

A table is never alone. Besides the rows it has types, defaults, sequences, indexes, constraints, triggers (and the functions they call), grants,
an owner, foreign keys to other tables, foreign keys FROM other tables, views built on top of it. `pg_dump -t` carries only some of that.
Here the recovered instance is asked for the complete picture and the result is a QUARANTINE database ("stage") that holds
  - the selected tables/sequences with everything pg_dump can express (owner, grants, indexes, triggers, comments, partitions),
  - the prerequisites (schemas, enum/domain/composite/range types, functions) the tables need,
  - a metadata schema (pgarca_meta) with what must be re-attached around them: foreign keys (outbound and inbound), views and
    materialized views (selected or depending on the selection), sequence positions, roles involved.
Promotion then puts it back into the live database (see promote()). Nothing existing is ever overwritten without a way back.
"""

import json
import os
import re
import shutil
import tempfile

from pg_arca.engine.pgsession import PgSession, run_tool
from pg_arca.engine.util import EngineError, now_utc, quote_ident, sql_lit

META = "pgarca_meta"
SYS_SCHEMAS = ("pg_catalog", "information_schema", "pg_toast")


def qi(schema, name=None):
    return quote_ident(schema) if name is None else "%s.%s" % (quote_ident(schema), quote_ident(name))


# ============================================================================================================== selection
def parse_selection(spec, objects=None):
    """`db.schema.name` -> a relation, `db.schema` -> a whole schema; a list of them (same database) is allowed.
    Returns (db, [{'kind': 'schema'|'rel', 'schema', 'name'}])."""
    items = list(objects or []) or ([spec] if spec else [])
    if not items:
        raise EngineError("PGA-GEN-030", "no object selected", "use database.schema.object or database.schema")
    db = None
    out = []
    seen = set()
    for it in items:
        parts = str(it).split(".")
        if len(parts) not in (2, 3) or not all(parts):
            raise EngineError("PGA-GEN-030", "invalid object %r" % it, "use database.schema.object (a table, view or sequence) or database.schema (a whole schema)")
        if db is None:
            db = parts[0]
        elif db != parts[0]:
            raise EngineError("PGA-GEN-033", "all objects must belong to the same database (got %s and %s)" % (db, parts[0]), "run one restore per database")
        key = tuple(parts)
        if key in seen:
            continue
        seen.add(key)
        out.append({"kind": "schema", "schema": parts[1]} if len(parts) == 2 else {"kind": "rel", "schema": parts[1], "name": parts[2]})
    if any(o["kind"] == "schema" for o in out):
        sch = {o["schema"] for o in out if o["kind"] == "schema"}
        out = [o for o in out if o["kind"] == "schema" or o["schema"] not in sch]          # a table of a selected schema is already included
    return db, out


def selection_in_catalog(cat_db, sel):
    """Validate against the backup catalog (cheap, before the long recovery). Returns the number of relations known to the backup."""
    rels = cat_db.get("relations", [])
    n = 0
    for o in sel:
        if o["kind"] == "schema":
            hits = [r for r in rels if r["schema"] == o["schema"] and r["kind"] in ("r", "p", "m", "S", "v", "f")]
            if not hits:
                raise EngineError("PGA-GEN-032", "schema '%s' has no tables in the backup" % o["schema"], "it may not exist in this backup; pick a later set or another target time")
            n += len(hits)
        else:
            if not any(r["schema"] == o["schema"] and r["name"] == o["name"] and r["kind"] in ("r", "p", "m", "S", "v", "f") for r in rels):
                raise EngineError("PGA-GEN-032", "object '%s.%s' not found in the backup" % (o["schema"], o["name"]))
            n += 1
    return n


# ============================================================================================================== analysis (on the recovered instance)
def _jq(sess, sql):
    r = sess.scalar(sql)
    return json.loads(r) if r else None


ACL_SQL = "COALESCE((SELECT jsonb_agg(jsonb_build_object('g', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, 'p', a.privilege_type, 'o', a.is_grantable)) FROM aclexplode(%s) a), '[]'::jsonb)"


def analyze(src, sel):
    """Everything that surrounds the selection, read from the recovered instance (`src` is a read-only PgSession on the database)."""
    info = {"warnings": []}
    # ---- relations
    conds = []
    for o in sel:
        conds.append("n.nspname = %s" % sql_lit(o["schema"]) if o["kind"] == "schema" else "c.oid = to_regclass(%s)" % sql_lit(qi(o["schema"], o["name"])))
    rels = _jq(src, """
WITH RECURSIVE pick AS (
  SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','S','f') AND (%s)
), parts(oid) AS (
  SELECT oid FROM pick UNION SELECT i.inhrelid FROM pg_inherits i JOIN parts p ON i.inhparent = p.oid
)
SELECT COALESCE(jsonb_agg(jsonb_build_object('oid', c.oid::int, 'schema', n.nspname, 'name', c.relname, 'kind', c.relkind, 'part', c.relispartition,
       'owner', pg_get_userbyid(c.relowner), 'acl', %s, 'comment', obj_description(c.oid, 'pg_class'), 'opts', c.reloptions,
       'owned', EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i')))
       ORDER BY c.oid), '[]'::jsonb)::text
FROM parts p JOIN pg_class c ON c.oid = p.oid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND c.relkind IN ('r','p','v','m','S','f')
""" % (" OR ".join(conds), ACL_SQL % "c.relacl")) or []
    for o in sel:
        if o["kind"] == "rel" and not any(r["schema"] == o["schema"] and r["name"] == o["name"] for r in rels):
            raise EngineError("PGA-GEN-071", "object %s.%s does not exist at the requested point in time" % (o["schema"], o["name"]),
                              "it may not exist yet (or no longer) at that time; choose another target or inspect the backup catalog")
        if o["kind"] == "schema" and not any(r["schema"] == o["schema"] for r in rels):
            ex = src.scalar("SELECT 1 FROM pg_namespace WHERE nspname = %s" % sql_lit(o["schema"]))
            if ex != "1":
                raise EngineError("PGA-GEN-071", "schema %s does not exist at the requested point in time" % o["schema"], "choose another target time")
    foreign = [r for r in rels if r["kind"] == "f"]
    if foreign:
        info["warnings"].append("%d foreign table(s) skipped (their data lives elsewhere): %s" % (len(foreign), ", ".join("%s.%s" % (r["schema"], r["name"]) for r in foreign[:5])))
    tables = [r for r in rels if r["kind"] in ("r", "p")]
    views = [r for r in rels if r["kind"] in ("v", "m")]
    seqs = [r for r in rels if r["kind"] == "S" and not r["owned"]]
    # the sequences owned by the tables come with their dump; their positions are recorded separately
    own_seq = _jq(src, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('oid', s.oid::int, 'schema', n.nspname, 'name', s.relname)), '[]'::jsonb)::text
FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S' JOIN pg_namespace n ON n.oid = s.relnamespace
WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i') AND d.refobjid = ANY(ARRAY[%s]::oid[])
""" % ",".join(str(t["oid"]) for t in tables)) if tables else []
    info["tables"], info["views"], info["sequences"] = tables, views, seqs
    info["owned_sequences"] = own_seq or []
    toids = [t["oid"] for t in tables]
    allrel = toids + [v["oid"] for v in views]
    arr = lambda xs: "ARRAY[%s]::oid[]" % ",".join(str(x) for x in xs) if xs else "ARRAY[]::oid[]"
    # ---- foreign keys: from/to the selected tables (those of a partition are inherited from its parent)
    info["fks"] = _jq(src, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('name', k.conname, 'schema', n.nspname, 'table', c.relname, 'ref_schema', rn.nspname, 'ref_table', rc.relname,
       'def', pg_get_constraintdef(k.oid), 'validated', k.convalidated, 'conrelid', k.conrelid::int, 'confrelid', k.confrelid::int)), '[]'::jsonb)::text
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_class rc ON rc.oid = k.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE k.contype = 'f' AND k.conparentid = 0 AND (k.conrelid = ANY(%s) OR k.confrelid = ANY(%s))
""" % (arr(toids), arr(toids))) or []
    # ---- views: the selected ones and every view/matview that (transitively) depends on a selected relation
    vrows = _jq(src, """
WITH RECURSIVE dep(oid, depth) AS (
  SELECT r.ev_class, 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
   WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = ANY(%s) AND r.ev_class <> d.refobjid
  UNION
  SELECT r.ev_class, dep.depth + 1 FROM dep JOIN pg_depend d ON d.refobjid = dep.oid AND d.refclassid = 'pg_class'::regclass AND d.classid = 'pg_rewrite'::regclass
         JOIN pg_rewrite r ON r.oid = d.objid WHERE r.ev_class <> dep.oid AND dep.depth < 25
), pick AS (SELECT oid FROM dep UNION SELECT unnest(%s::oid[]))
SELECT COALESCE(jsonb_agg(jsonb_build_object('oid', c.oid::int, 'schema', n.nspname, 'name', c.relname, 'kind', c.relkind, 'def', pg_get_viewdef(c.oid, true),
       'owner', pg_get_userbyid(c.relowner), 'acl', %s, 'comment', obj_description(c.oid, 'pg_class'), 'opts', c.reloptions, 'selected', c.oid = ANY(%s),
       'indexes', COALESCE((SELECT jsonb_agg(pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid = c.oid), '[]'::jsonb)) ORDER BY c.oid), '[]'::jsonb)::text
FROM pick p JOIN pg_class c ON c.oid = p.oid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('v','m')
""" % (arr(allrel), arr([v["oid"] for v in views]), ACL_SQL % "c.relacl", arr([v["oid"] for v in views]))) or []
    voids = [v["oid"] for v in vrows]
    order = {}
    if voids:
        pairs = _jq(src, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('v', r.ev_class::int, 'on', d.refobjid::int)), '[]'::jsonb)::text FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND r.ev_class = ANY(%s) AND d.refobjid = ANY(%s) AND r.ev_class <> d.refobjid
""" % (arr(voids), arr(voids))) or []
        order = _toposort(voids, [(p["v"], p["on"]) for p in pairs])
    for v in vrows:
        v["order"] = order.get(v["oid"], 0)
        v["def"] = v["def"].rstrip().rstrip(";")
    info["views"] = sorted(vrows, key=lambda v: v["order"])
    # ---- the objects the tables need (types, functions) and their schemas
    info.update(_prereqs(src, toids, [v["oid"] for v in vrows], tables, info))
    # ---- sequence positions (the dump of a table does not always carry them; promote sets them explicitly)
    pos = []
    for s in (info["owned_sequences"] or []) + [{"oid": s["oid"], "schema": s["schema"], "name": s["name"]} for s in seqs]:
        r = src.query("SELECT last_value, is_called FROM %s" % qi(s["schema"], s["name"]))
        if r and r[0]:
            pos.append({"schema": s["schema"], "name": s["name"], "last": int(r[0][0]), "called": r[0][1] == "t"})
    info["sequence_positions"] = pos
    # ---- every role the objects mention (owners and grantees): promote checks they exist before using them
    roles = set()
    for r in tables + views + seqs + vrows:
        roles.add(r["owner"])
        for a in r.get("acl") or []:
            if a["g"] != "PUBLIC":
                roles.add(a["g"])
    for t in info["types"]:
        roles.add(t["owner"])
    for f in info["functions"]:
        roles.add(f["owner"])
        for a in f.get("acl") or []:
            if a["g"] != "PUBLIC":
                roles.add(a["g"])
    info["roles"] = sorted(x for x in roles if x)
    return info


def _toposort(nodes, edges):
    """edges (a, b): a depends on b. Returns {node: level}, level 0 = depends on none of the nodes."""
    deps = {n: set() for n in nodes}
    for a, b in edges:
        if a in deps and b in deps and a != b:
            deps[a].add(b)
    level = {}

    def lv(n, stack=()):
        if n in level:
            return level[n]
        if n in stack:
            return 0
        level[n] = 1 + max([lv(d, stack + (n,)) for d in deps[n]] or [-1])
        return level[n]
    for n in nodes:
        lv(n)
    return level


def _prereqs(src, toids, voids, tables, info):
    arr = lambda xs: "ARRAY[%s]::oid[]" % ",".join(str(x) for x in xs) if xs else "ARRAY[]::oid[]"
    out = {"types": [], "functions": [], "extensions": [], "schemas": []}
    # ---- types used by the columns (recursively: arrays, domains over enums, composites, ranges)
    queue = [int(x[0]) for x in src.query("SELECT DISTINCT a.atttypid::int FROM pg_attribute a WHERE a.attrelid = ANY(%s) AND a.attnum > 0 AND NOT a.attisdropped" % arr(toids))] if toids else []
    seen = {}
    exts = set()
    while queue:
        t = queue.pop()
        if t in seen:
            continue
        row = _jq(src, """
SELECT jsonb_build_object('oid', t.oid::int, 'kind', t.typtype, 'schema', n.nspname, 'name', t.typname, 'elem', t.typelem::int, 'cat', t.typcategory, 'base', t.typbasetype::int,
  'basefmt', CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END, 'default', t.typdefault, 'notnull', t.typnotnull, 'owner', pg_get_userbyid(t.typowner),
  'ext', (SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e' LIMIT 1),
  'labels', CASE WHEN t.typtype = 'e' THEN (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid) END,
  'attrs', CASE WHEN t.typtype = 'c' THEN (SELECT jsonb_agg(jsonb_build_object('n', a.attname, 't', format_type(a.atttypid, a.atttypmod), 'o', a.atttypid::int) ORDER BY a.attnum)
              FROM pg_attribute a JOIN pg_class rc ON rc.oid = t.typrelid AND rc.relkind = 'c' WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) END,
  'range', CASE WHEN t.typtype = 'r' THEN (SELECT jsonb_build_object('sub', format_type(r.rngsubtype, NULL), 'o', r.rngsubtype::int) FROM pg_range r WHERE r.rngtypid = t.oid) END,
  'checks', CASE WHEN t.typtype = 'd' THEN (SELECT jsonb_agg(jsonb_build_object('n', k.conname, 'd', pg_get_constraintdef(k.oid))) FROM pg_constraint k WHERE k.contypid = t.oid) END,
  'comment', obj_description(t.oid, 'pg_type'))::text
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.oid = %d""" % t)
        seen[t] = row
        if not row:
            continue
        if row["elem"] and row["cat"] == "A":
            queue.append(row["elem"])
        if row["kind"] == "d":
            queue.append(row["base"])
        for a in row.get("attrs") or []:
            queue.append(a["o"])
        if row.get("range"):
            queue.append(row["range"]["o"])
    tlist = []
    for t, row in seen.items():
        if not row or row["schema"] in SYS_SCHEMAS or row["kind"] in ("p",) or (row["elem"] and row["cat"] == "A"):
            continue
        if row["ext"]:
            exts.add(row["ext"])
            continue
        if row["kind"] == "b":
            info["warnings"].append("type %s.%s is a base type not owned by an extension: it cannot be recreated automatically" % (row["schema"], row["name"]))
            continue
        if row["kind"] == "c" and not row.get("attrs"):
            continue                              # the row type of a table
        row["ddl"] = _type_ddl(row)
        if row["ddl"]:
            tlist.append(row)
    # order: a type after the types it uses
    edges = []
    for r in tlist:
        for dep in ([r["base"]] if r["kind"] == "d" else []) + [a["o"] for a in (r.get("attrs") or [])] + ([r["range"]["o"]] if r.get("range") else []):
            edges.append((r["oid"], dep))
    lvl = _toposort([r["oid"] for r in tlist], edges)
    out["types"] = sorted(tlist, key=lambda r: lvl.get(r["oid"], 0))
    # ---- functions the objects use (defaults, checks, triggers, index expressions, views) + every function of the involved schemas
    used = [int(x[0]) for x in src.query("""
SELECT DISTINCT p.oid::int FROM pg_depend d JOIN pg_proc p ON p.oid = d.refobjid WHERE d.refclassid = 'pg_proc'::regclass AND d.deptype = 'n' AND (
  (d.classid = 'pg_attrdef'::regclass AND d.objid IN (SELECT oid FROM pg_attrdef WHERE adrelid = ANY(%s))) OR
  (d.classid = 'pg_constraint'::regclass AND d.objid IN (SELECT oid FROM pg_constraint WHERE conrelid = ANY(%s))) OR
  (d.classid = 'pg_trigger'::regclass AND d.objid IN (SELECT oid FROM pg_trigger WHERE tgrelid = ANY(%s) AND NOT tgisinternal)) OR
  (d.classid = 'pg_class'::regclass AND d.objid IN (SELECT indexrelid FROM pg_index WHERE indrelid = ANY(%s))) OR
  (d.classid = 'pg_rewrite'::regclass AND d.objid IN (SELECT oid FROM pg_rewrite WHERE ev_class = ANY(%s))))""" % (arr(toids), arr(toids), arr(toids), arr(toids), arr(voids)))] if (toids or voids) else []
    schemas = {t["schema"] for t in tables} | {v["schema"] for v in info["views"]} | {r["schema"] for r in tlist}
    if used:
        schemas |= {x[0] for x in src.query("SELECT DISTINCT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = ANY(%s)" % arr(used))}
    schemas = {s for s in schemas if s not in SYS_SCHEMAS}
    flist = _jq(src, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('sig', p.oid::regprocedure::text, 'schema', n.nspname, 'name', p.proname, 'kind', p.prokind, 'ddl', pg_get_functiondef(p.oid),
       'owner', pg_get_userbyid(p.proowner), 'acl', %s, 'comment', obj_description(p.oid, 'pg_proc')) ORDER BY p.oid), '[]'::jsonb)::text
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = ANY(ARRAY[%s]) AND p.prokind IN ('f','p') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
""" % (ACL_SQL % "p.proacl", ",".join(sql_lit(s) for s in sorted(schemas)) or "NULL::text")) if schemas else []
    out["functions"] = flist or []
    # functions owned by an extension that the objects use: the extension is what must exist
    if used:
        for x in src.query("SELECT DISTINCT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid WHERE d.classid = 'pg_proc'::regclass AND d.deptype = 'e' AND d.objid = ANY(%s)" % arr(used)):
            exts.add(x[0])
    out["extensions"] = sorted(e for e in exts if e != "plpgsql")
    owners = {r["schema"]: None for r in out["types"]}
    nsrows = _jq(src, "SELECT COALESCE(jsonb_agg(jsonb_build_object('name', nspname, 'owner', pg_get_userbyid(nspowner), 'comment', obj_description(oid, 'pg_namespace'), 'acl', %s)), '[]'::jsonb)::text FROM pg_namespace WHERE nspname = ANY(ARRAY[%s])" % (ACL_SQL % "nspacl", ",".join(sql_lit(s) for s in sorted(schemas)) or "NULL::text")) if schemas else []
    out["schemas"] = nsrows or []
    del owners
    return out


def _type_ddl(r):
    n = qi(r["schema"], r["name"])
    if r["kind"] == "e":
        return "CREATE TYPE %s AS ENUM (%s)" % (n, ", ".join(sql_lit(x) for x in (r.get("labels") or [])))
    if r["kind"] == "c":
        return "CREATE TYPE %s AS (%s)" % (n, ", ".join("%s %s" % (quote_ident(a["n"]), a["t"]) for a in r["attrs"]))
    if r["kind"] == "d":
        d = "CREATE DOMAIN %s AS %s" % (n, r["basefmt"])
        if r.get("default") is not None:
            d += " DEFAULT %s" % r["default"]
        if r.get("notnull"):
            d += " NOT NULL"
        for k in r.get("checks") or []:
            d += " CONSTRAINT %s %s" % (quote_ident(k["n"]), k["d"])
        return d
    if r["kind"] == "r" and r.get("range"):
        return "CREATE TYPE %s AS RANGE (SUBTYPE = %s)" % (n, r["range"]["sub"])
    return None


# ============================================================================================================== applying prerequisites
def _acl_stmts(kind, ident, acl):
    out = []
    for a in acl or []:
        who = "PUBLIC" if a["g"] == "PUBLIC" else quote_ident(a["g"])
        out.append("GRANT %s ON %s %s TO %s%s" % (a["p"], kind, ident, who, " WITH GRANT OPTION" if a.get("o") else ""))
    return out


def prereq_exists(sess, kind, item):
    if kind == "schema":
        return sess.scalar("SELECT to_regnamespace(%s) IS NOT NULL" % sql_lit(quote_ident(item["name"]))) == "t"
    if kind == "type":
        return sess.scalar("SELECT to_regtype(%s) IS NOT NULL" % sql_lit(qi(item["schema"], item["name"]))) == "t"
    if kind == "function":
        return sess.scalar("SELECT to_regprocedure(%s) IS NOT NULL" % sql_lit(item["sig"])) == "t"
    if kind == "extension":
        return sess.scalar("SELECT 1 FROM pg_extension WHERE extname = %s" % sql_lit(item)) == "1"
    return False


def ensure_prereqs(sess, meta, only_missing=True, roles_ok=None):
    """Create the schemas/extensions/types/functions of `meta` that the destination does not have. Returns (created, problems).
    A problem never aborts: the table restore that follows reports precisely what is still missing."""
    created, problems = [], []
    p = meta["prereq"]
    sess.query("SET check_function_bodies = off")

    def run(label, sql, extra=()):
        try:
            sess.query(sql)
            created.append(label)
        except EngineError as e:
            problems.append("%s: %s" % (label, e.message[:200]))
            return False
        for x in extra:
            try:
                sess.query(x)
            except EngineError as e:
                problems.append("%s (owner/grants): %s" % (label, e.message[:160]))
        return True
    for e in p["extensions"]:
        if not prereq_exists(sess, "extension", e):
            run("extension %s" % e, "CREATE EXTENSION IF NOT EXISTS %s" % quote_ident(e))
    for s in p["schemas"]:
        if only_missing and prereq_exists(sess, "schema", s):
            continue
        extra = []
        if s.get("owner") and (roles_ok is None or s["owner"] in roles_ok):
            extra.append("ALTER SCHEMA %s OWNER TO %s" % (quote_ident(s["name"]), quote_ident(s["owner"])))
        extra += [x for x in _acl_stmts("SCHEMA", quote_ident(s["name"]), [a for a in (s.get("acl") or []) if a["g"] == "PUBLIC" or roles_ok is None or a["g"] in roles_ok])]
        run("schema %s" % s["name"], "CREATE SCHEMA %s" % quote_ident(s["name"]), extra)
    for t in p["types"]:
        if only_missing and prereq_exists(sess, "type", t):
            continue
        extra = []
        if t.get("owner") and (roles_ok is None or t["owner"] in roles_ok):
            extra.append("ALTER TYPE %s OWNER TO %s" % (qi(t["schema"], t["name"]), quote_ident(t["owner"])))
        run("type %s.%s" % (t["schema"], t["name"]), t["ddl"], extra)
    for f in p["functions"]:
        if only_missing and prereq_exists(sess, "function", f):
            continue
        extra = []
        kw = "PROCEDURE" if f["kind"] == "p" else "FUNCTION"
        if f.get("owner") and (roles_ok is None or f["owner"] in roles_ok):
            extra.append("ALTER %s %s OWNER TO %s" % (kw, f["sig"], quote_ident(f["owner"])))
        extra += _acl_stmts(kw, f["sig"], [a for a in (f.get("acl") or []) if a["g"] == "PUBLIC" or roles_ok is None or a["g"] in roles_ok])
        run("function %s" % f["sig"], f["ddl"], extra)
    return created, problems


# ============================================================================================================== stage
FK_TOC = re.compile(r"FK CONSTRAINT (\S+) (\S+) (\S+) (\S+)\s*$")


def _roles_present(sess, names):
    if not names:
        return set()
    r = sess.query("SELECT rolname FROM pg_roles WHERE rolname = ANY(ARRAY[%s])" % ",".join(sql_lit(n) for n in names))
    return {x[0] for x in r}


def dump_for_stage(eph_conn, dbname, info, tmp, progress=None):
    """pg_dump of the selected tables and sequences (partitions included) from the recovered instance."""
    names = [qi(t["schema"], t["name"]) for t in info["tables"]] + [qi(s["schema"], s["name"]) for s in info["sequences"]]
    if not names:
        return None
    dumpfile = os.path.join(tmp, "sel.dump")
    args = eph_conn.args() + ["-Fc", "-Z", "3", "--strict-names", "-f", dumpfile, "-d", dbname]
    for n in names:
        args += ["-t", n]
    rc, out, err = run_tool(eph_conn, "pg_dump", args, timeout=None)
    if rc != 0:
        raise EngineError("PGA-GEN-072", "pg_dump of the selection failed: %s" % err.strip()[:600])
    return dumpfile


def filtered_toc(admin, dumpfile, tmp, drop_fks):
    """Entry list for pg_restore without the foreign keys whose referenced table is not part of the dump (they are re-attached against the LIVE table on promotion)."""
    rc, out, err = run_tool(admin, "pg_restore", ["-l", dumpfile], timeout=120)
    if rc != 0:
        raise EngineError("PGA-GEN-071", "cannot read the dump: %s" % err.strip()[:300])
    keep, dropped = [], 0
    for line in out.splitlines():
        m = FK_TOC.search(line)
        if m and (m.group(1), m.group(2), m.group(3)) in drop_fks:
            dropped += 1
            continue
        keep.append(line)
    path = os.path.join(tmp, "toc.lst")
    with open(path, "w") as f:
        f.write("\n".join(keep) + "\n")
    return path, dropped


def write_meta(sess, meta):
    sess.query("CREATE SCHEMA IF NOT EXISTS %s" % META)
    sess.query("CREATE TABLE IF NOT EXISTS %s.kv (k text PRIMARY KEY, v jsonb NOT NULL)" % META)
    sess.query("DELETE FROM %s.kv" % META)
    sess.query("INSERT INTO %s.kv (k, v) VALUES ('meta', %s::jsonb)" % (META, sql_lit(json.dumps(meta, separators=(",", ":")))))


def read_meta(sess):
    if sess.scalar("SELECT to_regclass(%s) IS NOT NULL" % sql_lit(META + ".kv")) != "t":
        return None
    r = sess.scalar("SELECT v::text FROM %s.kv WHERE k = 'meta'" % META)
    return json.loads(r) if r else None


def build_stage(admin, eph, dbentry, sel, spec_label, stage, info, plan_extra, progress=None, create_db=None):
    """Create the quarantine database from the analysed selection. Returns the metadata written into it."""
    dbname = dbentry["name"]
    tmp = tempfile.mkdtemp(prefix="pgarca-stage-")
    try:
        if progress:
            progress({"phase": "transfer"})
        dumpfile = dump_for_stage(eph.conn(dbname), dbname, info, tmp)
        tset = {(t["schema"], t["name"]) for t in info["tables"]}
        drop_fks = {(f["schema"], f["table"], f["name"]) for f in info["fks"] if (f["schema"], f["table"]) in tset and (f["ref_schema"], f["ref_table"]) not in tset}
        meta = {"version": 1, "created": now_utc().isoformat(timespec="seconds"), "database": dbname, "selection": sel, "label": spec_label,
                "tables": [{"schema": t["schema"], "name": t["name"], "kind": t["kind"], "part": t["part"], "owner": t["owner"]} for t in info["tables"]],
                "sequences": [{"schema": s["schema"], "name": s["name"], "owner": s["owner"], "acl": s["acl"]} for s in info["sequences"]],
                "views": info["views"], "fks": info["fks"], "positions": info["sequence_positions"], "roles": info["roles"],
                "prereq": {"types": info["types"], "functions": info["functions"], "extensions": info["extensions"], "schemas": info["schemas"]},
                "warnings": list(info["warnings"]), "counts": {}}
        create_db()
        sess = PgSession(admin.with_db(None) if False else admin.with_db(stage))
        try:
            roles_ok = _roles_present(sess, info["roles"])
            missing_roles = [r for r in info["roles"] if r not in roles_ok]
            meta["missing_roles_at_stage"] = missing_roles
            created, problems = ensure_prereqs(sess, meta, only_missing=False, roles_ok=roles_ok)
            meta["prereq_created"] = len(created)
            if problems:
                meta["warnings"] += ["prerequisite not recreated - %s" % p for p in problems]
            if dumpfile:
                toc, dropped = filtered_toc(admin, dumpfile, tmp, drop_fks)
                args = admin.args() + ["-d", stage, "--exit-on-error", "-L", toc]
                if missing_roles:
                    args += ["--no-owner", "--no-acl"]
                    meta["warnings"].append("roles missing on this server (%s): owners and grants of the recovered tables were NOT applied" % ", ".join(missing_roles[:6]))
                rc, out, err = run_tool(admin, "pg_restore", args + [dumpfile], timeout=None)
                if rc != 0:
                    raise EngineError("PGA-GEN-071", "pg_restore into the quarantine database failed: %s" % (err.strip() or out.strip())[:900])
                meta["fks_deferred"] = dropped
            for p in info["sequence_positions"]:
                if sess.scalar("SELECT to_regclass(%s) IS NOT NULL" % sql_lit(qi(p["schema"], p["name"]))) == "t":
                    sess.query("SELECT setval(%s, %d, %s)" % (sql_lit(qi(p["schema"], p["name"])), p["last"], "true" if p["called"] else "false"))
            # row counts: the recovered instance vs the quarantine copy
            src = PgSession(eph.conn(dbname), read_only=True)
            try:
                for t in info["tables"]:
                    if t["kind"] == "p":
                        continue
                    fq = qi(t["schema"], t["name"])
                    a = int(src.scalar("SELECT count(*) FROM %s" % fq))
                    b = int(sess.scalar("SELECT count(*) FROM %s" % fq))
                    meta["counts"]["%s.%s" % (t["schema"], t["name"])] = a
                    if a != b:
                        raise EngineError("PGA-VRF-040", "verification failed for %s: %d rows at target, %d restored" % (fq, a, b))
            finally:
                src.close()
            write_meta(sess, meta)
        finally:
            sess.close()
        return meta
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
