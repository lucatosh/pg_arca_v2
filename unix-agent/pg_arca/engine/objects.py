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

import datetime
import json
import os
import re
import shutil
import tempfile

from pg_arca.engine.pgsession import PgSession, run_dump, run_tool
from pg_arca.engine.util import EngineError, now_utc, quote_ident, split_spec, sql_lit

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
        try:
            parts = split_spec(str(it))                  # a part with a dot or a quote is double-quoted: db."sales.eu".orders
        except ValueError:
            parts = []
        if len(parts) not in (2, 3) or not all(parts):
            raise EngineError("PGA-GEN-030", "invalid object %r" % it, "use database.schema.object (a table, view or sequence) or database.schema (a whole schema); quote a name that contains a dot: db.\"my.schema\".t")
        if parts[1] in ("pg_catalog", "information_schema", "pg_toast") or parts[1].startswith("pg_temp"):
            raise EngineError("PGA-GEN-034", "%r is a system schema: its objects belong to PostgreSQL itself and are never restored one by one" % parts[1],
                              "to bring back a whole database use restore_database")
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
                raise EngineError("PGA-GEN-032", "schema '%s' has no tables in backup" % o["schema"], "it may not exist in this backup; pick a later set or another target time")
            n += len(hits)
        else:
            if not any(r["schema"] == o["schema"] and r["name"] == o["name"] and r["kind"] in ("r", "p", "m", "S", "v", "f") for r in rels):
                raise EngineError("PGA-GEN-032", "object '%s.%s' is not in backup" % (o["schema"], o["name"]))
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
SELECT COALESCE(jsonb_agg(jsonb_build_object('oid', c.oid::int, 'schema', n.nspname, 'name', c.relname, 'kind', c.relkind, 'part', c.relispartition, 'persistence', c.relpersistence,
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
    # sequences the columns' defaults use without owning them (one sequence shared by several tables): the table cannot be created without them.
    # Promotion creates them only if missing and never moves an existing one backwards.
    if tables:
        owned_oids = {x["oid"] for x in (own_seq or [])} | {x["oid"] for x in seqs}
        for x in (_jq(src, """
SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('oid', s.oid::int, 'schema', n.nspname, 'name', s.relname, 'kind', 'S', 'part', false, 'owner', pg_get_userbyid(s.relowner),
       'acl', %s, 'comment', obj_description(s.oid, 'pg_class'), 'opts', s.reloptions, 'owned', false, 'referenced', true)), '[]'::jsonb)::text
FROM pg_attrdef ad JOIN pg_depend d ON d.classid = 'pg_attrdef'::regclass AND d.objid = ad.oid AND d.refclassid = 'pg_class'::regclass
     JOIN pg_class s ON s.oid = d.refobjid AND s.relkind = 'S' JOIN pg_namespace n ON n.oid = s.relnamespace
WHERE ad.adrelid = ANY(ARRAY[%s]::oid[])""" % (ACL_SQL % "s.relacl", ",".join(str(t["oid"]) for t in tables))) or []):
            if x["oid"] not in owned_oids:
                seqs.append(x)
                owned_oids.add(x["oid"])
    info["tables"], info["views"], info["sequences"] = tables, views, seqs
    info["owned_sequences"] = own_seq or []
    toids = [t["oid"] for t in tables]
    allrel = toids + [v["oid"] for v in views]
    arr = lambda xs: "ARRAY[%s]::oid[]" % ",".join(str(x) for x in xs) if xs else "ARRAY[]::oid[]"
    # ---- tables selected WITHOUT their parent (one partition of a partitioned table, a child of plain inheritance): the stage keeps them standalone,
    #      promotion detaches the live one and attaches the recovered one to the live parent with the same bound
    info["detached"], info["ancestors"] = [], []
    if toids:
        info["detached"] = _jq(src, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('schema', n.nspname, 'name', c.relname, 'parent_schema', pn.nspname, 'parent', pc.relname, 'part', c.relispartition,
       'bound', CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END) ORDER BY c.oid, i.inhseqno), '[]'::jsonb)::text
FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_class pc ON pc.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = pc.relnamespace
WHERE i.inhrelid = ANY(%s) AND NOT (i.inhparent = ANY(%s))""" % (arr(toids), arr(toids))) or []
        if info["detached"]:
            # every ancestor (transitively): the stage needs their definitions as empty shells so that the selection can be loaded exactly as dumped
            info["ancestors"] = _jq(src, """
WITH RECURSIVE a(oid) AS (SELECT i.inhparent FROM pg_inherits i WHERE i.inhrelid = ANY(%s) AND NOT (i.inhparent = ANY(%s))
                          UNION SELECT i.inhparent FROM pg_inherits i JOIN a ON i.inhrelid = a.oid)
SELECT COALESCE(jsonb_agg(jsonb_build_object('schema', n.nspname, 'name', c.relname, 'kind', c.relkind) ORDER BY c.oid), '[]'::jsonb)::text
FROM a JOIN pg_class c ON c.oid = a.oid JOIN pg_namespace n ON n.oid = c.relnamespace""" % (arr(toids), arr(toids))) or []
    # ---- extended statistics (CREATE STATISTICS): pg_dump -t does not carry them, promotion recreates them
    info["statistics"] = _jq(src, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('schema', n.nspname, 'name', s.stxname, 'table_schema', tn.nspname, 'table', c.relname, 'def', pg_get_statisticsobjdef(s.oid),
       'target', s.stxstattarget::int, 'owner', pg_get_userbyid(s.stxowner), 'comment', obj_description(s.oid, 'pg_statistic_ext')) ORDER BY s.oid), '[]'::jsonb)::text
FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace JOIN pg_class c ON c.oid = s.stxrelid JOIN pg_namespace tn ON tn.oid = c.relnamespace
WHERE s.stxrelid = ANY(%s)""" % arr(toids)) or [] if toids else []
    # ---- foreign keys: from/to the selected tables (those of a partition are inherited from its parent)
    info["fks"] = _jq(src, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('name', k.conname, 'schema', n.nspname, 'table', c.relname, 'ref_schema', rn.nspname, 'ref_table', rc.relname,
       'def', pg_get_constraintdef(k.oid), 'validated', k.convalidated, 'conrelid', k.conrelid::int, 'confrelid', k.confrelid::int)), '[]'::jsonb)::text
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_class rc ON rc.oid = k.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE k.contype = 'f' AND k.conparentid = 0 AND (k.conrelid = ANY(%s) OR k.confrelid = ANY(%s))
""" % (arr(toids), arr(toids))) or []
    # ---- views: the selected ones and every view/matview that (transitively) depends on a selected relation
    info["views"] = collect_views(src, allrel, [v["oid"] for v in views])
    vrows = info["views"]
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
    for t in info["types"] + info["statistics"]:
        roles.add(t["owner"])
    for f in info["functions"]:
        roles.add(f["owner"])
        for a in f.get("acl") or []:
            if a["g"] != "PUBLIC":
                roles.add(a["g"])
    info["roles"] = sorted(x for x in roles if x)
    return info


def collect_views(sess, base_oids, selected_oids=()):
    """Views/materialized views that (transitively) depend on `base_oids` (plus `selected_oids`), with definition, owner, ACL, options and matview indexes,
    ordered so that a view comes after the views it uses."""
    arr = lambda xs: "ARRAY[%s]::oid[]" % ",".join(str(x) for x in xs) if xs else "ARRAY[]::oid[]"
    if not base_oids and not selected_oids:
        return []
    vrows = _jq(sess, """
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
""" % (arr(list(base_oids) + list(selected_oids)), arr(selected_oids), ACL_SQL % "c.relacl", arr(selected_oids))) or []
    voids = [v["oid"] for v in vrows]
    order = {}
    if voids:
        pairs = _jq(sess, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('v', r.ev_class::int, 'on', d.refobjid::int)), '[]'::jsonb)::text FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND r.ev_class = ANY(%s) AND d.refobjid = ANY(%s) AND r.ev_class <> d.refobjid
""" % (arr(voids), arr(voids))) or []
        order = _toposort(voids, [(p["v"], p["on"]) for p in pairs])
    for v in vrows:
        v["order"] = order.get(v["oid"], 0)
        v["def"] = v["def"].rstrip().rstrip(";")
    return sorted(vrows, key=lambda v: v["order"])


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
  'attrs', CASE WHEN t.typtype = 'c' THEN (SELECT jsonb_agg(jsonb_build_object('n', a.attname, 't', format_type(a.atttypid, a.atttypmod), 'o', a.atttypid::int,
                                                                  'coll', CASE WHEN a.attcollation <> 0 AND a.attcollation <> (SELECT typcollation FROM pg_type WHERE oid = a.atttypid)
                                                                               THEN (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = a.attcollation) END)
                                                ORDER BY a.attnum)
              FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) END,
  'relkind', CASE WHEN t.typtype = 'c' THEN (SELECT rc.relkind FROM pg_class rc WHERE rc.oid = t.typrelid) END, 'relid', t.typrelid::int,
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
        if row["kind"] == "c" and row.get("relkind") not in (None, "c"):
            # the row type of a TABLE used as a column type: the table itself must exist (empty is enough in the quarantine database).
            # A selected table comes with the dump; any other one is created as an empty shell in the stage and must already exist live.
            if row["relid"] in toids or not row.get("attrs"):
                continue
            row["table"] = True
        elif row["kind"] == "c" and not row.get("attrs"):
            continue
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
    doms = [r["oid"] for r in tlist if r["kind"] == "d"]
    used = [int(x[0]) for x in src.query("""
SELECT DISTINCT p.oid::int FROM pg_depend d JOIN pg_proc p ON p.oid = d.refobjid WHERE d.refclassid = 'pg_proc'::regclass AND d.deptype = 'n' AND (
  (d.classid = 'pg_constraint'::regclass AND d.objid IN (SELECT oid FROM pg_constraint WHERE contypid = ANY(%s))) OR
  (d.classid = 'pg_attrdef'::regclass AND d.objid IN (SELECT oid FROM pg_attrdef WHERE adrelid = ANY(%s))) OR
  (d.classid = 'pg_constraint'::regclass AND d.objid IN (SELECT oid FROM pg_constraint WHERE conrelid = ANY(%s))) OR
  (d.classid = 'pg_trigger'::regclass AND d.objid IN (SELECT oid FROM pg_trigger WHERE tgrelid = ANY(%s) AND NOT tgisinternal)) OR
  (d.classid = 'pg_class'::regclass AND d.objid IN (SELECT indexrelid FROM pg_index WHERE indrelid = ANY(%s))) OR
  (d.classid = 'pg_rewrite'::regclass AND d.objid IN (SELECT oid FROM pg_rewrite WHERE ev_class = ANY(%s))))""" % (arr(doms), arr(toids), arr(toids), arr(toids), arr(toids), arr(voids)))] if (toids or voids) else []
    schemas = {t["schema"] for t in tables} | {v["schema"] for v in info["views"]} | {r["schema"] for r in tlist} | {x["schema"] for x in info.get("sequences") or []}
    if used:
        schemas |= {x[0] for x in src.query("SELECT DISTINCT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = ANY(%s)" % arr(used))}
    schemas = {s for s in schemas if s not in SYS_SCHEMAS}
    flist = _jq(src, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('oid', p.oid::int, 'sig', p.oid::regprocedure::text, 'schema', n.nspname, 'name', p.proname, 'kind', p.prokind, 'ddl', pg_get_functiondef(p.oid),
       'owner', pg_get_userbyid(p.proowner), 'acl', %s, 'comment', obj_description(p.oid, 'pg_proc')) ORDER BY p.oid), '[]'::jsonb)::text
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = ANY(ARRAY[%s]) AND p.prokind IN ('f','p') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
""" % (ACL_SQL % "p.proacl", ",".join(sql_lit(s) for s in sorted(schemas)) or "NULL::text")) if schemas else []
    out["functions"] = flist or []
    for f in out["functions"]:                    # used by the selected objects (defaults, checks, triggers, ...) vs merely in the same schema
        f["used"] = f.get("oid") in set(used)
    # functions owned by an extension that the objects use: the extension is what must exist
    if used:
        for x in src.query("SELECT DISTINCT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid WHERE d.classid = 'pg_proc'::regclass AND d.deptype = 'e' AND d.objid = ANY(%s)" % arr(used)):
            exts.add(x[0])
    # collations of the columns (and of the composite types' attributes) that are not built in: CREATE COLLATION before the tables
    colls = set()
    if toids:
        colls |= {int(x[0]) for x in src.query("SELECT DISTINCT a.attcollation::int FROM pg_attribute a WHERE a.attrelid = ANY(%s) AND a.attnum > 0 AND NOT a.attisdropped AND a.attcollation <> 0" % arr(toids))}
    trel = [r["relid"] for r in tlist if r.get("relid")]
    if trel:
        colls |= {int(x[0]) for x in src.query("SELECT DISTINCT a.attcollation::int FROM pg_attribute a WHERE a.attrelid = ANY(%s) AND a.attnum > 0 AND NOT a.attisdropped AND a.attcollation <> 0" % arr(trel))}
    dcoll = [r["oid"] for r in tlist if r["kind"] == "d"]
    if dcoll:
        colls |= {int(x[0]) for x in src.query("SELECT DISTINCT typcollation::int FROM pg_type WHERE oid = ANY(%s) AND typcollation <> 0" % arr(dcoll))}
    out["collations"] = []
    if colls:
        for c in _jq(src, """
