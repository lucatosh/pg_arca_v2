#!/usr/bin/env python3
"""Lab: end-to-end restore scenarios on arca_restore_lab, driven through the console API exactly like the web tool does
(create data -> backup -> damage the LATEST data -> restore to just before the damage -> compare with the original, table by table).

  database : DROP DATABASE                    -> restore_database (side database)
  schema   : DROP SCHEMA hr CASCADE           -> restore_database (side db), then the schema is compared (schema-level restore = object restore v2)
  table    : DELETE rows + DROP TABLE         -> restore_object + restore_promote (replace)
Run on the VM (docker access + tools/lab/.env):   python3 tools/lab/scenario-restore.py [database|schema|table|tabledeps|dropcascade|modes|all]"""
import http.cookiejar, json, os, subprocess, sys, time, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("PG_ARCA_URL", "http://localhost:3000")
U = os.environ.get("ARCA_USER", "claude-test"); P = os.environ.get("ARCA_PASS", "claude-lab-test-pass-1")
DB = "arca_restore_lab"
jar = http.cookiejar.CookieJar(); opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(m, path, body=None, hdr=None):
    r = urllib.request.Request(BASE + path, method=m, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json", **(hdr or {})})
    try:
        with opener.open(r, timeout=60) as x: return x.status, json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e:
        t = e.read()
        try: return e.code, json.loads(t)
        except Exception: return e.code, {"raw": t[:300].decode(errors="replace")}


call("POST", "/api/auth/login", {"username": U, "password": P})
s, d = call("GET", "/api/clusters")
CL = [c for c in d["clusters"] if "arca-lab" in c["name"].lower()][0]["id"]


def op(typ, params, wait=900):
    s, d = call("POST", "/api/clusters/%s/operations" % CL, {"type": typ, "params": params}, {"Idempotency-Key": str(uuid.uuid4())})
    if s >= 300 or "operation" not in d: raise SystemExit("HTTP %s %s" % (s, json.dumps(d)[:400]))
    o = d["operation"]; t0 = time.time()
    while o["status"] not in ("succeeded", "failed", "cancelled", "canceled", "expired", "rejected") and time.time() - t0 < wait:
        time.sleep(2); s, d = call("GET", "/api/operations/" + o["id"]); o = d.get("operation", d)
    return o


def leader():
    out = subprocess.check_output("cd %s && set -a && . ./.env && set +a && docker exec pg1 patronictl -c /etc/patroni.yml list -f json" % HERE, shell=True)
    return [m["Member"] for m in json.loads(out) if m["Role"] == "Leader"][0]


def sql(db, q):
    env = subprocess.check_output("cd %s && set -a && . ./.env && set +a && echo $PG_SUPER_PASSWORD" % HERE, shell=True).decode().strip()
    r = subprocess.run(["docker", "exec", "-e", "PGPASSWORD=" + env, leader(), "psql", "-X", "-h", "localhost", "-U", "postgres", "-d", db, "-Atc", q], capture_output=True, text=True)
    if r.returncode: raise RuntimeError(r.stderr.strip()[:300])
    return r.stdout.strip()


def fp(db, schema, table):
    try: return sql(db, "SELECT count(*) || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '-') FROM %s.%s t" % (schema, table))
    except RuntimeError as e: return "MISSING"


def tables(db, schema=None):
    q = "SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname IN ('shop','hr')"
    if schema: q += " AND n.nspname='%s'" % schema
    return sorted(sql(db, q).split())


RES = []
def check(scn, what, ok, detail=""):
    RES.append((scn, what, ok, detail)); print("   %s %s %s" % ("PASS" if ok else "FAIL", what, detail), flush=True)


def fresh():
    subprocess.run([os.path.join(HERE, "testdb.sh"), "lab"], capture_output=True, check=True)
    base = {t: fp(DB, *t.split(".")) for t in tables(DB)}
    o = op("backup_run", {"type": "incr"}); assert o["status"] == "succeeded", o.get("error")
    time.sleep(2); t_ok = sql("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US')||'+00'"); time.sleep(2)
    return base, t_ok


def damage_done():
    sql("postgres", "SELECT pg_switch_wal()"); time.sleep(8)       # the damage must be archived: the restore is to a point BEFORE it


def compare(scn, base, db, names):
    for t in names:
        a, b = base[t], fp(db, *t.split("."))
        check(scn, "%s identical to the original" % t, a == b, "" if a == b else "(%s vs %s)" % (a[:12], b[:12]))


def sc_database():
    print("== DATABASE: drop the whole database, restore it to just before"); base, t_ok = fresh()
    sql("postgres", "DROP DATABASE %s WITH (FORCE)" % DB); damage_done()
    check("database", "damage in place (database gone)", sql("postgres", "SELECT count(*) FROM pg_database WHERE datname='%s'" % DB) == "0")
    o = op("restore_database", {"database": DB, "new_name": "arca_rl_s1", "target_time": t_ok}); check("database", "restore_database succeeded", o["status"] == "succeeded", str(o.get("error") or ""))
    if o["status"] == "succeeded": compare("database", base, "arca_rl_s1", sorted(base))
    sql("postgres", "DROP DATABASE IF EXISTS arca_rl_s1 WITH (FORCE)")


def sc_schema():
    print("== SCHEMA: DROP SCHEMA hr CASCADE, bring the whole schema back into the live database (object restore v2)"); base, t_ok = fresh(); TOK[0] = t_ok
    sql(DB, "DROP SCHEMA hr CASCADE"); damage_done()
    check("schema", "damage in place (schema hr gone)", sql(DB, "SELECT count(*) FROM pg_namespace WHERE nspname='hr'") == "0")
    promote_many("schema", ["%s.hr" % DB], "pgarca_stage_s2", "replace")
    compare("schema", base, DB, [t for t in sorted(base) if t.startswith("hr.")])
    check("schema", "views of hr are back", sql(DB, "SELECT count(*) FROM pg_views WHERE schemaname='hr'") == "2")
    check("schema", "cross-schema foreign key hr.projects -> shop.customers enforced", sql(DB, "SELECT count(*) FROM pg_constraint WHERE conrelid='hr.projects'::regclass AND confrelid='shop.customers'::regclass") == "1")


def promote(scn, obj, stage, mode="replace"):
    o = op("restore_object", {"object": obj, "stage_db": stage, "target_time": TOK[0]}); check(scn, "restore_object %s" % obj, o["status"] == "succeeded", str(o.get("error") or ""))
    if o["status"] != "succeeded": return None
    o = op("restore_promote", {"stage_db": stage, "object": obj, "mode": mode}); check(scn, "restore_promote %s (%s)" % (obj, mode), o["status"] == "succeeded", str(o.get("error") or ""))
    return o.get("result")


TOK = [None]


def sc_table():
    print("== TABLE: drop hr.timesheets, delete the latest rows of shop.order_items; both are brought back to their own schema"); base, t_ok = fresh(); TOK[0] = t_ok
    sql(DB, "DROP TABLE hr.timesheets"); sql(DB, "DELETE FROM shop.order_items WHERE order_id > 60"); damage_done()
    check("table", "damage in place", fp(DB, "shop", "order_items") != base["shop.order_items"] and fp(DB, "hr", "timesheets") == "MISSING")
    r1 = promote("table", "%s.hr.timesheets" % DB, "pgarca_stage_s3a")
    r2 = promote("table", "%s.shop.order_items" % DB, "pgarca_stage_s3b")
    compare("table", base, DB, ["shop.order_items", "hr.timesheets"])
    check("table", "timesheets came back as hr.timesheets (own schema, own name)", bool(r1) and r1.get("promoted_as") == "hr.timesheets", str((r1 or {}).get("promoted_as")))
    check("table", "order_items stayed in schema shop", bool(r2) and (r2.get("promoted_as") or "").startswith("shop.order_items"), str((r2 or {}).get("promoted_as")))


def promote_many(scn, objs, stage, mode="replace"):
    o = op("restore_object", {"object": objs[0], "objects": objs, "stage_db": stage, "target_time": TOK[0]}); check(scn, "restore_object %s" % ", ".join(x.split(".", 1)[1] for x in objs), o["status"] == "succeeded", str(o.get("error") or ""))
    if o["status"] != "succeeded": return None
    d = op("restore_promote", {"stage_db": stage, "mode": mode, "dry_run": True}); check(scn, "promotion dry-run gives a plan", d["status"] == "succeeded" and bool((d.get("result") or {}).get("tables")), str(d.get("error") or ""))
    o = op("restore_promote", {"stage_db": stage, "mode": mode}); check(scn, "restore_promote (%s)" % mode, o["status"] == "succeeded", str(o.get("error") or ""))
    return o.get("result")


def sc_table_deps():
    print("== TABLES WITH DEPENDENCIES: TRUNCATE shop.orders CASCADE (order_items, payments emptied too), restore the three together"); base, t_ok = fresh(); TOK[0] = t_ok
    fk0 = sql(DB, "SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='shop.orders'::regclass")
    sql(DB, "TRUNCATE shop.orders CASCADE"); damage_done()
    promote_many("tabledeps", ["%s.shop.orders" % DB, "%s.shop.order_items" % DB, "%s.shop.payments" % DB], "pgarca_stage_s4", "replace")
    compare("tabledeps", base, DB, ["shop.orders", "shop.order_items", "shop.payments"])
    fk = sql(DB, "SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='shop.orders'::regclass")
    check("tabledeps", "foreign keys pointing to shop.orders are intact", fk == fk0, "(before: %s, now: %s)" % (fk0, fk))
    check("tabledeps", "views and materialized view over orders still work", sql(DB, "SELECT count(*) FROM shop.v_order_totals") == "100" and int(sql(DB, "SELECT count(*) FROM shop.mv_sales_by_country")) > 0)


def sc_drop_cascade():
    print("== DROP TABLE shop.orders CASCADE: foreign keys, views and the materialized view disappear with it; one table restore brings them back"); base, t_ok = fresh(); TOK[0] = t_ok
    fk0 = sql(DB, "SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='shop.orders'::regclass")
    sql(DB, "DROP TABLE shop.orders CASCADE"); damage_done()
    promote_many("dropcascade", ["%s.shop.orders" % DB], "pgarca_stage_s5", "replace")
    compare("dropcascade", base, DB, ["shop.orders"])
    fk = sql(DB, "SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='shop.orders'::regclass")
    check("dropcascade", "inbound foreign keys re-attached", fk == fk0, "(before: %s, now: %s)" % (fk0, fk))
    check("dropcascade", "v_order_totals and mv_sales_by_country are back", sql(DB, "SELECT count(*) FROM pg_class WHERE relname IN ('v_order_totals','mv_sales_by_country') AND relnamespace='shop'::regnamespace") == "2")
    check("dropcascade", "trigger orders_touch is back", sql(DB, "SELECT count(*) FROM pg_trigger WHERE tgname='orders_touch' AND NOT tgisinternal") == "1")


def sc_modes():
    print("== MODES: as_new leaves the original alone; missing_only restores only what is gone"); base, t_ok = fresh(); TOK[0] = t_ok
    sql(DB, "UPDATE shop.customers SET full_name='live edit' WHERE id=1"); sql(DB, "DROP TABLE hr.timesheets"); sql(DB, "INSERT INTO hr.departments (name, budget) VALUES ('after backup', 1)"); damage_done()
    promote_many("modes", ["%s.shop.customers" % DB], "pgarca_stage_s6", "as_new")
    check("modes", "as_new: original untouched", sql(DB, "SELECT full_name FROM shop.customers WHERE id=1") == "live edit")
    check("modes", "as_new: a customers_pitr_<ts> copy sits in schema shop with the old value", sql(DB, "SELECT count(*) FROM pg_tables WHERE schemaname='shop' AND tablename LIKE 'customers\\_pitr\\_%'") == "1")
    promote_many("modes", ["%s.hr" % DB], "pgarca_stage_s7", "missing_only")
    check("modes", "missing_only: timesheets is back", fp(DB, "hr", "timesheets") == base["hr.timesheets"])
    check("modes", "missing_only: existing tables keep today's data", sql(DB, "SELECT count(*) FROM hr.departments WHERE name='after backup'") == "1")


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    for name, fn in (("database", sc_database), ("schema", sc_schema), ("table", sc_table), ("tabledeps", sc_table_deps), ("dropcascade", sc_drop_cascade), ("modes", sc_modes)):
        if which in ("all", name):
            try: fn()
            except Exception as e: check(name, "scenario ran", False, repr(e)[:300])
    print("\n== SUMMARY"); bad = [r for r in RES if not r[2]]
    for r in RES: print("%-9s %s %s" % (r[0], "PASS" if r[2] else "FAIL", r[1]))
    print("%d/%d checks passed" % (len(RES) - len(bad), len(RES))); sys.exit(1 if bad else 0)
