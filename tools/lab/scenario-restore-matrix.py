#!/usr/bin/env python3
"""Lab: every restore function, on every real cluster of the lab, driven through the console API exactly like the web tool does.

For each cluster (Patroni PG16, standalone PG15 with an unusual layout, PG14, Patroni PG18, the Rocky/RHEL Patroni pair, a geo primary site):
  setup     database arca_rs: customers <- orders (FK), a partitioned table, a view, a sequence, a large object, an UNLOGGED table
            full backup -> changes -> incremental backup -> changes -> named restore point RP (+ time T1) -> state S1 recorded
  damage    mass DELETE on orders, UPDATE on customers, DROP of the partitioned table
  then each restore function, each result compared table by table with S1 (count + md5 of every row):
    plan       restore_plan for a database at RP                         -> pre-flight ok, chain found
    db_lsn     restore_database to a new name at RP (LSN target)           -> S1
    db_time    restore_database to a new name at T1 (time target)         -> S1
    rows       wal_forensics finds the mass DELETE -> restore_object finish=rows_all just before it -> orders = S1
    table      restore_object of the dropped partitioned table, finish=promote missing_only -> = S1
    inplace    restore_database replace_original at RP                     -> arca_rs = S1, previous kept as arca_rs_before_*
    dropped    DROP DATABASE arca_rs -> restore_database (latest)          -> back under its own name, = S1 (stops before the DROP)
    copy       restore_instance as a paused copy at RP, queried on its socket -> = S1, then dropped
    beyond     restore_database to a time in the future                    -> recovers to the end of the archive and says so
    drill      restore_drill                                               -> succeeds, measures the time
usage (VM):  sg docker -c "python3 tools/lab/scenario-restore-matrix.py [cluster-name-filter ...]"     results: /tmp/rs-matrix.json
"""
import http.cookiejar, json, os, subprocess, sys, time, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get("PG_ARCA_URL", "http://localhost:3000")
U = os.environ.get("ARCA_USER", "claude-test"); P = os.environ.get("ARCA_PASS", "claude-lab-test-pass-1")
DB = "arca_rs"
jar = http.cookiejar.CookieJar(); opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
DEFAULT = ["arca-lab", "pg-solo1", "pg-s14", "vers18", "hy-rm", "geo-dc2"]
SUPERPW = ""
try:
    SUPERPW = subprocess.check_output("cd %s && set -a && . ./.env && set +a && echo $PG_SUPER_PASSWORD" % HERE, shell=True).decode().strip()
except Exception:
    pass