SELECT COALESCE(jsonb_agg(to_jsonb(c) || jsonb_build_object('schema', n.nspname, 'owner_name', pg_get_userbyid(c.collowner),
       'ext', (SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid WHERE d.classid = 'pg_collation'::regclass AND d.objid = c.oid AND d.deptype = 'e' LIMIT 1))
       ORDER BY c.oid), '[]'::jsonb)::text
FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace WHERE c.oid = ANY(%s) AND n.nspname <> 'pg_catalog'""" % arr(sorted(colls))) or []:
            if c.get("ext"):
                exts.add(c["ext"])
                continue
            ddl = _collation_ddl(c)
            if ddl:
                out["collations"].append({"schema": c["schema"], "name": c["collname"], "owner": c["owner_name"], "ddl": ddl})
                schemas.add(c["schema"])
            else:
                info["warnings"].append("collation %s.%s cannot be recreated automatically" % (c["schema"], c["collname"]))
    out["extensions"] = sorted(e for e in exts if e != "plpgsql")
    # the schema each extension lives in: its types are referenced by that schema (ext.citext) - CREATE EXTENSION must put them back there
    out["ext_schemas"] = {}
    if out["extensions"]:
        out["ext_schemas"] = {x[0]: x[1] for x in src.query("SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = ANY(ARRAY[%s])"
                                                            % ",".join(sql_lit(e) for e in out["extensions"]))}
    nsall = (schemas | set(out["ext_schemas"].values())) - set(SYS_SCHEMAS)
    nsrows = _jq(src, "SELECT COALESCE(jsonb_agg(jsonb_build_object('name', nspname, 'owner', pg_get_userbyid(nspowner), 'comment', obj_description(oid, 'pg_namespace'), 'acl', %s)), '[]'::jsonb)::text FROM pg_namespace WHERE nspname = ANY(ARRAY[%s])" % (ACL_SQL % "nspacl", ",".join(sql_lit(s) for s in sorted(nsall)) or "NULL::text")) if nsall else []
    out["schemas"] = nsrows or []
    return out


def _collation_ddl(c):
    """CREATE COLLATION from a pg_collation row (to_jsonb: the columns differ across versions - colliculocale 15-16, colllocale 17+, collicurules 16+, builtin 17+)."""
    prov = {"i": "icu", "c": "libc", "b": "builtin"}.get(c.get("collprovider"))
    if not prov:
        return None
    opts = ["provider = %s" % prov]
    if prov == "libc":
        opts += ["lc_collate = %s" % sql_lit(c.get("collcollate") or "C"), "lc_ctype = %s" % sql_lit(c.get("collctype") or "C")]
    else:
        loc = c.get("colllocale") or c.get("colliculocale") or c.get("collcollate")
        if not loc:
            return None
        opts.append("locale = %s" % sql_lit(loc))
        if c.get("collicurules"):
            opts.append("rules = %s" % sql_lit(c["collicurules"]))
    if c.get("collisdeterministic") is False:
        opts.append("deterministic = false")
    return "CREATE COLLATION %s (%s)" % (qi(c["schema"], c["collname"]), ", ".join(opts))


def _type_ddl(r):
    n = qi(r["schema"], r["name"])
    if r["kind"] == "e":
        return "CREATE TYPE %s AS ENUM (%s)" % (n, ", ".join(sql_lit(x) for x in (r.get("labels") or [])))
    if r["kind"] == "c":
        cols = ", ".join("%s %s%s" % (quote_ident(a["n"]), a["t"], (" COLLATE " + a["coll"]) if a.get("coll") else "") for a in r["attrs"])
        if r.get("table"):
            return "CREATE TABLE %s (%s)" % (n, cols)
        return "CREATE TYPE %s AS (%s)" % (n, cols)
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


def _reg_exists(sess, sql):
    try:
        return sess.scalar(sql) == "t"
    except EngineError as e:
        if "does not exist" in (e.message or ""):
            return False
        raise


def prereq_exists(sess, kind, item):
    if kind == "schema":
        return sess.scalar("SELECT to_regnamespace(%s) IS NOT NULL" % sql_lit(quote_ident(item["name"]))) == "t"
    # before PostgreSQL 16 to_regtype / to_regprocedure RAISE when a type named in the text does not exist (from 16 they answer NULL):
    # a function whose argument type is missing cannot exist either (matrix PG 14/15: 'type "app.prod" does not exist' failed the restore)
    if kind == "type":
        return _reg_exists(sess, "SELECT to_regtype(%s) IS NOT NULL" % sql_lit(qi(item["schema"], item["name"])))
    if kind == "function":
        return _reg_exists(sess, "SELECT to_regprocedure(%s) IS NOT NULL" % sql_lit(item["sig"]))
    if kind == "extension":
        return sess.scalar("SELECT 1 FROM pg_extension WHERE extname = %s" % sql_lit(item)) == "1"
    if kind == "collation":
        return sess.scalar("SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace WHERE n.nspname = %s AND c.collname = %s "
                           "AND c.collencoding IN (-1, (SELECT encoding FROM pg_database WHERE datname = current_database()))" % (sql_lit(item["schema"]), sql_lit(item["name"]))) == "1"
    return False


def ensure_prereqs(sess, meta, only_missing=True, roles_ok=None, quiet_unused=None):
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
    for s in p["schemas"]:
        if only_missing and prereq_exists(sess, "schema", s):
            continue
        extra = []
        if s.get("owner") and (roles_ok is None or s["owner"] in roles_ok):
            extra.append("ALTER SCHEMA %s OWNER TO %s" % (quote_ident(s["name"]), quote_ident(s["owner"])))
        extra += [x for x in _acl_stmts("SCHEMA", quote_ident(s["name"]), [a for a in (s.get("acl") or []) if a["g"] == "PUBLIC" or roles_ok is None or a["g"] in roles_ok])]
        run("schema %s" % s["name"], "CREATE SCHEMA %s" % quote_ident(s["name"]), extra)
    # extensions after the schemas: an extension installed in its own schema (CREATE EXTENSION citext SCHEMA ext) goes back there,
    # otherwise its types would land in another schema and every column using ext.citext would fail
    esch = p.get("ext_schemas") or {}
    for e in p["extensions"]:
        if not prereq_exists(sess, "extension", e):
            sch = esch.get(e)
            if sch and sess.scalar("SELECT to_regnamespace(%s) IS NOT NULL" % sql_lit(quote_ident(sch))) == "t":
                if not run("extension %s" % e, "CREATE EXTENSION IF NOT EXISTS %s SCHEMA %s" % (quote_ident(e), quote_ident(sch))):
                    problems.pop()                       # a non-relocatable extension refuses SCHEMA: plain CREATE EXTENSION puts it where it belongs
                    run("extension %s" % e, "CREATE EXTENSION IF NOT EXISTS %s" % quote_ident(e))
            else:
                run("extension %s" % e, "CREATE EXTENSION IF NOT EXISTS %s" % quote_ident(e))
        elif esch.get(e):
            now = sess.scalar("SELECT n.nspname FROM pg_extension x JOIN pg_namespace n ON n.oid = x.extnamespace WHERE x.extname = %s" % sql_lit(e))
            if now and now != esch[e]:
                problems.append("extension %s is installed in schema %s here, the recovered objects use it from schema %s" % (e, now, esch[e]))
    for c in p.get("collations") or []:
        if only_missing and prereq_exists(sess, "collation", c):
            continue
        extra = []
        if c.get("owner") and (roles_ok is None or c["owner"] in roles_ok):
            extra.append("ALTER COLLATION %s OWNER TO %s" % (qi(c["schema"], c["name"]), quote_ident(c["owner"])))
        run("collation %s.%s" % (c["schema"], c["name"]), c["ddl"], extra)
    pending = []
    quiet = set()       # in the quarantine: functions that are only in the same schema as the selection (none of the objects uses them) - their failure is not news
    for t in p["types"]:
        if only_missing and prereq_exists(sess, "type", t):
            continue
        if t.get("table") and only_missing:
            # never create a table in the live database as a side effect: the plan already refused (the user selects that table too)
            problems.append("table %s.%s (its row type is a column type of the recovered objects) does not exist" % (t["schema"], t["name"]))
            continue
        extra = []
        if t.get("owner") and (roles_ok is None or t["owner"] in roles_ok):
            extra.append("ALTER TYPE %s OWNER TO %s" % (qi(t["schema"], t["name"]), quote_ident(t["owner"])))
        pending.append(("type %s.%s" % (t["schema"], t["name"]), t["ddl"], extra))
    for f in p["functions"]:
        if only_missing and prereq_exists(sess, "function", f):
            continue
        extra = []
        kw = "PROCEDURE" if f["kind"] == "p" else "FUNCTION"
        if f.get("owner") and (roles_ok is None or f["owner"] in roles_ok):
            extra.append("ALTER %s %s OWNER TO %s" % (kw, f["sig"], quote_ident(f["owner"])))
        extra += _acl_stmts(kw, f["sig"], [a for a in (f.get("acl") or []) if a["g"] == "PUBLIC" or roles_ok is None or a["g"] in roles_ok])
        pending.append(("function %s" % f["sig"], f["ddl"], extra))
        if f.get("used") is False and (quiet_unused if quiet_unused is not None else not only_missing):
            quiet.add("function %s" % f["sig"])
    # types and functions can need each other (a domain whose CHECK calls a function, a function taking a composite type): passes until nothing more
    # can be created; what still fails is reported with its last error
    last = {}
    while pending:
        nxt = []
        for label, sql, extra in pending:
            try:
                sess.query(sql)
            except EngineError as e:
                last[label] = e.message[:200]
                nxt.append((label, sql, extra))
                continue
            created.append(label)
            for x in extra:
                try:
                    sess.query(x)
                except EngineError as e:
                    problems.append("%s (owner/grants): %s" % (label, e.message[:160]))
        if len(nxt) == len(pending):
            problems += ["%s: %s" % (label, last.get(label, "?")) for label, _, _ in nxt if label not in quiet]
            break
        pending = nxt
    return created, problems



# ============================================================================================================== large objects referenced by tables
LO_CHUNK = 1 << 20


def lo_columns(sess, schema, name):
    """Columns that hold large-object references: type oid, or a domain over oid (the lo extension's `lo`)."""
    return [r[0] for r in sess.query(
        "SELECT a.attname FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid WHERE a.attrelid = %s::regclass AND a.attnum > 0 AND NOT a.attisdropped "
        "AND (a.atttypid = 'oid'::regtype OR t.typbasetype = 'oid'::regtype) ORDER BY a.attnum" % sql_lit(qi(schema, name)))]


def lo_referenced(sess, schema, name, cols, only_missing_in=None):
    """Large objects referenced by the table (that exist in this database). With only_missing_in: those absent from that other session's database."""
    if not cols:
        return []
    union = " UNION ".join("SELECT %s::oid AS o FROM %s WHERE %s IS NOT NULL" % (quote_ident(c), qi(schema, name), quote_ident(c)) for c in cols)
    oids = [int(r[0]) for r in sess.query("SELECT DISTINCT r.o FROM (%s) r JOIN pg_largeobject_metadata m ON m.oid = r.o ORDER BY 1" % union) if r and r[0]]
    if only_missing_in is not None and oids:
        have = set()
        for i in range(0, len(oids), 5000):
            part = oids[i:i + 5000]
            have |= {int(r[0]) for r in only_missing_in.query("SELECT oid FROM pg_largeobject_metadata WHERE oid = ANY(ARRAY[%s]::oid[])" % ",".join(map(str, part))) if r and r[0]}
        oids = [o for o in oids if o not in have]
    return oids


def copy_large_objects(src, dst, oids, owners_ok=None):
    """Copy large objects src -> dst keeping their oid (the rows reference them by oid), in 1 MiB pieces (no whole document in memory), with their
    owner when that role exists. Returns how many were copied."""
    n = 0
    for o in oids:
        owner = src.scalar("SELECT pg_get_userbyid(lomowner) FROM pg_largeobject_metadata WHERE oid = %d" % o)
        dst.query("SELECT lo_create(%d)" % o)
        off = 0
        while True:
            # base64 lines are wrapped at 76 characters: unwrapped server-side, so the value is ONE line for the session that reads it
            chunk = src.scalar("SELECT translate(encode(lo_get(%d, %d, %d), 'base64'), E'\\n', '')" % (o, off, LO_CHUNK)) or ""
            data = chunk.strip()
            if data:
                dst.query("SELECT lo_put(%d, %d, decode(%s, 'base64'))" % (o, off, sql_lit(data)))
            got = len(data) * 3 // 4 - data[-2:].count("=") if data else 0
            if got < LO_CHUNK:
                break
            off += got
        if owner and (owners_ok is None or owner in owners_ok):
            try:
                dst.query("ALTER LARGE OBJECT %d OWNER TO %s" % (o, quote_ident(owner)))
            except EngineError:
                pass
        n += 1
    return n

# ============================================================================================================== stage
TOC_DESC = re.compile(r"^\s*\d+; \d+ \d+ (TABLE ATTACH|TABLE DATA|TABLE|INDEX ATTACH|INDEX|FK CONSTRAINT|CHECK CONSTRAINT|CONSTRAINT|DEFAULT ACL|DEFAULT|"
                      r"SEQUENCE OWNED BY|SEQUENCE SET|SEQUENCE|[A-Z][A-Z ]*?) ")
SHELL_KEEP = ("TABLE", "TABLE ATTACH", "DEFAULT", "SEQUENCE", "SEQUENCE OWNED BY", "CONSTRAINT", "CHECK CONSTRAINT", "INDEX", "INDEX ATTACH")


def toc_desc(line):
    """The object type of a `pg_restore -l` line (None for comments). Schema and names may contain spaces, so they are never split."""
    m = TOC_DESC.match(line)
    return m.group(1) if m else None


def _roles_present(sess, names):
    if not names:
        return set()
    r = sess.query("SELECT rolname FROM pg_roles WHERE rolname = ANY(ARRAY[%s])" % ",".join(sql_lit(n) for n in names))
    return {x[0] for x in r}


def dump_for_stage(eph_conn, dbname, info, tmp, progress=None, cancel=None):
    """pg_dump of the selected tables and sequences (partitions included) from the recovered instance."""
    names = [qi(t["schema"], t["name"]) for t in info["tables"]] + [qi(s["schema"], s["name"]) for s in info["sequences"]] + \
            [qi(s["schema"], s["name"]) for s in (info.get("owned_sequences") or [])]
    names = list(dict.fromkeys(names))
    if not names:
        return None
    dumpfile = os.path.join(tmp, "sel.dump")
    args = eph_conn.args() + ["--strict-names", "-f", dumpfile, "-d", dbname]
    for n in names:
        args += ["-t", n]
    rc, out, err = run_dump(eph_conn, args, cancel=cancel)
    if rc != 0:
        raise EngineError("PGA-GEN-072", "pg_dump of the selection failed: %s" % err.strip()[:600])
    return dumpfile


def filtered_toc(admin, dumpfile, tmp, drop_fks):
    """Entry list for pg_restore without the foreign keys whose referenced table is not part of the dump (they are re-attached against the LIVE table on promotion)."""
    rc, out, err = run_tool(admin, "pg_restore", ["-l", dumpfile], timeout=120)
    if rc != 0:
        raise EngineError("PGA-GEN-071", "cannot read the dump: %s" % err.strip()[:300])
    keep, dropped = [], 0
    marks = {" FK CONSTRAINT %s %s %s " % k: k for k in drop_fks}      # names may contain spaces: match the whole "schema table name" run, never split it
    for line in out.splitlines():
        if toc_desc(line) == "FK CONSTRAINT" and any(m in line for m in marks):
            dropped += 1
            continue
        keep.append(line)
    path = os.path.join(tmp, "toc.lst")
    with open(path, "w") as f:
        f.write("\n".join(keep) + "\n")
    return path, dropped


def shell_toc(admin, eph_conn, dbname, ancestors, tmp, cancel=None):
    """Schema-only dump of the ancestors of the selected tables (structure, defaults, keys and indexes: what a child needs to be created and
    attached exactly as it was dumped). Returns (dumpfile, toc path)."""
    dumpfile = os.path.join(tmp, "shell.dump")
    args = eph_conn.args() + ["--schema-only", "--strict-names", "-f", dumpfile, "-d", dbname]
    for a in ancestors:
        args += ["-t", qi(a["schema"], a["name"])]
    rc, out, err = run_dump(eph_conn, args, cancel=cancel)
    if rc != 0:
        raise EngineError("PGA-GEN-072", "pg_dump of the parent tables failed: %s" % err.strip()[:600])
    rc, out, err = run_tool(admin, "pg_restore", ["-l", dumpfile], timeout=120)
    if rc != 0:
        raise EngineError("PGA-GEN-071", "cannot read the dump: %s" % err.strip()[:300])
    path = os.path.join(tmp, "shell.lst")
    with open(path, "w") as f:
        f.write("\n".join(l for l in out.splitlines() if toc_desc(l) in SHELL_KEEP) + "\n")
    return dumpfile, path


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


def build_stage(admin, eph, dbentry, sel, spec_label, stage, info, plan_extra, progress=None, create_db=None, cancel=None):
    """Create the quarantine database from the analysed selection. Returns the metadata written into it."""
    dbname = dbentry["name"]
    tmp = tempfile.mkdtemp(prefix="pgarca-stage-")
    try:
        if progress:
            progress({"phase": "transfer"})
        dumpfile = dump_for_stage(eph.conn(dbname), dbname, info, tmp, cancel=cancel)
        if cancel and cancel():
            from pg_arca.engine.util import Cancelled
            raise Cancelled()
        tset = {(t["schema"], t["name"]) for t in info["tables"]}
        drop_fks = {(f["schema"], f["table"], f["name"]) for f in info["fks"] if (f["schema"], f["table"]) in tset and (f["ref_schema"], f["ref_table"]) not in tset}
        meta = {"version": 1, "created": now_utc().isoformat(timespec="seconds"), "database": dbname, "selection": sel, "label": spec_label,
                "tables": [{"schema": t["schema"], "name": t["name"], "kind": t["kind"], "part": t["part"], "owner": t["owner"], "persistence": t.get("persistence")} for t in info["tables"]],
                "sequences": [{"schema": s["schema"], "name": s["name"], "owner": s["owner"], "acl": s["acl"]} for s in info["sequences"]],
                "owned_sequences": info.get("owned_sequences") or [],
                "views": info["views"], "fks": info["fks"], "positions": info["sequence_positions"], "roles": info["roles"],
                "detached": info.get("detached") or [], "statistics": info.get("statistics") or [],
                "prereq": {"types": info["types"], "functions": info["functions"], "extensions": info["extensions"], "schemas": info["schemas"],
                           "collations": info.get("collations") or [], "ext_schemas": info.get("ext_schemas") or {}},
                "warnings": list(info["warnings"]), "counts": {}}
        create_db()
        sess = PgSession(admin.with_db(stage))
        try:
            # marked INCOMPLETE until the very end: a quarantine left by an interrupted restore must never be promoted or used for row recovery
            write_meta(sess, {"version": 1, "building": True, "created": meta["created"], "database": dbname, "label": spec_label})
            roles_ok = _roles_present(sess, info["roles"])
            missing_roles = [r for r in info["roles"] if r not in roles_ok]
            meta["missing_roles_at_stage"] = missing_roles
            created, problems = ensure_prereqs(sess, meta, only_missing=False, roles_ok=roles_ok)
            meta["prereq_created"] = len(created)
            if dumpfile:
                toc, dropped = filtered_toc(admin, dumpfile, tmp, drop_fks)
                args = admin.args() + ["-d", stage, "--exit-on-error"]
                if missing_roles:
                    args += ["--no-owner", "--no-acl"]
                    meta["warnings"].append("roles missing on this server (%s): owners and grants of the recovered tables were NOT applied" % ", ".join(missing_roles[:6]))
                toids = [t["oid"] for t in info["tables"]]
                if toids:                                 # a table (or index) in a tablespace this server does not have: created in the default one, said
                    src_ts = PgSession(eph.conn(dbname), read_only=True)
                    try:
                        used_ts = [r[0] for r in src_ts.query("SELECT DISTINCT t.spcname FROM pg_class c JOIN pg_tablespace t ON t.oid = c.reltablespace WHERE c.reltablespace <> 0 "
                                                              "AND (c.oid = ANY(ARRAY[%s]::oid[]) OR c.oid IN (SELECT indexrelid FROM pg_index WHERE indrelid = ANY(ARRAY[%s]::oid[])))"
                                                              % (",".join(map(str, toids)), ",".join(map(str, toids))))]
                    finally:
                        src_ts.close()
                    gone_ts = [t for t in used_ts if sess.scalar("SELECT 1 FROM pg_tablespace WHERE spcname = %s" % sql_lit(t)) != "1"]
                    if gone_ts:
                        args.append("--no-tablespaces")
                        meta["warnings"].append("tablespaces missing on this server (%s): the recovered tables were created in the default tablespace" % ", ".join(gone_ts))

                def load(df, lst, section=None):
                    rc, out, err = run_tool(admin, "pg_restore", args + ["-L", lst] + (["--section", section] if section else []) + [df], timeout=None, cancel=cancel)
                    if rc != 0:
                        raise EngineError("PGA-GEN-071", "pg_restore into the quarantine database failed: %s" % (err.strip() or out.strip())[:900])
                shells = info.get("ancestors") or []
                if shells:
                    # parents first as empty shells, in the order pg_dump itself would use: the selection is created/attached before the parents get their
                    # keys and indexes (otherwise ATTACH would build duplicate indexes), then the selection's own keys attach to the parents' ones
                    sdump, slst = shell_toc(admin, eph.conn(dbname), dbname, shells, tmp, cancel=cancel)
                    load(sdump, slst, "pre-data")
                    load(dumpfile, toc, "pre-data")
                    load(dumpfile, toc, "data")
                    load(sdump, slst, "post-data")
                    load(dumpfile, toc, "post-data")
                    for d in info["detached"]:          # the stage keeps the recovered tables standalone: promotion attaches them to the LIVE parent
                        if d["part"]:
                            sess.query("ALTER TABLE %s DETACH PARTITION %s" % (qi(d["parent_schema"], d["parent"]), qi(d["schema"], d["name"])))
                        else:
                            sess.query("ALTER TABLE %s NO INHERIT %s" % (qi(d["schema"], d["name"]), qi(d["parent_schema"], d["parent"])))
                    # the empty shells stay in the stage (a child's column default may use a parent's sequence); they are never promoted
                    meta["shells"] = [{"schema": a["schema"], "name": a["name"]} for a in shells]
                else:
                    load(dumpfile, toc)
                meta["fks_deferred"] = dropped
            if problems:
                # functions using a recovered table's row type (RETURNS SETOF app.t, f(r app.t)) cannot exist before that table: a second pass after the load,
                # and only what is still missing is reported
                created2, problems = ensure_prereqs(sess, meta, only_missing=True, roles_ok=roles_ok, quiet_unused=True)
                meta["prereq_created"] += len(created2)
            if problems:
                meta["warnings"] += ["prerequisite not recreated - %s" % p for p in problems]
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
            # large objects the recovered rows reference: pg_dump -t does not carry them. Copied from the recovered instance (same oid) so that promotion
            # and row recovery can bring back the ones deleted since
            src = PgSession(eph.conn(dbname), read_only=True)
            try:
                los = {}
                for t in info["tables"]:
                    if t["kind"] == "p":
                        continue
                    cols = lo_columns(sess, t["schema"], t["name"])
                    if cols:
                        oids = lo_referenced(src, t["schema"], t["name"], cols, only_missing_in=sess)
                        if oids:
                            copy_large_objects(src, sess, oids, roles_ok)
                        los["%s.%s" % (t["schema"], t["name"])] = cols
                if los:
                    meta["lo_columns"] = los
            finally:
                src.close()
            write_meta(sess, meta)
        finally:
            sess.close()
        return meta
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ============================================================================================================== promotion (stage -> live database)
def _short(base, suffix):
    """base + suffix within PostgreSQL's 63-byte identifier limit. A name that has to be shortened keeps a hash of the full name, so two long names never collide."""
    if len(base.encode("utf-8")) + len(suffix) <= 63:
        return base + suffix
    import hashlib
    h = hashlib.md5(base.encode("utf-8")).hexdigest()[:6]
    keep = 63 - len(suffix) - 7
    b = base.encode("utf-8")[:keep].decode("utf-8", "ignore")
    return "%s_%s%s" % (b, h, suffix)


def _exists(sess, schema, name):
    return sess.scalar("SELECT to_regclass(%s) IS NOT NULL" % sql_lit(qi(schema, name))) == "t"


def _idx_and_seqs(sess, schema, name):
    """Names of the indexes of a table and of the sequences it owns (identity/serial)."""
    fq = sql_lit(qi(schema, name))
    idx = [r[0] for r in sess.query("SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = %s::regclass ORDER BY c.relname" % fq)]
    seq = [(r[0], r[1]) for r in sess.query("SELECT sn.nspname, s.relname FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S' JOIN pg_namespace sn ON sn.oid = s.relnamespace "
                                            "WHERE d.refobjid = %s::regclass AND d.refclassid = 'pg_class'::regclass AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a','i') ORDER BY s.relname" % fq)]
    return idx, seq


def _view_ddl(v):
    kind = "MATERIALIZED VIEW" if v["kind"] == "m" else "VIEW"
    opts = ""
    if v.get("opts"):
        opts = " WITH (%s)" % ", ".join(v["opts"])
    return kind, "CREATE %s %s%s AS %s%s" % (kind, qi(v["schema"], v["name"]), opts, v["def"], " WITH DATA" if v["kind"] == "m" else "")


def _slim(plan):
    """The plan for people/UI: without view definitions or ACL blobs."""
    out = dict(plan)
    out["live_views"] = [{k: v[k] for k in ("schema", "name", "kind")} for v in plan.get("live_views") or []]
    out["recovered_views"] = [{k: v[k] for k in ("schema", "name", "kind")} for v in plan.get("recovered_views") or []]
    out["inbound_fks"] = [{k: f.get(k) for k in ("name", "schema", "table", "ref_schema", "ref_table", "source")} for f in plan.get("inbound_fks") or []]
    out["outbound_fks"] = [{k: f.get(k) for k in ("name", "schema", "table", "ref_schema", "ref_table", "source")} for f in plan.get("outbound_fks") or []]
    out["statistics"] = [{k: x.get(k) for k in ("schema", "name", "table_schema", "table")} for x in plan.get("statistics") or []]
    out["rebind"] = (["publication %s" % x["pub"] for x in plan.get("publications") or []] + ["rule %s on %s.%s" % (x["name"], x["schema"], x["table"]) for x in plan.get("foreign_rules") or []]
                     + ["policy %s on %s.%s" % (x["name"], x["schema"], x["table"]) for x in plan.get("foreign_policies") or []]
                     + ["trigger %s on %s.%s" % (x["name"], x["schema"], x["table"]) for x in plan.get("foreign_triggers") or []]
                     + ["default of %s.%s.%s" % (x["schema"], x["table"], x["column"]) for x in plan.get("foreign_defaults") or []]
                     + ["partition %s.%s → %s.%s" % (a["schema"], a["name"], a["parent_schema"], a["parent"]) for a in plan.get("attach") or []]
                     + ["function %s" % f["sig"] for f in (plan.get("rowtype_funcs") or []) + (plan.get("body_funcs") or []) if f.get("def")])
    for k in ("publications", "foreign_rules", "foreign_policies", "foreign_defaults", "rowtype_funcs", "body_funcs", "foreign_triggers"):
        out.pop(k, None)
    out.pop("old_outbound_fks", None)
    return out


COLS_SQL = ("SELECT COALESCE(jsonb_object_agg(a.attname, format_type(a.atttypid, a.atttypmod)), '{}'::jsonb)::text FROM pg_attribute a "
            "WHERE a.attrelid = to_regclass(%s) AND a.attnum > 0 AND NOT a.attisdropped")


def _columns(sess, schema, name):
    r = sess.scalar(COLS_SQL % sql_lit(qi(schema, name)))
    return json.loads(r) if r else {}


def _live_plan(live, meta, mode, ts, stage_cols=None):
    """Inspect the live database and say exactly what promotion would do. Nothing is changed."""
    sfx_new, sfx_old = "_pitr_" + ts, "_old_" + ts
    plan = {"mode": mode, "suffix": ts, "tables": [], "inbound_fks": [], "outbound_fks": [], "views": [], "warnings": list(meta.get("warnings") or []), "blocking": [], "old_kept_as": []}
    sel = {(t["schema"], t["name"]) for t in meta["tables"]}
    swap_oids = []
    for t in meta["tables"]:
        ex = _exists(live, t["schema"], t["name"])
        act = "copy" if mode == "as_new" else ("skip" if (mode == "missing_only" and ex) else ("swap" if ex else "create"))
        if t.get("persistence") == "u":
            # UNLOGGED: PostgreSQL never writes its rows to the WAL, so no backup holds them - the recovered table is always EMPTY. Replacing the live one
            # would only lose its rows: it is kept. Brought back where it is missing (structure, indexes, grants), empty.
            if act == "swap":
                act = "skip"
                plan["warnings"].append("%s.%s is UNLOGGED: its rows are in no backup (PostgreSQL does not log them), so the recovered copy is empty - the live table is kept as it is"
                                        % (t["schema"], t["name"]))
            elif act in ("create", "copy"):
                plan["warnings"].append("%s.%s is UNLOGGED: it comes back with its structure but EMPTY (its rows are in no backup)" % (t["schema"], t["name"]))
        row = {"schema": t["schema"], "name": t["name"], "kind": t["kind"], "action": act, "exists_now": ex, "rows_at_target": (meta.get("counts") or {}).get("%s.%s" % (t["schema"], t["name"]))}
        if t.get("persistence") == "u":
            row["unlogged"] = True
        if act == "swap":
            row["old_kept_as"] = _short(t["name"], sfx_old)
            # the table changed SHAPE since the target (columns added / retyped by a migration): replacing it brings back the old shape, and the
            # application that uses the new columns breaks. Said in the plan, never silently.
            sc = (stage_cols or {}).get((t["schema"], t["name"]))
            if sc:
                lc = _columns(live, t["schema"], t["name"])
                added = sorted(c for c in lc if c not in sc)
                retyped = sorted(c for c in lc if c in sc and lc[c] != sc[c])
                if added or retyped:
                    row["schema_drift"] = {"columns_only_now": added, "type_changed": retyped}
                    plan["warnings"].append("%s.%s changed shape since the restore point (%s%s): replacing it brings back the OLD columns - the current ones "
                                            "stay only in %s; consider 'as new' or recovering rows" % (t["schema"], t["name"],
                                                                                                      ("columns added since: %s" % ", ".join(added)) if added else "",
                                                                                                      ("%stype changed: %s" % ("; " if added else "", ", ".join(retyped))) if retyped else "",
                                                                                                      row["old_kept_as"]))
            plan["old_kept_as"].append("%s.%s" % (t["schema"], row["old_kept_as"]))
            swap_oids.append(int(live.scalar("SELECT %s::regclass::oid::int" % sql_lit(qi(t["schema"], t["name"])))))
        if act == "copy":
            row["new_name"] = _short(t["name"], sfx_new)
        plan["tables"].append(row)
    acting = {(r["schema"], r["name"]) for r in plan["tables"] if r["action"] in ("swap", "create")}
    swapping = {(r["schema"], r["name"]) for r in plan["tables"] if r["action"] == "swap"}
    arr = lambda xs: "ARRAY[%s]::oid[]" % ",".join(str(x) for x in xs) if xs else "ARRAY[]::oid[]"
    if swap_oids:
        plan["inbound_fks"] = _jq(live, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('name', k.conname, 'schema', n.nspname, 'table', c.relname, 'def', pg_get_constraintdef(k.oid), 'ref_schema', rn.nspname, 'ref_table', rc.relname, 'source', 'live')), '[]'::jsonb)::text
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_class rc ON rc.oid = k.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE k.contype = 'f' AND k.conparentid = 0 AND k.confrelid = ANY(%s) AND NOT (k.conrelid = ANY(%s))""" % (arr(swap_oids), arr(swap_oids))) or []
        plan["old_outbound_fks"] = _jq(live, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('name', k.conname, 'schema', n.nspname, 'table', c.relname, 'def', pg_get_constraintdef(k.oid))), '[]'::jsonb)::text
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE k.contype = 'f' AND k.conparentid = 0 AND k.conrelid = ANY(%s) AND NOT (k.confrelid = ANY(%s))""" % (arr(swap_oids), arr(swap_oids))) or []
        plan["live_views"] = collect_views(live, swap_oids, [])
        # logical replication: a table listed by name in a publication stays in it after the rename (the kept copy would go on being published and the
        # recovered table would silently NOT be): the swap moves the membership, with its row filter / column list (PostgreSQL 15+)
        has15 = int(live.scalar("SHOW server_version_num")) >= 150000
        plan["publications"] = _jq(live, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('pub', p.pubname, 'schema', n.nspname, 'table', c.relname, 'qual', %s, 'cols', %s)), '[]'::jsonb)::text