def call(m, path, body=None, hdr=None):
    r = urllib.request.Request(BASE + path, method=m, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json", **(hdr or {})})
    try:
        with opener.open(r, timeout=120) as x: return x.status, json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e:
        t = e.read()
        try: return e.code, json.loads(t)
        except Exception: return e.code, {"raw": t[:300].decode(errors="replace")}


class Cluster(object):
    def __init__(self, c):
        self.id, self.name = c["id"], c["name"]
        self.patroni = bool((c.get("haState") or {}).get("managedByPatroni"))
        self.psql = None

    def primary(self):
        s, d = call("GET", "/api/clusters/%s" % self.id)
        nodes = ((d.get("cluster") or {}).get("haState") or {}).get("nodes") or []
        p = [n["name"] for n in nodes if n.get("role") in ("primary", "leader", "master")]
        return p[0] if p else None

    def _candidates(self, c):
        out = []
        for exe in ("psql", "/usr/pgsql-16/bin/psql", "/usr/lib/postgresql/18/bin/psql", "/usr/lib/postgresql/14/bin/psql"):
            out.append(["docker", "exec", "-u", "postgres", c, exe, "-X", "-Atq"])
            out.append(["docker", "exec", "-u", "postgres", c, exe, "-X", "-Atq", "-h", "/run/pg15", "-p", "5433"])
            if SUPERPW:
                out.append(["docker", "exec", "-e", "PGPASSWORD=" + SUPERPW, c, exe, "-X", "-Atq", "-h", "localhost", "-U", "postgres"])
        return out

    def sql(self, db, q, sock=None, port=None):
        c = self.primary()
        if not self.psql or self.psql[4] != c:
            for cand in self._candidates(c):
                r = subprocess.run(cand + ["-d", "postgres", "-c", "select 1"], capture_output=True, text=True)
                if r.returncode == 0 and r.stdout.strip() == "1":
                    self.psql = cand
                    break
            else:
                raise RuntimeError("no psql access to %s" % c)
        cmd = list(self.psql)
        if sock:
            cmd = [x for x in cmd if x not in ("-h", "/run/pg15", "-p", "5433", "localhost")] + ["-h", sock, "-p", str(port)]
        r = subprocess.run(cmd + ["-d", db, "-c", q], capture_output=True, text=True)
        if r.returncode:
            raise RuntimeError(r.stderr.strip()[:400])
        return r.stdout.strip()

    def op(self, typ, params, wait=1800):
        s, d = call("POST", "/api/clusters/%s/operations" % self.id, {"type": typ, "params": params}, {"Idempotency-Key": str(uuid.uuid4())})
        if s >= 300 or "operation" not in d:
            return {"status": "http%s" % s, "error": json.dumps(d)[:600]}
        o = d["operation"]; t0 = time.time()
        while o["status"] not in ("succeeded", "failed", "cancelled", "expired", "rejected") and time.time() - t0 < wait:
            time.sleep(3); s, d = call("GET", "/api/operations/" + o["id"]); o = d.get("operation", d)
        return o


TABLES = ("public.customers", "public.orders", "public.events", "public.v_big")
RES = []


def check(cl, scn, what, ok, detail=""):
    RES.append({"cluster": cl.name, "scenario": scn, "check": what, "ok": bool(ok), "detail": str(detail)[:500]})
    print("   %s [%s] %s %s" % ("PASS" if ok else "FAIL", scn, what, ("— " + str(detail)[:300]) if detail and not ok else ""), flush=True)
    return ok


def fp(cl, db, t, **kw):
    try:
        return cl.sql(db, "SELECT count(*) || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '-') FROM %s t" % t, **kw)
    except RuntimeError:
        return "MISSING"


def state(cl, db, **kw):
    s = {t: fp(cl, db, t, **kw) for t in TABLES}
    try:
        s["lo"] = cl.sql(db, "SELECT md5(lo_get(424243))", **kw)
    except RuntimeError:
        s["lo"] = "MISSING"
    try:
        s["seq"] = cl.sql(db, "SELECT last_value FROM public.order_no", **kw)
    except RuntimeError:
        s["seq"] = "MISSING"
    return s


def _seq_ok(got, want):
    # PostgreSQL WAL-logs a sequence 32 values ahead (SEQ_LOG_VALS): after a recovery it resumes up to 32 further on, never behind - safe
    try:
        return 0 <= int(got) - int(want) <= 32
    except (TypeError, ValueError):
        return got == want


def same(cl, scn, got, want, only=None):
    keys = only or list(want)
    bad = [k for k in keys if not (_seq_ok(got.get(k), want.get(k)) if k == "seq" else got.get(k) == want.get(k))]
    return check(cl, scn, "content identical to the recorded state (%s)" % ", ".join(keys), not bad, "; ".join("%s: %s != %s" % (k, got.get(k), want.get(k)) for k in bad))


def now_utc(cl):
    return cl.sql("postgres", "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")


def wait_archived(cl, timeout=120):
    seg = cl.sql("postgres", "SELECT pg_walfile_name(pg_switch_wal())")
    t0 = time.time()
    while time.time() - t0 < timeout:
        last = cl.sql("postgres", "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")
        if last and last[8:] >= seg[8:] and last[:8] >= seg[:8]:
            return True
        time.sleep(2)
    return False


def drop_db(cl, name):
    v = int(cl.sql("postgres", "SHOW server_version_num"))
    cl.sql("postgres", "DROP DATABASE IF EXISTS %s%s" % (name, " WITH (FORCE)" if v >= 130000 else ""))


def setup(cl):
    for d in (DB, DB + "_lsn", DB + "_time", DB + "_restored", DB + "_beyond"):
        drop_db(cl, d)
    for d in cl.sql("postgres", "SELECT datname FROM pg_database WHERE datname LIKE 'arca_rs_before_%' OR datname LIKE 'pgarca_stage_rs%'").split():
        drop_db(cl, d)
    cl.sql("postgres", "CREATE DATABASE %s" % DB)
    cl.sql(DB, "CREATE TABLE customers(id int PRIMARY KEY, name text, tier text);"
               "CREATE SEQUENCE order_no;"
               "CREATE TABLE orders(id bigint PRIMARY KEY DEFAULT nextval('order_no'), customer_id int REFERENCES customers(id), amount numeric(10,2), note text);"
               "CREATE INDEX orders_cust ON orders(customer_id);"
               "CREATE TABLE events(id int, at date, what text) PARTITION BY RANGE (at);"
               "CREATE TABLE events_2026a PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2026-07-01');"
               "CREATE TABLE events_2026b PARTITION OF events FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');"
               "CREATE VIEW v_big AS SELECT customer_id, sum(amount) AS total FROM orders GROUP BY 1 HAVING sum(amount) > 100;"
               "CREATE UNLOGGED TABLE scratch(x int);"
               "INSERT INTO customers SELECT g, 'c' || g, 'basic' FROM generate_series(1, 300) g;"
               "INSERT INTO orders(customer_id, amount, note) SELECT 1 + g % 300, (g % 97) + 0.5, repeat('n', g % 40) FROM generate_series(1, 20000) g;"
               "INSERT INTO events SELECT g, '2026-01-01'::date + (g % 360), 'e' || g FROM generate_series(1, 5000) g;"
               "INSERT INTO scratch SELECT generate_series(1, 100);"
               "SELECT lo_from_bytea(424243, convert_to(repeat('large object ', 500), 'UTF8'))")


def err(o):
    return "%s %s" % (o.get("status"), str(o.get("error") or "")[:400])


def run_cluster(cl):
    print("\n==================== %s (%s)" % (cl.name, "Patroni" if cl.patroni else "standalone"), flush=True)
    try:
        v = cl.sql("postgres", "SELECT current_setting('server_version') || ' archive_mode=' || current_setting('archive_mode')")
    except RuntimeError as e:
        return check(cl, "setup", "SQL access to the primary", False, e)
    print("   primary %s: PostgreSQL %s" % (cl.primary(), v), flush=True)
    if "archive_mode=off" in v:
        return check(cl, "setup", "WAL archiving is on", False, "archive_mode is off on this cluster: enable it from the console first")
    setup(cl)
    o = cl.op("backup_run", {"type": "full"})
    if not check(cl, "setup", "full backup", o["status"] == "succeeded", err(o)):
        return
    cl.sql(DB, "INSERT INTO orders(customer_id, amount, note) SELECT 1 + g % 300, 7.25, 'after full' FROM generate_series(1, 3000) g; UPDATE customers SET tier = 'gold' WHERE id % 10 = 0")
    o = cl.op("backup_run", {"type": "incr"})
    check(cl, "setup", "incremental backup", o["status"] == "succeeded", err(o))
    cl.sql(DB, "INSERT INTO orders(customer_id, amount, note) SELECT 1 + g % 300, 3.5, 'after incr' FROM generate_series(1, 1500) g; INSERT INTO events SELECT 9000 + g, '2026-08-01', 'late' FROM generate_series(1, 200) g")
    S1 = state(cl, DB)
    o = cl.op("restore_point", {"name": "Before the rs campaign damage"})
    if not check(cl, "setup", "named restore point", o["status"] == "succeeded", err(o)):
        return
    RP = o["result"]["lsn"]
    time.sleep(1.5); T1 = now_utc(cl); time.sleep(1.5)
    # the damage: a mass DELETE, an UPDATE, a DROP of a partitioned table (each its own transaction)
    cl.sql(DB, "DELETE FROM orders WHERE id % 2 = 0")
    cl.sql(DB, "UPDATE customers SET name = 'oops'")
    cl.sql(DB, "DROP TABLE events")
    check(cl, "setup", "damage archived", wait_archived(cl))

    # ---- plan
    o = cl.op("restore_plan", {"scope": "database", "database": DB, "new_name": DB + "_lsn", "target_lsn": RP, "inclusive": False})
    r = o.get("result") or {}
    check(cl, "plan", "pre-flight ok", o["status"] == "succeeded" and (r.get("preflight") or {}).get("ok", True) and not r.get("missing_wal"), err(o) if o["status"] != "succeeded" else json.dumps((r.get("preflight") or {}).get("checks"))[:400])
    check(cl, "plan", "chain uses the incremental", len(r.get("chain") or []) >= 2, r.get("chain"))

    # ---- database at the restore point (LSN) and at T1 (time)
    for scn, params in (("db_lsn", {"target_lsn": RP, "inclusive": False}), ("db_time", {"target_time": T1})):
        name = DB + ("_lsn" if scn == "db_lsn" else "_time")
        o = cl.op("restore_database", dict(params, database=DB, new_name=name, create_missing_roles=True))
        if check(cl, scn, "restore_database", o["status"] == "succeeded", err(o)):
            same(cl, scn, state(cl, name), S1)
            check(cl, scn, "UNLOGGED table comes back empty (its rows are in no backup)", cl.sql(name, "SELECT count(*) FROM scratch") == "0")
        drop_db(cl, name)

    # ---- wrong rows: the WAL search finds the mass DELETE, the rows come back just before it
    o = cl.op("wal_forensics", {"mode": "dml", "hours": 2, "min_rows": 1000, "limit": 30})
    ev = [e for e in ((o.get("result") or {}).get("events") or []) if any(n.endswith(".public.orders") for n in e.get("names", [])) and e.get("kind") in ("DELETE", "MIXED")]
    if check(cl, "rows", "wal_forensics finds the mass DELETE", o["status"] == "succeeded" and ev, err(o) if o["status"] != "succeeded" else json.dumps((o.get("result") or {}).get("events"))[:300]):
        e = ev[-1]
        o = cl.op("restore_object", {"object": DB + ".public.orders", "objects": [DB + ".public.orders"], "target_xid": str(e["xid"]), "xid_lsn": e.get("lsn"), "inclusive": False, "finish": "rows_all"})
        if check(cl, "rows", "restore_object finish=rows_all", o["status"] == "succeeded" and (o.get("result") or {}).get("finished") == "rows_all", err(o)):
            same(cl, "rows", state(cl, DB), S1, ["public.orders"])

    # ---- dropped partitioned table: back with its partitions, nothing else touched
    o = cl.op("restore_object", {"object": DB + ".public.events", "objects": [DB + ".public.events"], "target_lsn": RP, "inclusive": False, "finish": "promote", "promote_mode": "missing_only"})
    if check(cl, "table", "restore_object of the dropped partitioned table, put back", o["status"] == "succeeded" and (o.get("result") or {}).get("finished") == "promote", err(o)):
        same(cl, "table", state(cl, DB), S1, ["public.events"])
        check(cl, "table", "partitions attached again", cl.sql(DB, "SELECT count(*) FROM pg_inherits WHERE inhparent = 'events'::regclass") == "2")

    # ---- the whole database in place at RP (the current one kept)
    o = cl.op("restore_database", {"database": DB, "new_name": DB + "_restored", "replace_original": True, "confirm": "REPLACE", "target_lsn": RP, "inclusive": False, "create_missing_roles": True})
    if check(cl, "inplace", "restore_database replace_original", o["status"] == "succeeded" and ((o.get("result") or {}).get("swap") or {}).get("replaced"), err(o)):
        same(cl, "inplace", state(cl, DB), S1)
        kept = ((o.get("result") or {}).get("swap") or {}).get("old_kept_as")
        check(cl, "inplace", "the previous database is kept", kept and cl.sql("postgres", "SELECT count(*) FROM pg_database WHERE datname = '%s'" % kept) == "1", kept)
        if kept:
            drop_db(cl, kept)

    # ---- dropped database: back under its own name, stopped just before the DROP
    check(cl, "dropped", "state before the drop archived", wait_archived(cl))
    drop_db(cl, DB)
    check(cl, "dropped", "DROP archived", wait_archived(cl))
    o = cl.op("restore_database", {"database": DB, "new_name": DB, "create_missing_roles": True})
    if check(cl, "dropped", "restore_database of the dropped database (latest)", o["status"] == "succeeded", err(o)):
        same(cl, "dropped", state(cl, DB), S1)

    # ---- a paused copy of the whole server at RP, queried on its own socket, then dropped
    o = cl.op("restore_instance", {"action": "pause", "ttl_hours": 1, "label": "rs-campaign", "target_lsn": RP, "inclusive": False})
    inst = (o.get("result") or {}).get("instance") or {}
    if check(cl, "copy", "restore_instance paused copy", o["status"] == "succeeded" and inst.get("port"), err(o)):
        got = state(cl, DB, sock=inst.get("sockdir"), port=inst.get("port")) if inst.get("sockdir") else {}
        if got:
            same(cl, "copy", got, S1)
        else:
            check(cl, "copy", "copy reachable on its socket", False, json.dumps(inst)[:300])
        s, d = call("POST", "/api/clusters/%s/operations" % cl.id, {"type": "restored_drop", "nodeId": o.get("nodeId"), "params": {"id": inst["id"], "confirm": inst.get("name") or inst["id"]}}, {"Idempotency-Key": str(uuid.uuid4())})
        check(cl, "copy", "restored copy dropped", s < 300, json.dumps(d)[:300])

    # ---- a point in the future: recovers to the end of the archive and says so
    fut = cl.sql("postgres", "SELECT to_char((clock_timestamp() + interval '2 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || '+00'")
    o = cl.op("restore_database", {"database": DB, "new_name": DB + "_beyond", "target_time": fut})
    check(cl, "beyond", "target beyond the archive: recovered to its end, said", o["status"] == "succeeded" and (o.get("result") or {}).get("target_clamped"), err(o) if o["status"] != "succeeded" else "no target_clamped in the result")
    drop_db(cl, DB + "_beyond")

    # ---- disaster recovery drill
    o = cl.op("restore_drill", {})
    check(cl, "drill", "restore_drill", o["status"] == "succeeded", err(o))


def main():
    call("POST", "/api/auth/login", {"username": U, "password": P})
    s, d = call("GET", "/api/clusters")
    want = sys.argv[1:] or DEFAULT
    cls = [Cluster(c) for c in d.get("clusters", []) if c.get("name") in want]
    for cl in cls:
        try:
            run_cluster(cl)
        except Exception as e:
            check(cl, "crash", "campaign ran", False, repr(e))
        json.dump(RES, open("/tmp/rs-matrix.json", "w"), indent=1)
    print("\n==== SUMMARY")
    for name in [c.name for c in cls]:
        mine = [r for r in RES if r["cluster"] == name]
        print("%-12s %d/%d passed%s" % (name, sum(r["ok"] for r in mine), len(mine), "" if all(r["ok"] for r in mine) else "  FAILED: " + ", ".join("%s/%s" % (r["scenario"], r["check"][:40]) for r in mine if not r["ok"])))


if __name__ == "__main__":
    main()