FROM pg_publication_rel pr JOIN pg_publication p ON p.oid = pr.prpubid JOIN pg_class c ON c.oid = pr.prrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE pr.prrelid = ANY(%s)""" % ("pg_get_expr(pr.prqual, pr.prrelid)" if has15 else "NULL::text",
                                 "(SELECT jsonb_agg(a.attname ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = pr.prrelid AND a.attnum = ANY(pr.prattrs))" if has15 else "NULL::jsonb",
                                 arr(swap_oids))) or []
        # rules and row-level-security policies of OTHER tables that mention a replaced table are bound to it by identity (like views): left alone they would go
        # on reading/writing the kept old copy. Their definitions are taken now and they are recreated in the swap, against the recovered table.
        plan["foreign_rules"] = _jq(live, """
SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('schema', n.nspname, 'table', c.relname, 'name', r.rulename, 'def', pg_get_ruledef(r.oid))), '[]'::jsonb)::text
FROM pg_depend d JOIN pg_rewrite r ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = ANY(%s) AND NOT (r.ev_class = ANY(%s)) AND c.relkind IN ('r', 'p') AND r.rulename <> '_RETURN'""" % (arr(swap_oids), arr(swap_oids))) or []
        # constraint triggers of OTHER tables declared FROM a replaced table (CREATE CONSTRAINT TRIGGER ... FROM t): tgconstrrelid is the table's identity
        plan["foreign_triggers"] = _jq(live, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('schema', n.nspname, 'table', c.relname, 'name', t.tgname, 'def', pg_get_triggerdef(t.oid), 'enabled', t.tgenabled::text)), '[]'::jsonb)::text
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND t.tgconstrrelid = ANY(%s) AND NOT (t.tgrelid = ANY(%s))""" % (arr(swap_oids), arr(swap_oids))) or []
        plan["foreign_policies"] = _jq(live, """
SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('schema', n.nspname, 'table', c.relname, 'name', p.polname, 'cmd', p.polcmd::text, 'permissive', p.polpermissive,
       'roles', (SELECT jsonb_agg(CASE WHEN x = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x) END) FROM unnest(p.polroles) x),
       'qual', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid))), '[]'::jsonb)::text
FROM pg_depend d JOIN pg_policy p ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = ANY(%s) AND NOT (p.polrelid = ANY(%s))""" % (arr(swap_oids), arr(swap_oids))) or []
        # column defaults of OTHER tables that draw from a replaced table's own sequence (nextval('customers_id_seq') used elsewhere too): bound by identity
        # to the sequence that is renamed away with the old table -> re-set from their text after the swap, so both tables keep sharing one sequence
        plan["foreign_defaults"] = _jq(live, """
SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('schema', n.nspname, 'table', c.relname, 'column', a.attname, 'expr', pg_get_expr(ad.adbin, ad.adrelid))), '[]'::jsonb)::text
FROM pg_depend own JOIN pg_depend d ON d.refclassid = 'pg_class'::regclass AND d.refobjid = own.objid AND d.classid = 'pg_attrdef'::regclass
     JOIN pg_attrdef ad ON ad.oid = d.objid JOIN pg_class c ON c.oid = ad.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
WHERE own.classid = 'pg_class'::regclass AND own.refclassid = 'pg_class'::regclass AND own.deptype IN ('a', 'i') AND own.refobjid = ANY(%s)
  AND NOT (ad.adrelid = ANY(%s))""" % (arr(swap_oids), arr(swap_oids))) or []
        # functions whose arguments or result use a replaced table's ROW TYPE (RETURNS SETOF app.prod, f(p app.prod), app.prod[]): the type belongs to the
        # table and goes with the old copy - left alone, app.prod_label(app.prod) would no longer exist for the application. Taken now (their text names
        # the type as it is called now) and recreated in the swap against the recovered table's type
        rt = "(SELECT reltype FROM pg_class WHERE oid = ANY(%s) UNION SELECT t.typarray FROM pg_type t WHERE t.oid IN (SELECT reltype FROM pg_class WHERE oid = ANY(%s)))" % (arr(swap_oids), arr(swap_oids))
        plan["rowtype_funcs"] = _jq(live, """
SELECT COALESCE(jsonb_agg(jsonb_build_object('oid', p.oid::int, 'sig', p.oid::regprocedure::text, 'kind', p.prokind, 'def', CASE WHEN p.prokind IN ('f', 'p') THEN pg_get_functiondef(p.oid) END,
       'owner', pg_get_userbyid(p.proowner), 'acl_null', p.proacl IS NULL, 'acl', %s, 'comment', obj_description(p.oid, 'pg_proc'),
       'in_args', EXISTS (SELECT 1 FROM unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) x WHERE x IN %s)) ORDER BY p.oid), '[]'::jsonb)::text
FROM pg_proc p WHERE p.oid IN (SELECT d.objid FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.refclassid = 'pg_type'::regclass AND d.deptype = 'n' AND d.refobjid IN %s)
  AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e')""" % (ACL_SQL % "p.proacl", rt, rt)) or []
        # functions / procedures with an SQL-standard body (BEGIN ATOMIC, PostgreSQL 14+) are bound to the tables they use by identity, like views: after a
        # rename they would go on reading and writing the OLD copy without any error. Re-created from their text (CREATE OR REPLACE keeps owner and grants)
        rto = {f["oid"] for f in plan["rowtype_funcs"]}
        plan["body_funcs"] = [f for f in (_jq(live, """
SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('oid', p.oid::int, 'sig', p.oid::regprocedure::text, 'def', pg_get_functiondef(p.oid))), '[]'::jsonb)::text
FROM pg_depend d JOIN pg_proc p ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid
WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = ANY(%s) AND p.prokind IN ('f', 'p')""" % arr(swap_oids)) or []) if f["oid"] not in rto]
        for f in plan["rowtype_funcs"]:
            if not f.get("def"):
                plan["warnings"].append("%s uses the row type of a replaced table and cannot be recreated automatically (kind %s): it stays bound to the old copy" % (f["sig"], f["kind"]))
        # columns of OTHER tables typed by a replaced table's row type keep the old copy's type (changing it rewrites their table): said, with the command
        for (cs, ct, ca, ty) in live.query("""
SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.attnum > 0 AND NOT a.attisdropped AND a.atttypid IN %s AND c.relkind IN ('r', 'p') AND NOT (c.oid = ANY(%s))""" % (rt, arr(swap_oids))):
            plan["warnings"].append("column %s.%s.%s has the row type of a replaced table (%s): it keeps the OLD copy's type, so that copy cannot be dropped without it; "
                                    "to move it: ALTER TABLE %s ALTER COLUMN %s TYPE %s USING %s::text::%s (rewrites that table)"
                                    % (cs, ct, ca, ty, qi(cs, ct), quote_ident(ca), ty, quote_ident(ca), ty))
        # this server SUBSCRIBES to the table (logical replication): the apply worker knows the old table by its identity; after the swap the recovered table
        # receives nothing until the subscription is refreshed (copy_data = false: the rows are the recovered ones)
        try:
            for (sub,) in live.query("SELECT DISTINCT s.subname FROM pg_subscription_rel sr JOIN pg_subscription s ON s.oid = sr.srsubid WHERE sr.srrelid = ANY(%s)" % arr(swap_oids)):
                plan["warnings"].append("subscription %s replicates a table being replaced: after the swap run ALTER SUBSCRIPTION %s REFRESH PUBLICATION WITH (copy_data = false), "
                                        "otherwise the recovered table receives no changes" % (sub, quote_ident(sub)))
        except EngineError:
            pass
    else:
        plan["old_outbound_fks"], plan["live_views"], plan["publications"], plan["foreign_rules"], plan["foreign_policies"], plan["foreign_defaults"] = [], [], [], [], [], []
        plan["foreign_triggers"] = []
        plan["rowtype_funcs"], plan["body_funcs"] = [], []
    have = {(f["schema"], f["table"], f["name"]) for f in plan["inbound_fks"]}
    # foreign keys that belonged to the recovered tables / pointed at the recreated ones (only where the other side exists now)
    for f in meta.get("fks") or []:
        mine, ref = (f["schema"], f["table"]) in sel, (f["ref_schema"], f["ref_table"]) in sel
        if mine and not ref and (f["schema"], f["table"]) in acting:                      # recovered table -> a table outside the selection
            if _exists(live, f["ref_schema"], f["ref_table"]):
                plan["outbound_fks"].append(dict(f, source="recovered"))
            else:
                plan["warnings"].append("foreign key %s not recreated: the table it references (%s.%s) does not exist" % (f["name"], f["ref_schema"], f["ref_table"]))
        elif ref and not mine and (f["ref_schema"], f["ref_table"]) in acting and (f["ref_schema"], f["ref_table"]) not in swapping:   # a table that was gone: children lost their FK with it
            if _exists(live, f["schema"], f["table"]) and (f["schema"], f["table"], f["name"]) not in have:
                has = live.scalar("SELECT 1 FROM pg_constraint WHERE conname = %s AND conrelid = %s::regclass" % (sql_lit(f["name"]), sql_lit(qi(f["schema"], f["table"]))))
                if has != "1":
                    plan["inbound_fks"].append(dict(f, source="recovered", ref_schema=f["ref_schema"], ref_table=f["ref_table"]))
    # views: the live ones that depend on tables being swapped are recreated against the new table; recovered views that are gone now come back too
    live_names = {(v["schema"], v["name"]) for v in plan["live_views"]}
    for v in plan["live_views"]:
        plan["views"].append({"schema": v["schema"], "name": v["name"], "kind": v["kind"], "source": "live"})
    plan["recovered_views"] = []
    if mode != "as_new":
        for v in meta.get("views") or []:
            if (v["schema"], v["name"]) in live_names:
                continue
            if not _exists(live, v["schema"], v["name"]):
                plan["recovered_views"].append(v)
                plan["views"].append({"schema": v["schema"], "name": v["name"], "kind": v["kind"], "source": "recovered"})
    # tables recovered without their parent: the live copy is detached (kept) and the recovered one attached to the live parent with the same bound
    plan["attach"] = []
    if mode != "as_new":
        for d in meta.get("detached") or []:
            row = next((r for r in plan["tables"] if r["schema"] == d["schema"] and r["name"] == d["name"]), None)
            if not row or row["action"] not in ("swap", "create"):
                continue
            if not _exists(live, d["parent_schema"], d["parent"]):
                plan["warnings"].append("%s.%s comes back standalone: its parent %s.%s does not exist now" % (d["schema"], d["name"], d["parent_schema"], d["parent"]))
                continue
            attached_now = row["action"] == "swap" and live.scalar(
                "SELECT 1 FROM pg_inherits WHERE inhrelid = %s::regclass AND inhparent = %s::regclass" % (sql_lit(qi(d["schema"], d["name"])), sql_lit(qi(d["parent_schema"], d["parent"])))) == "1"
            plan["attach"].append(dict(d, detach_old=attached_now))
    plan["statistics"] = [x for x in (meta.get("statistics") or []) if (x["table_schema"], x["table"]) in acting] if mode != "as_new" else []
    # prerequisites the destination lacks
    pq = meta["prereq"]
    missing = {"extensions": [e for e in pq["extensions"] if not prereq_exists(live, "extension", e)],
               "schemas": [x["name"] for x in pq["schemas"] if not prereq_exists(live, "schema", x)],
               "types": ["%s.%s" % (t["schema"], t["name"]) for t in pq["types"] if not t.get("table") and not prereq_exists(live, "type", t)],
               "collations": ["%s.%s" % (c["schema"], c["name"]) for c in pq.get("collations") or [] if not prereq_exists(live, "collation", c)],
               "functions": [f["sig"] for f in pq["functions"] if not prereq_exists(live, "function", f)]}
    plan["missing_prereq"] = missing
    if any(o.get("kind") == "schema" for o in meta.get("selection") or []):
        kept = [f["sig"] for f in pq["functions"] if prereq_exists(live, "function", f)]
        if kept:
            plan["warnings"].append("%d function(s) of the restored schema exist now and are kept in their CURRENT version (only missing functions come back): %s"
                                    % (len(kept), ", ".join(kept[:5])))
    for t in pq["types"]:
        if t.get("table") and not prereq_exists(live, "type", t):
            plan["blocking"].append("a recovered column has the row type of table %s.%s, which does not exist now: select that table too (it is not created by itself)" % (t["schema"], t["name"]))
    present = _roles_present(live, meta.get("roles") or [])
    plan["missing_roles"] = [r for r in (meta.get("roles") or []) if r not in present]
    if plan["missing_roles"]:
        plan["warnings"].append("roles not present here (%s): owners and grants of the recovered objects are NOT applied" % ", ".join(plan["missing_roles"][:6]))
    # the swap is ONE transaction: every renamed/created relation (tables, their indexes, TOAST, sequences: old and new) holds a lock until COMMIT.
    # A big schema can exceed the server's lock table (max_locks_per_transaction x (max_connections + max_prepared_transactions)) and fail half-way
    # with "out of shared memory" - known BEFORE starting, so it is said now.
    acting_tabs = [r for r in plan["tables"] if r["action"] in ("swap", "create", "copy")]       # phase 1 (pg_restore --single-transaction) locks them too
    if acting_tabs:
        per = live.scalar("SELECT coalesce(sum(1 + (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid) + CASE WHEN c.reltoastrelid <> 0 THEN 2 ELSE 0 END), 0) "
                          "FROM pg_class c WHERE c.oid = ANY(ARRAY[%s]::oid[])" % (",".join(str(x) for x in swap_oids) or "0")) if swap_oids else "0"
        swapped_rel = int(per or 0)
        need = 2 * swapped_rel + 4 * (len(acting_tabs) - len(swap_oids)) + 2 * (len(plan["views"]) + len(plan["inbound_fks"]) + len(plan["outbound_fks"])) + 50
        cap = live.scalar("SELECT current_setting('max_locks_per_transaction')::int * (current_setting('max_connections')::int + current_setting('max_prepared_transactions')::int)")
        cap = int(cap or 0)
        plan["locks"] = {"needed_about": need, "server_slots": cap}
        if cap and cap // 2 < need <= cap * 85 // 100:
            plan["warnings"].append("the swap needs about %d of the server's %d lock slots in one transaction: busy servers may run out (raise max_locks_per_transaction if it fails)" % (need, cap))
        if cap and need > cap * 85 // 100:
            plan["blocking"].append("the swap needs about %d locks in one transaction, the server's lock table has %d slots shared by all sessions "
                                    "(max_locks_per_transaction x connections): it would fail with 'out of shared memory'. Raise max_locks_per_transaction "
                                    "(restart needed) to at least %d, or restore and promote in smaller groups of tables" % (need, cap, -(-need * 2 // max(1, cap // max(1, int(live.scalar("SHOW max_locks_per_transaction") or 64)))) + 64))
    for f in plan["inbound_fks"]:
        f.pop("def_full", None)
    plan["counts"] = {"tables": len(plan["tables"]), "swap": sum(1 for r in plan["tables"] if r["action"] == "swap"), "create": sum(1 for r in plan["tables"] if r["action"] == "create"),
                      "copy": sum(1 for r in plan["tables"] if r["action"] == "copy"), "skip": sum(1 for r in plan["tables"] if r["action"] == "skip"),
                      "inbound_fks": len(plan["inbound_fks"]), "outbound_fks": len(plan["outbound_fks"]), "views": len(plan["views"]),
                      "attach": len(plan["attach"]), "statistics": len(plan["statistics"])}
    return plan


def _add_fk(live, f, validate_later):
    d = f["def"]
    partitioned = live.scalar("SELECT relkind = 'p' FROM pg_class WHERE oid = %s::regclass" % sql_lit(qi(f["schema"], f["table"]))) == "t"
    if partitioned:                                       # PostgreSQL cannot add a NOT VALID foreign key on a partitioned table: it is validated right away
        live.query("ALTER TABLE %s ADD CONSTRAINT %s %s" % (qi(f["schema"], f["table"]), quote_ident(f["name"]), d.replace(" NOT VALID", "")))
        return
    if "NOT VALID" not in d:
        d += " NOT VALID"
    live.query("ALTER TABLE %s ADD CONSTRAINT %s %s" % (qi(f["schema"], f["table"]), quote_ident(f["name"]), d))
    validate_later.append(f)


def _recreate_view(live, v, roles_ok):
    kind, ddl = _view_ddl(v)
    live.query(ddl)
    fq = qi(v["schema"], v["name"])
    if v.get("owner") and (roles_ok is None or v["owner"] in roles_ok):
        live.query("ALTER %s %s OWNER TO %s" % (kind, fq, quote_ident(v["owner"])))
    for stmt in _acl_stmts("TABLE", fq, [a for a in (v.get("acl") or []) if a["g"] == "PUBLIC" or roles_ok is None or a["g"] in roles_ok]):
        live.query(stmt)
    if v.get("comment"):
        live.query("COMMENT ON %s %s IS %s" % (kind, fq, sql_lit(v["comment"])))
    if v["kind"] == "m":
        for ix in v.get("indexes") or []:
            live.query(ix)


def _seq_forward(live, seqs, pos_of):
    """Existing sequences: set to the recovered position only when that is AHEAD of the live one (never backwards). Returns the ones moved."""
    moved = []
    for x in seqs:
        p = pos_of.get((x["schema"], x["name"]))
        if not p:
            continue
        fq = qi(x["schema"], x["name"])
        try:
            r = live.query("SELECT last_value, is_called FROM %s" % fq)
            cur = (int(r[0][0]), r[0][1] == "t") if r and r[0] else None
            if cur is None or (p["last"], p["called"]) > cur:
                live.query("SELECT setval(%s, %d, %s)" % (sql_lit(fq), p["last"], "true" if p["called"] else "false"))
                moved.append("%s.%s" % (x["schema"], x["name"]))
        except EngineError:
            continue
    return moved


def _compat(res):
    """Keep the single-table answer of the first version (`promoted_as`, `old_kept_as` as strings) next to the lists."""
    pr, ok = res.get("promoted") or [], res.get("old_kept_as") or []
    res["promoted"], res["old_kept"] = pr, ok
    res["promoted_as"] = pr[0] if len(pr) == 1 else None
    res["old_kept_as"] = ok[0] if len(ok) == 1 else None
    return res


ACTIVE_JOURNALS = set()                    # promotions running in THIS process: never treated as interrupted


def _journal_write(journal, data):
    if not journal:
        return
    ACTIVE_JOURNALS.add(journal)
    import json
    os.makedirs(os.path.dirname(journal), mode=0o700, exist_ok=True)
    tmp = journal + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.rename(tmp, journal)


def _journal_done(journal):
    if journal:
        ACTIVE_JOURNALS.discard(journal)
        try:
            os.unlink(journal)
        except OSError:
            pass


def _promote_lobs(admin, stage_db, live, meta, todo, plan):
    """After the tables are in place: the large objects their rows reference that the live database no longer has come back from the quarantine copy
    (same oid). Never replaces an existing one. Returns how many."""
    los = meta.get("lo_columns") or {}
    if not los:
        return 0
    ss = PgSession(admin.with_db(stage_db), read_only=True)
    n = 0
    try:
        roles = _roles_present(live, meta.get("roles") or [])
        for r in todo:
            cols = los.get("%s.%s" % (r["schema"], r["name"]))
            if not cols:
                continue
            try:
                oids = lo_referenced(ss, r["schema"], r["name"], cols, only_missing_in=live)
                n += copy_large_objects(ss, live, oids, roles)
            except EngineError as e:
                plan["warnings"].append("large objects referenced by %s.%s were not all restored: %s" % (r["schema"], r["name"], e.message[:200]))
    finally:
        ss.close()
    return n


FK_COLS = re.compile(r"FOREIGN KEY \((.+?)\) REFERENCES (?:[^(]+?)\((.+?)\)")


def _orphan_checks(live, plan, todo, sfx_new):
    """Rows that would point at nothing once the swap is done, counted while the recovered tables are still under their temporary names (nothing live has
    changed yet): live tables outside the selection referencing a restored table (inbound), and restored rows referencing a live table outside it (outbound)."""
    acting = {(r["schema"], r["name"]) for r in todo}
    out = []
    pairs = [("in", f, qi(f["schema"], f["table"]), qi(f["ref_schema"], _short(f["ref_table"], sfx_new))) for f in plan.get("inbound_fks") or []
             if (f["ref_schema"], f["ref_table"]) in acting]
    pairs += [("out", f, qi(f["schema"], _short(f["table"], sfx_new)), qi(f["ref_schema"], f["ref_table"])) for f in plan.get("outbound_fks") or []
              if (f["schema"], f["table"]) in acting]
    for direction, f, child, parent in pairs:
        m = FK_COLS.search(f.get("def") or "")
        if not m:
            continue
        kc = [x.strip() for x in m.group(1).split(",")]
        pc = [x.strip() for x in m.group(2).split(",")]
        if len(kc) != len(pc):
            continue
        try:
            n = int(live.scalar("SELECT count(*) FROM %s c WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)" % (
                child, " AND ".join("c.%s IS NOT NULL" % k for k in kc), parent, " AND ".join("p.%s = c.%s" % (a, b) for a, b in zip(pc, kc)))) or 0)
        except EngineError:
            continue
        if n:
            out.append({"direction": direction, "constraint": f["name"], "child": "%s.%s" % (f["schema"], f["table"]), "parent": "%s.%s" % (f["ref_schema"], f["ref_table"]),
                        "columns": m.group(1), "rows": n})
    return out


def promote(admin, stage_db, mode="replace", dry_run=False, progress=None, target_schema=None, journal=None, journal_info=None, allow_orphans=False):
    """Put the objects of a v2 quarantine database back into the live database it came from (same name, on `admin`'s server).

      replace      every recovered table takes the place of the live one, which is kept as <name>_old_<ts> (never dropped); foreign keys that pointed at the old table are
                   re-attached to the new one, views that depended on it are recreated, sequences never go backwards; a table that no longer exists simply comes back
      missing_only only what is missing now comes back; existing tables are left alone
      as_new       the recovered tables appear next to the originals as <name>_pitr_<ts>; nothing existing is touched and nothing is re-attached.
                   With target_schema they keep their own names inside that schema instead (created if missing; refused when a name is taken there)

    The data is first loaded under temporary names (phase 1: nothing live changes, the application keeps working); the swap itself (phase 2) is ONE transaction with a lock
    timeout, so it either happens completely or not at all. Returns None when `stage_db` is not a v2 stage (the caller then uses the old single-table path)."""
    if mode not in ("replace", "as_new", "missing_only"):
        raise EngineError("PGA-GEN-080", "mode must be replace, missing_only or as_new")
    if target_schema is not None:
        if mode != "as_new":
            raise EngineError("PGA-GEN-087", "a target schema is only possible with mode as_new")
        if not re.match(r"^[a-z_][a-z0-9_]{0,62}$", str(target_schema)) or str(target_schema).startswith("pg_") or target_schema in ("information_schema",):
            raise EngineError("PGA-GEN-087", "invalid target schema name %r (lowercase letters, digits and _; not pg_*)" % target_schema)
    stg = PgSession(admin.with_db(stage_db))
    try:
        meta = read_meta(stg)
        stage_cols = {}
        if meta and not meta.get("building"):
            for t in meta.get("tables") or []:
                stage_cols[(t["schema"], t["name"])] = _columns(stg, t["schema"], t["name"])
    finally:
        stg.close()
    if not meta:
        return None
    if meta.get("building"):
        raise EngineError("PGA-GEN-094", "the quarantine database %s is incomplete: the restore that was building it did not finish" % stage_db,
                          "drop it and restore the objects again")
    dbname = meta["database"]
    adm = PgSession(admin.with_db("postgres"), read_only=True)
    try:
        if adm.scalar("SELECT 1 FROM pg_database WHERE datname = %s" % sql_lit(dbname)) != "1":
            raise EngineError("PGA-GEN-086", "database '%s' does not exist on the destination server" % dbname,
                              "create it first, or restore the whole database with restore_database; the recovered objects are kept in %s" % stage_db)
    finally:
        adm.close()
    live = PgSession(admin.with_db(dbname))
    t0 = now_utc()
    for bump in range(120):                                   # two promotions in the same second must not meet: the suffix is the first free second
        ts = (t0 + datetime.timedelta(seconds=bump)).strftime("%Y%m%d%H%M%S")
        if not any(_exists(live, t["schema"], _short(t["name"], sfx)) for t in meta["tables"] for sfx in ("_pitr_" + ts, "_old_" + ts)):
            break
    sfx_new, sfx_old = "_pitr_" + ts, "_old_" + ts
    result = {"mode": mode, "database": dbname, "suffix": ts}
    created_tmp = []                                         # live objects created in phase 1 (dropped again if anything fails)
    created_seq = []
    try:
        plan = _live_plan(live, meta, mode, ts, stage_cols)
        if target_schema:
            names = [r["name"] for r in plan["tables"] if r["action"] != "skip"]
            dup = sorted(set(n for n in names if names.count(n) > 1))
            taken = [n for n in names if _exists(live, target_schema, n)]
            if dup or taken:
                raise EngineError("PGA-GEN-088", "cannot put the recovered tables in schema %s: %s" % (target_schema, ("names repeated across schemas: %s" % ", ".join(dup)) if dup else ("already there: %s" % ", ".join(taken[:5]))),
                                  "choose an empty or new schema, or restore one schema at a time")
            for r in plan["tables"]:
                if r["action"] != "skip":
                    r["new_name"] = r["name"]
                    r["target_schema"] = target_schema
            plan["target_schema"] = target_schema
        if dry_run:
            plan["dry_run"] = True
            return _slim(plan)
        if plan["blocking"]:
            raise EngineError("PGA-GEN-093", "promotion not started: %s" % "; ".join(plan["blocking"]), "nothing was changed; the recovered objects stay in %s" % stage_db)
        todo = [r for r in plan["tables"] if r["action"] != "skip"]
        # sequences selected alone or used by the tables' defaults: created when missing; an existing one is never replaced (other tables use it)
        # and never moves backwards (ids handed out since the target may be referenced elsewhere)
        seq_new = [x for x in meta.get("sequences") or [] if not _exists(live, x["schema"], x["name"])] if mode != "as_new" else []
        seq_live = [x for x in meta.get("sequences") or [] if x not in seq_new] if mode != "as_new" else []
        pos_of = {(x["schema"], x["name"]): x for x in meta.get("positions") or []}
        if not todo and not seq_new and not plan.get("recovered_views"):
            moved = _seq_forward(live, seq_live, pos_of)
            result.update(plan=_slim(plan), promoted=[], skipped=[("%s.%s" % (r["schema"], r["name"])) for r in plan["tables"]], sequences_advanced=moved,
                          note="nothing to do: every selected object exists already")
            return _compat(result)
        # ---- phase 0: additive prerequisites (schemas, extensions, types, functions): only what is missing
        if progress:
            progress({"phase": "prepare"})
        present = _roles_present(live, meta.get("roles") or [])
        created, problems = ensure_prereqs(live, meta, only_missing=True, roles_ok=present)
        result["prereq_created"] = created
        plan["warnings"] += ["prerequisite not recreated - %s" % x for x in problems]
        # ---- phase 1: load the recovered tables into the live database under temporary names
        if progress:
            progress({"phase": "transfer"})
        stage_conn = admin.with_db(stage_db)
        ss = PgSession(stage_conn)
        renamed = []                                          # (kind, schema, from, to) applied in the stage, reverted afterwards
        orig_of = {}                                          # (schema, temporary name) -> real name, for phase 2 (a shortened name cannot be derived back)
        tmp = tempfile.mkdtemp(prefix="pgarca-promote-")
        try:
            names = []
            for r in todo:
                sch, nm = r["schema"], r["name"]
                idx, seq = _idx_and_seqs(ss, sch, nm)
                nn = _short(nm, sfx_new)
                for i in idx:
                    ss.query("ALTER INDEX %s RENAME TO %s" % (qi(sch, i), quote_ident(_short(i, sfx_new))))
                    renamed.append(("INDEX", sch, _short(i, sfx_new), i))
                    orig_of[(sch, _short(i, sfx_new))] = i
                for ssch, sq in seq:
                    ss.query("ALTER SEQUENCE %s RENAME TO %s" % (qi(ssch, sq), quote_ident(_short(sq, sfx_new))))
                    renamed.append(("SEQUENCE", ssch, _short(sq, sfx_new), sq))
                    orig_of[(ssch, _short(sq, sfx_new))] = sq
                    names.append(qi(ssch, _short(sq, sfx_new)))
                ss.query("ALTER TABLE %s RENAME TO %s" % (qi(sch, nm), quote_ident(nn)))
                renamed.append(("TABLE", sch, nn, nm))
                names.append(qi(sch, nn))
            for sq in seq_new:                           # missing sequences come back under their own name (additive: nothing live has that name)
                names.append(qi(sq["schema"], sq["name"]))
            dumpfile = os.path.join(tmp, "p.dump")
            args = stage_conn.args() + ["-f", dumpfile, "-d", stage_db]
            for n in names:
                args += ["-t", n]
            rc, out, err = run_dump(stage_conn, args) if names else (0, "", "")
        finally:
            try:
                for kind, sch, cur, orig in reversed(renamed):                # leave the quarantine database exactly as we found it (it can be promoted again)
                    ss.query("ALTER %s %s RENAME TO %s" % (kind, qi(sch, cur), quote_ident(orig)))
            finally:
                ss.close()
        if rc != 0:
            raise EngineError("PGA-GEN-084", "pg_dump of the quarantine database failed: %s" % err.strip()[:600])
        args = admin.args() + ["-d", dbname, "--exit-on-error", "-1"]
        if plan["missing_roles"]:
            args += ["--no-owner", "--no-acl"]
        for r in todo:
            created_tmp.append((r["schema"], _short(r["name"], sfx_new)))
        created_seq = [(x["schema"], x["name"]) for x in seq_new]
        # on disk BEFORE anything is created live: if the agent dies from here on (restart, OOM, host reboot), the next operation finds exactly
        # these temporary tables and removes them - they would otherwise stay forever, looking like an 'as new' result
        _journal_write(journal, dict(journal_info or {}, database=dbname, stage=stage_db, mode=mode, suffix=sfx_new, tables=created_tmp, sequences=created_seq,
                                     started=now_utc().isoformat(timespec="seconds"), pid=os.getpid()))
        rc, out, err = run_tool(admin, "pg_restore", args + [dumpfile], timeout=None) if names else (0, "", "")
        if rc != 0:
            created_seq = []                                   # -1: the single transaction rolled back, nothing was created
            raise EngineError("PGA-GEN-071", "loading the recovered tables into %s failed: %s" % (dbname, (err.strip() or out.strip())[:900]), "nothing was changed in the live database")
        # verify what arrived (here, under the temporary names, nobody else writes: the counts are exact)
        loaded_oid = {}
        for r in todo:
            loaded_oid[(r["schema"], r["name"])] = live.scalar("SELECT %s::regclass::oid" % sql_lit(qi(r["schema"], _short(r["name"], sfx_new))))
        for r in todo:
            want = r["rows_at_target"]
            if want is None or r["kind"] == "p":
                continue
            got = int(live.scalar("SELECT count(*) FROM %s" % qi(r["schema"], _short(r["name"], sfx_new))))
            if got != want:
                raise EngineError("PGA-VRF-040", "verification failed for %s.%s: %d rows at target, %d loaded" % (r["schema"], r["name"], want, got), "nothing was changed in the live database")
        if mode == "as_new" and target_schema:
            # move the copies into their own schema under their own names (indexes, constraints and owned sequences follow ALTER TABLE ... SET SCHEMA),
            # one transaction: either every table is there with its real name, or nothing moved
            live.query("BEGIN")
            try:
                live.query("SET LOCAL lock_timeout = '10s'")
                live.query("CREATE SCHEMA IF NOT EXISTS %s" % quote_ident(target_schema))
                for r in todo:
                    tmpn = _short(r["name"], sfx_new)
                    seqs = [x[0] for x in live.query("SELECT s.relname FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S' WHERE d.refobjid = %s::regclass AND d.deptype IN ('a','i')" % sql_lit(qi(r["schema"], tmpn)))]
                    kids = [x[0] for x in live.query("SELECT c.relname FROM pg_inherits h JOIN pg_class c ON c.oid = h.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace "
                                                     "WHERE h.inhparent = %s::regclass AND n.nspname = %s" % (sql_lit(qi(r["schema"], tmpn)), sql_lit(r["schema"])))]
                    live.query("ALTER TABLE %s SET SCHEMA %s" % (qi(r["schema"], tmpn), quote_ident(target_schema)))
                    for k in kids:                                        # partitions follow their parent into the new schema (SET SCHEMA moves only the parent)
                        live.query("ALTER TABLE %s SET SCHEMA %s" % (qi(r["schema"], k), quote_ident(target_schema)))
                    live.query("ALTER TABLE %s RENAME TO %s" % (qi(target_schema, tmpn), quote_ident(r["name"])))
                    for (idx,) in live.query("SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = %s::regclass" % sql_lit(qi(target_schema, r["name"]))):
                        orig = orig_of.get((r["schema"], idx))
                        if orig and orig != idx:
                            live.query("ALTER INDEX %s RENAME TO %s" % (qi(target_schema, idx), quote_ident(orig)))
                    for sq in seqs:
                        orig = orig_of.get((r["schema"], sq))
                        if orig and orig != sq:
                            live.query("ALTER SEQUENCE %s RENAME TO %s" % (qi(target_schema, sq), quote_ident(orig)))
                live.query("COMMIT")
            except BaseException:
                try:
                    live.query("ROLLBACK")
                except EngineError:
                    pass
                raise
            result.update(plan=_slim(plan), promoted=["%s.%s" % (target_schema, r["name"]) for r in todo], old_kept_as=[], target_schema=target_schema,
                          note="the recovered tables are in schema %s with their own names; the originals are untouched and nothing was re-attached" % target_schema)
            created_tmp = []
            _journal_done(journal)
            result["large_objects_restored"] = _promote_lobs(admin, stage_db, live, meta, todo, plan)
            return _compat(result)
        if mode == "as_new":
            result.update(plan=_slim(plan), promoted=["%s.%s" % (r["schema"], r["new_name"]) for r in todo], old_kept_as=[], note="the recovered tables sit next to the originals; nothing was re-attached")
            created_tmp = []
            _journal_done(journal)
            result["large_objects_restored"] = _promote_lobs(admin, stage_db, live, meta, todo, plan)
            return _compat(result)
        # ---- before the swap: rows that would be left pointing at nothing (the database would keep a foreign key it no longer honours). Nothing live has
        # changed yet, so refusing here costs nothing; the way out is said
        orph = _orphan_checks(live, plan, todo, sfx_new)
        if orph:
            result["orphans"] = orph
            if not allow_orphans:
                desc = "; ".join("%d %s of %s (%s) would reference %s rows that %s" % (o["rows"], "row" if o["rows"] == 1 else "rows", o["child"], o["columns"], o["parent"],
                                 "are not in the restored copy" if o["direction"] == "in" else "no longer exist") for o in orph[:6])
                raise EngineError("PGA-GEN-096", "promotion not done, nothing was changed: %s" % desc,
                                  "restore the related tables too (same instant), or put the recovered tables next to the originals (as new) and recover rows; "
                                  "allow_orphans=true goes ahead and leaves those foreign keys NOT VALID")
            plan["warnings"].append("orphaned rows accepted: " + "; ".join("%d %s of %s point to %s rows that no longer exist (the foreign key stays NOT VALID, i.e. not enforced, until you fix them)" % (o["rows"], "row" if o["rows"] == 1 else "rows", o["child"], o["parent"]) for o in orph))
        # ---- phase 2: the swap, atomically
        if progress:
            progress({"phase": "swap"})
        validate_later = []
        swapped = [r for r in todo if r["action"] == "swap"]
        old_seq_pos = {}
        live.query("BEGIN")
        try:
            live.query("SET LOCAL lock_timeout = '20s'")
            for v in reversed(plan["live_views"]):
                live.query("DROP %s %s" % ("MATERIALIZED VIEW" if v["kind"] == "m" else "VIEW", qi(v["schema"], v["name"])))
            for f in plan["inbound_fks"]:
                if f.get("source") == "live":
                    live.query("ALTER TABLE %s DROP CONSTRAINT %s" % (qi(f["schema"], f["table"]), quote_ident(f["name"])))
            for f in plan.get("old_outbound_fks") or []:
                live.query("ALTER TABLE %s DROP CONSTRAINT %s" % (qi(f["schema"], f["table"]), quote_ident(f["name"])))     # the kept copy must not pin rows of other tables
            for x in plan.get("foreign_rules") or []:
                live.query("DROP RULE %s ON %s" % (quote_ident(x["name"]), qi(x["schema"], x["table"])))
            for x in plan.get("foreign_policies") or []:
                live.query("DROP POLICY %s ON %s" % (quote_ident(x["name"]), qi(x["schema"], x["table"])))
            for x in plan.get("foreign_triggers") or []:
                live.query("DROP TRIGGER %s ON %s" % (quote_ident(x["name"]), qi(x["schema"], x["table"])))
            for a in plan["attach"]:                          # the live table leaves its parent first (it is kept, standalone, as <name>_old_<ts>)
                if a.get("detach_old"):
                    if a["part"]:
                        live.query("ALTER TABLE %s DETACH PARTITION %s" % (qi(a["parent_schema"], a["parent"]), qi(a["schema"], a["name"])))
                    else:
                        live.query("ALTER TABLE %s NO INHERIT %s" % (qi(a["schema"], a["name"]), qi(a["parent_schema"], a["parent"])))
            for r in swapped:
                for (sn, stn) in live.query("SELECT n.nspname, s.stxname FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace WHERE s.stxrelid = %s::regclass"
                                            % sql_lit(qi(r["schema"], r["name"]))):
                    live.query("ALTER STATISTICS %s RENAME TO %s" % (qi(sn, stn), quote_ident(_short(stn, sfx_old))))   # the kept copy keeps its statistics, renamed
            for r in swapped:
                sch, nm = r["schema"], r["name"]
                idx, seq = _idx_and_seqs(live, sch, nm)
                for ssch, sq in seq:
                    row = live.query("SELECT last_value, is_called FROM %s" % qi(ssch, sq))
                    if row and row[0]:
                        old_seq_pos[(sch, nm, sq)] = (int(row[0][0]), row[0][1] == "t")
                live.query("ALTER TABLE %s RENAME TO %s" % (qi(sch, nm), quote_ident(r["old_kept_as"])))
                for i in idx:
                    live.query("ALTER INDEX %s RENAME TO %s" % (qi(sch, i), quote_ident(_short(i, sfx_old))))
                for ssch, sq in seq:
                    live.query("ALTER SEQUENCE %s RENAME TO %s" % (qi(ssch, sq), quote_ident(_short(sq, sfx_old))))
            for r in todo:
                sch, nm = r["schema"], r["name"]
                tmpn = _short(nm, sfx_new)
                idx, seq = _idx_and_seqs(live, sch, tmpn)
                for i in idx:
                    orig = orig_of.get((sch, i)) or (i[:len(i) - len(sfx_new)] if i.endswith(sfx_new) else i)
                    live.query("ALTER INDEX %s RENAME TO %s" % (qi(sch, i), quote_ident(orig)))
                for ssch, sq in seq:
                    orig = orig_of.get((ssch, sq)) or (sq[:len(sq) - len(sfx_new)] if sq.endswith(sfx_new) else sq)
                    live.query("ALTER SEQUENCE %s RENAME TO %s" % (qi(ssch, sq), quote_ident(orig)))
                live.query("ALTER TABLE %s RENAME TO %s" % (qi(sch, tmpn), quote_ident(nm)))
            for f in [x for x in plan.get("rowtype_funcs") or [] if x.get("def")]:
                # the old function now takes/returns the OLD copy's type. Its text (taken before the swap) names the type by name, which is now the recovered
                # table's. Same signature (only the result uses the type): drop then create. Other signature: create, then drop the old one if nothing uses it
                live.query("SAVEPOINT pgarca_rf")
                try:
                    old_sig = live.scalar("SELECT %d::regprocedure::text" % f["oid"])
                    kw = "PROCEDURE" if f["kind"] == "p" else "FUNCTION"
                    if not f["in_args"]:
                        live.query("DROP %s %s" % (kw, old_sig))
                    live.query(f["def"])
                    new_sig = f["sig"]                       # taken before the swap: the type name in it is now the recovered table's
                    if f.get("owner") and f["owner"] in _roles_present(live, [f["owner"]]):
                        live.query("ALTER %s %s OWNER TO %s" % (kw, new_sig, quote_ident(f["owner"])))
                    if not f.get("acl_null"):
                        live.query("REVOKE ALL ON %s %s FROM PUBLIC" % (kw, new_sig))
                        for g in _acl_stmts(kw, new_sig, [a for a in (f.get("acl") or []) if a["g"] == "PUBLIC" or a["g"] in _roles_present(live, [a["g"]])]):
                            live.query(g)
                    if f.get("comment"):
                        live.query("COMMENT ON %s %s IS %s" % (kw, new_sig, sql_lit(f["comment"])))
                    if f["in_args"]:
                        live.query("SAVEPOINT pgarca_rf_old")
                        try:
                            live.query("DROP %s %s" % (kw, old_sig))
                            live.query("RELEASE SAVEPOINT pgarca_rf_old")
                        except EngineError:
                            live.query("ROLLBACK TO SAVEPOINT pgarca_rf_old")
                            plan["warnings"].append("%s recreated for the recovered table; the old version (%s) is still used by other objects and was kept" % (f["sig"], old_sig))
                    live.query("RELEASE SAVEPOINT pgarca_rf")
                    plan.setdefault("rowtype_funcs_rebound", []).append(f["sig"])
                except EngineError as e:
                    live.query("ROLLBACK TO SAVEPOINT pgarca_rf")
                    plan["warnings"].append("%s uses the row type of a replaced table and was NOT recreated (%s): it stays bound to the old copy" % (f["sig"], e.message[:200]))
            for f in plan.get("body_funcs") or []:
                live.query("SAVEPOINT pgarca_bf")
                try:
                    live.query(f["def"])
                    live.query("RELEASE SAVEPOINT pgarca_bf")
                    plan.setdefault("rowtype_funcs_rebound", []).append(f["sig"])
                except EngineError as e:
                    live.query("ROLLBACK TO SAVEPOINT pgarca_bf")
                    plan["warnings"].append("%s (SQL-standard body) could NOT be re-pointed at the recovered table (%s): it still reads/writes the OLD copy - "
                                            "recreate it by hand" % (f["sig"], e.message[:200]))
            for x in plan.get("foreign_defaults") or []:    # same text, now resolved against the recovered table's sequence
                live.query("ALTER TABLE %s ALTER COLUMN %s SET DEFAULT %s" % (qi(x["schema"], x["table"]), quote_ident(x["column"]), x["expr"]))
            for x in plan.get("foreign_rules") or []:       # same text, now resolved against the recovered table
                live.query(x["def"].rstrip().rstrip(";"))
            for x in plan.get("foreign_triggers") or []:
                live.query(x["def"])
                if x.get("enabled") in ("D", "R", "A"):
                    live.query("ALTER TABLE %s %s TRIGGER %s" % (qi(x["schema"], x["table"]), {"D": "DISABLE", "R": "ENABLE REPLICA", "A": "ENABLE ALWAYS"}[x["enabled"]], quote_ident(x["name"])))
            for x in plan.get("foreign_policies") or []:
                cmd = {"r": "SELECT", "a": "INSERT", "w": "UPDATE", "d": "DELETE"}.get(x["cmd"], "ALL")
                roles = ", ".join("PUBLIC" if r == "PUBLIC" else quote_ident(r) for r in (x.get("roles") or ["PUBLIC"]))
                live.query("CREATE POLICY %s ON %s AS %s FOR %s TO %s%s%s" % (quote_ident(x["name"]), qi(x["schema"], x["table"]), "PERMISSIVE" if x.get("permissive", True) else "RESTRICTIVE",
                                                                            cmd, roles, (" USING (%s)" % x["qual"]) if x.get("qual") else "",
                                                                            (" WITH CHECK (%s)" % x["check"]) if x.get("check") else ""))
            for pb in plan.get("publications") or []:       # the recovered table takes the old one's place in the publication (same filter / columns)
                r_old = next((r for r in swapped if r["schema"] == pb["schema"] and r["name"] == pb["table"]), None)
                if not r_old:
                    continue
                live.query("ALTER PUBLICATION %s DROP TABLE %s" % (quote_ident(pb["pub"]), qi(pb["schema"], r_old["old_kept_as"])))
                live.query("ALTER PUBLICATION %s ADD TABLE %s%s%s" % (quote_ident(pb["pub"]), qi(pb["schema"], pb["table"]),
                                                                       (" (%s)" % ", ".join(quote_ident(c) for c in pb["cols"])) if pb.get("cols") else "",
                                                                       (" WHERE (%s)" % pb["qual"]) if pb.get("qual") else ""))
            for a in plan["attach"]:                          # failing here undoes the whole swap (e.g. another partition now covers the same values)
                try:
                    if a["part"]:
                        live.query("ALTER TABLE %s ATTACH PARTITION %s %s" % (qi(a["parent_schema"], a["parent"]), qi(a["schema"], a["name"]), a["bound"]))
                    else:
                        live.query("ALTER TABLE %s INHERIT %s" % (qi(a["schema"], a["name"]), qi(a["parent_schema"], a["parent"])))
                except EngineError as e:
                    raise EngineError(e.code, "%s.%s cannot be attached to %s.%s again: %s" % (a["schema"], a["name"], a["parent_schema"], a["parent"], e.message[:300]))
            for x in plan["statistics"]:                      # extended statistics (pg_dump -t does not carry them)
                live.query("SAVEPOINT pgarca_st")
                try:
                    if live.scalar("SELECT 1 FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace WHERE n.nspname = %s AND s.stxname = %s" % (sql_lit(x["schema"]), sql_lit(x["name"]))) != "1":
                        live.query(x["def"])
                        if x.get("target") is not None and int(x["target"]) >= 0:
                            live.query("ALTER STATISTICS %s SET STATISTICS %d" % (qi(x["schema"], x["name"]), int(x["target"])))
                        if x.get("owner") and x["owner"] in _roles_present(live, [x["owner"]]):
                            live.query("ALTER STATISTICS %s OWNER TO %s" % (qi(x["schema"], x["name"]), quote_ident(x["owner"])))
                        if x.get("comment"):
                            live.query("COMMENT ON STATISTICS %s IS %s" % (qi(x["schema"], x["name"]), sql_lit(x["comment"])))
                    live.query("RELEASE SAVEPOINT pgarca_st")
                except EngineError as e:
                    live.query("ROLLBACK TO SAVEPOINT pgarca_st")
                    plan["warnings"].append("statistics object %s.%s was not recreated: %s" % (x["schema"], x["name"], e.message[:160]))
            for r in todo:                                    # sequences never go backwards: ids handed out after the target may already be referenced elsewhere
                idx, seq = _idx_and_seqs(live, r["schema"], r["name"])
                for ssch, sq in seq:
                    rec = live.query("SELECT last_value, is_called FROM %s" % qi(ssch, sq))
                    cur = (int(rec[0][0]), rec[0][1] == "t") if rec and rec[0] else None
                    old = old_seq_pos.get((r["schema"], r["name"], sq))
                    best = max([p for p in (cur, old) if p], key=lambda p: (p[0], p[1])) if (cur or old) else None
                    if best and best != cur:
                        live.query("SELECT setval(%s, %d, %s)" % (sql_lit(qi(ssch, sq)), best[0], "true" if best[1] else "false"))
            for f in plan["inbound_fks"] + plan["outbound_fks"]:
                live.query("SAVEPOINT pgarca_fk")
                try:
                    _add_fk(live, f, validate_later)
                    live.query("RELEASE SAVEPOINT pgarca_fk")
                except EngineError as e:
                    live.query("ROLLBACK TO SAVEPOINT pgarca_fk")
                    plan["warnings"].append("foreign key %s on %s.%s could not be re-attached: %s" % (f["name"], f["schema"], f["table"], e.message[:160]))
            roles_ok = _roles_present(live, meta.get("roles") or []) | _roles_present(live, [v.get("owner") for v in plan["live_views"] if v.get("owner")])
            for v in plan["live_views"]:                      # live views must come back exactly as they were: failing here undoes the whole swap
                _recreate_view(live, v, roles_ok)
            for v in sorted(plan["recovered_views"], key=lambda x: x.get("order", 0)):
                live.query("SAVEPOINT pgarca_v")
                try:
                    _recreate_view(live, v, roles_ok)
                    live.query("RELEASE SAVEPOINT pgarca_v")
                except EngineError as e:
                    live.query("ROLLBACK TO SAVEPOINT pgarca_v")
                    plan["warnings"].append("view %s.%s was not recreated: %s" % (v["schema"], v["name"], e.message[:160]))
            live.query("COMMIT")
        except BaseException as e:
            try:
                live.query("ROLLBACK")
            except Exception:
                pass
            if isinstance(e, EngineError):
                raise EngineError("PGA-GEN-088", "the swap was not applied (rolled back, nothing changed): %s" % e.message[:500],
                                  "the recovered tables stay in %s; fix the cause and promote again" % stage_db)
            raise
        created_tmp, created_seq = [], []
        _journal_done(journal)                               # the swap committed: the temporary names are gone
        lo_n = _promote_lobs(admin, stage_db, live, meta, todo, plan)
        moved = _seq_forward(live, seq_live, pos_of)
        # ---- after the swap: validate the re-attached keys, refresh statistics, verify
        invalid = []
        # the swap is committed: what follows is housekeeping and must not hang behind the application (a DDL of theirs, an anti-wraparound
        # vacuum, which is not cancelled for us): bounded waits, a step that cannot get its lock is reported, never waited for forever
        live.query("SET lock_timeout = '30s'")
        for f in validate_later:
            try:
                live.query("ALTER TABLE %s VALIDATE CONSTRAINT %s" % (qi(f["schema"], f["table"]), quote_ident(f["name"])))
            except EngineError as e:
                invalid.append("%s on %s.%s (%s)" % (f["name"], f["schema"], f["table"], e.message[:120]))
        if invalid:
            plan["warnings"].append("foreign keys re-attached but NOT validated (rows that do not match the restored table, or the table stayed locked by "
                                    "another session; VALIDATE CONSTRAINT can be run later): " + "; ".join(invalid))
        for r in todo:
            try:
                live.query("ANALYZE %s" % qi(r["schema"], r["name"]))
            except EngineError:
                pass                                         # statistics come with the next autovacuum
        live.query("SET lock_timeout = 0")
        # after the swap: each name must now be the very table that was loaded and counted above. Counting rows again here was wrong: the
        # applications write into the restored table from the moment of the commit, and a busy table failed the check of a swap that had
        # succeeded (and was committed) - found by the fault suite with an application writing during the promotion
        bad = []
        for r in todo:
            want = loaded_oid.get((r["schema"], r["name"]))
            got = live.scalar("SELECT to_regclass(%s)::oid" % sql_lit(qi(r["schema"], r["name"])))
            if want and got != want:
                bad.append("%s.%s is not the restored table (oid %s, expected %s)" % (r["schema"], r["name"], got or "none", want))
        if bad:
            raise EngineError("PGA-VRF-040", "verification after the swap failed: %s" % "; ".join(bad))
        result.update(plan=_slim(plan), promoted=["%s.%s" % (r["schema"], r["name"]) for r in todo],
                      old_kept_as=["%s.%s" % (r["schema"], r["old_kept_as"]) for r in swapped],
                      skipped=["%s.%s" % (r["schema"], r["name"]) for r in plan["tables"] if r["action"] == "skip"],
                      foreign_keys_reattached=len(validate_later) - len(invalid), foreign_keys_unvalidated=len(invalid),
                      attached=["%s.%s -> %s.%s" % (a["schema"], a["name"], a["parent_schema"], a["parent"]) for a in plan["attach"]],
                      publications_moved=["%s: %s.%s" % (pb["pub"], pb["schema"], pb["table"]) for pb in plan.get("publications") or []],
                      rules_and_policies_rebound=["%s.%s.%s" % (x["schema"], x["table"], x["name"]) for x in (plan.get("foreign_rules") or []) + (plan.get("foreign_policies") or []) + (plan.get("foreign_triggers") or [])],
                      defaults_rebound=["%s.%s.%s" % (x["schema"], x["table"], x["column"]) for x in plan.get("foreign_defaults") or []],
                      functions_rebound=plan.get("rowtype_funcs_rebound") or [], large_objects_restored=lo_n,
                      views_recreated=len(plan["live_views"]) + len([v for v in plan["recovered_views"] if not any(w.startswith("view %s.%s " % (v["schema"], v["name"])) for w in plan["warnings"])]),
                      sequences_created=["%s.%s" % (x["schema"], x["name"]) for x in seq_new], sequences_advanced=moved)
        if any(v.get("kind") == "m" for v in plan["recovered_views"]):
            result["note"] = "materialized views were recreated from the CURRENT data of their tables (their content is derived, not restored)"
        return _compat(result)
    finally:
        if created_tmp:                                      # phase 1 left temporary tables behind and the swap did not happen: remove them
            try:
                for sch, nm in created_tmp:
                    live.query("DROP TABLE IF EXISTS %s CASCADE" % qi(sch, nm))
                if not created_seq:
                    _journal_done(journal)
            except Exception:
                pass
        if created_seq:                                      # sequences created in phase 1 for a swap that did not happen
            for sch, nm in created_seq:
                try:
                    live.query("DROP SEQUENCE IF EXISTS %s" % qi(sch, nm))
                except Exception:
                    pass
            _journal_done(journal)
        live.close()
