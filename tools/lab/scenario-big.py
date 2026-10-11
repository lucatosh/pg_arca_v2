#!/usr/bin/env python3
"""Lab: backup / restore timings on a LARGE mixed-type database (tools/lab/big.sh load, ~11 GB) on solo1 (PostgreSQL 15, PGDATA /srv/pg15/main, conf in /etc/pg15,
port 5433, socket /run/pg15, telemetry.events in a tablespace). Driven through the console API like a DBA would. Every operation: wall time, phase timeline,
lowest free space seen on the VM while it ran, and data checks (row counts + hash of the content) against the original.
usage (VM): sg docker python3 tools/lab/scenario-big.py [steps]      steps: comma list of full,verify,churn,incr,diff,damage,forensics,plan,table,schema,database,instance,expire (default all)
"""
import http.cookiejar, json, os, shutil, subprocess, sys, threading, time, urllib.request, uuid
BASE = os.environ.get("PG_ARCA_URL", "http://localhost:3000")
U = os.environ.get("ARCA_USER", "claude-test"); P = os.environ.get("ARCA_PASS", "claude-lab-test-pass-1")
STEPS = (sys.argv[1] if len(sys.argv) > 1 else "full,expire0,verify,churn,incr,diff,damage,forensics,plan,table,schema,database,live,instance,expire").split(",")
STATE = "/tmp/scenario-big.json"
jar = http.cookiejar.CookieJar(); opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(m, path, body=None, hdr=None):
    r = urllib.request.Request(BASE + path, method=m, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json", **(hdr or {})})
    try:
        with opener.open(r, timeout=120) as x:
            return x.status, json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e:
        t = e.read()
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, {"raw": t[:300].decode(errors="replace")}


call("POST", "/api/auth/login", {"username": U, "password": P})
s, d = call("GET", "/api/clusters")
CL = [c for c in d["clusters"] if "solo" in c["name"].lower()][0]["id"]
RES, TIMES = [], []


def free_gb():
    st = os.statvfs("/")
    return st.f_bavail * st.f_frsize / 2 ** 30


def op(typ, params, wait=6 * 3600):
    s, d = call("POST", "/api/clusters/%s/operations" % CL, {"type": typ, "params": params}, {"Idempotency-Key": str(uuid.uuid4())})
    if s >= 300 or "operation" not in d:
        return {"status": "http%s" % s, "error": json.dumps(d)[:400]}
    o = d["operation"]; t0 = time.time(); low = free_gb()
    while o["status"] not in ("succeeded", "failed", "cancelled", "expired") and time.time() - t0 < wait:
        time.sleep(3); low = min(low, free_gb())
        s, d = call("GET", "/api/operations/" + o["id"]); o = d.get("operation", d)
    o["_wall"] = time.time() - t0; o["_low_free_gb"] = low
    s, lg = call("GET", "/api/operations/%s/log" % o["id"])
    phases = [e for e in (lg.get("entries") or lg.get("log") or []) if e.get("kind") == "log"]
    o["_phases"] = [(e.get("at", "")[11:19], e.get("text", "")[:90]) for e in phases][-12:]
    return o


def timed(label, typ, params, **kw):
    print("-- %s (%s)" % (label, typ), flush=True)
    o = op(typ, params, **kw)
    TIMES.append((label, o.get("_wall", 0), o["status"], o.get("_low_free_gb", 0)))
    print("   %s in %.1f s, lowest free space on / during it: %.1f GB" % (o["status"], o.get("_wall", 0), o.get("_low_free_gb", 0)), flush=True)
    for at, t in o.get("_phases", []):
        print("     %s %s" % (at, t))
    if o["status"] != "succeeded":
        print("   error:", str(o.get("error") or "")[:500])
    return o


def sql(db, q, timeout=7200):
    r = subprocess.run(["docker", "exec", "solo1", "gosu", "postgres", "psql", "-X", "-h", "/run/pg15", "-p", "5433", "-U", "postgres", "-d", db, "-Atc", q],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[:300])
    return r.stdout.strip()


def fp(db, t):
    """count + order-independent hash of the whole content (full scan, no sort: fine on millions of rows)."""
    try:
        return sql(db, "SELECT count(*) || ':' || coalesce(sum(hashtext(x::text)::bigint), 0) FROM %s x" % t)
    except RuntimeError as e:
        return "MISSING(%s)" % str(e)[:60]


def check(n, ok, x=""):
    RES.append(bool(ok)); print("   %s %s %s" % ("PASS" if ok else "FAIL", n, x), flush=True)


def save(**kv):
    st = load(); st.update(kv)
    with open(STATE, "w") as f:
        json.dump(st, f)


def load():
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {}


TABLES = ("sales.order_lines", "crm.customers", "docs.documents", "telemetry.events", "sales.orders_2025_06")
print("== bigdb on solo1: %s, VM free %.1f GB" % (sql("postgres", "select pg_size_pretty(pg_database_size('bigdb'))"), free_gb()))

if "full" in STEPS:
    o = timed("full backup", "backup_run", {"type": "full"}); check("full backup", o["status"] == "succeeded")
    print("   result:", json.dumps({k: v for k, v in (o.get("result") or {}).items() if k in ("set_id", "stats", "bytes", "elapsed_sec", "duration_sec")})[:600])
if "expire0" in STEPS:                                           # the WAL of the initial load predates the first full backup: retention frees it (and that is a test too)
    o = timed("expire after the first full (WAL of the load)", "backup_expire", {}); check("expire", o["status"] == "succeeded")
    print("   ", json.dumps({k: v for k, v in (o.get("result") or {}).items() if k in ("wal_removed", "bytes_freed", "delete_sets", "keep_sets")})[:300], "VM free %.1f GB" % free_gb())
if "verify" in STEPS:
    o = timed("verify", "backup_verify", {}); check("verify", o["status"] == "succeeded" and (o.get("result") or {}).get("ok") is not False)
if "churn" in STEPS:
    t0 = time.time()
    sql("bigdb", "UPDATE sales.orders SET status = 'returned' WHERE id % 50 = 0; DELETE FROM telemetry.events WHERE id % 40 = 0")
    sql("bigdb", "CALL big_load(1, 0.15)")                      # alone: the procedure commits, it cannot run inside a multi-statement string
    print("-- churn (2%% of orders updated, 2.5%% of events deleted, +15%% of a unit) in %.0f s" % (time.time() - t0))
if "incr" in STEPS:
    o = timed("incremental backup after churn", "backup_run", {"type": "incr"}); check("incremental backup", o["status"] == "succeeded")
if "diff" in STEPS:
    o = timed("differential backup", "backup_run", {"type": "diff"}); check("differential backup", o["status"] == "succeeded")
if "damage" in STEPS:
    base = {t: fp("bigdb", t) for t in TABLES}
    print("   fingerprints:", base)
    time.sleep(2); t_ok = sql("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US')||'+00'"); time.sleep(2)
    sql("bigdb", "DROP TABLE sales.order_lines; TRUNCATE docs.documents CASCADE; DROP SCHEMA telemetry CASCADE")
    sql("postgres", "SELECT pg_switch_wal()"); time.sleep(10)
    save(base=base, t_ok=t_ok)
st = load(); base = st.get("base") or {}; t_ok = st.get("t_ok")
if "forensics" in STEPS:
    o = timed("WAL forensics (last 2 h)", "wal_forensics", {"mode": "events", "hours": 2, "limit": 50})
    kinds = [e.get("kind") for e in (o.get("result") or {}).get("events", [])]
    check("forensics finds the DROP and the TRUNCATE", "DROP" in kinds and "TRUNCATE" in kinds, str(kinds[:8]))
if "plan" in STEPS and t_ok:
    o = timed("restore plan (database)", "restore_plan", {"scope": "database", "database": "bigdb", "new_name": "bigdb_pitr", "target_time": t_ok})
    r = o.get("result") or {}
    print("   extract %.1f GB of %.1f GB; pre-flight: %s" % ((r.get("extract_bytes") or 0) / 2 ** 30, (r.get("cluster_bytes") or 0) / 2 ** 30,
                                                          [(c["id"], c["level"], c["text"][:90]) for c in (r.get("preflight") or {}).get("checks", [])]))
    check("plan has a pre-flight", bool(r.get("preflight")))
if "table" in STEPS and t_ok:
    o = timed("restore table sales.order_lines (PITR)", "restore_object", {"object": "bigdb.sales.order_lines", "stage_db": "pgarca_stage_big", "target_time": t_ok})
    check("restore_object order_lines", o["status"] == "succeeded")
    if o["status"] == "succeeded":
        p = timed("promote order_lines (replace)", "restore_promote", {"stage_db": "pgarca_stage_big", "object": "bigdb.sales.order_lines", "mode": "replace", "confirm": "SOSTITUISCI"})
        check("promote order_lines", p["status"] == "succeeded")
        check("order_lines identical to before the DROP", fp("bigdb", "sales.order_lines") == base.get("sales.order_lines"))
    sql("postgres", "DROP DATABASE IF EXISTS pgarca_stage_big WITH (FORCE)")
if "schema" in STEPS and t_ok:
    o = timed("restore schema telemetry (tablespace) (PITR)", "restore_object", {"object": "bigdb.telemetry", "stage_db": "pgarca_stage_bigs", "target_time": t_ok})
    check("restore_object schema telemetry", o["status"] == "succeeded")
    if o["status"] == "succeeded":
        p = timed("promote schema telemetry (replace)", "restore_promote", {"stage_db": "pgarca_stage_bigs", "mode": "replace", "confirm": "SOSTITUISCI"})
        check("promote telemetry", p["status"] == "succeeded")
        check("telemetry.events identical", fp("bigdb", "telemetry.events") == base.get("telemetry.events"))
    sql("postgres", "DROP DATABASE IF EXISTS pgarca_stage_bigs WITH (FORCE)")
if "database" in STEPS and t_ok:
    o = timed("restore database bigdb -> bigdb_pitr (PITR)", "restore_database", {"database": "bigdb", "new_name": "bigdb_pitr", "target_time": t_ok, "jobs": 4})
    check("restore_database", o["status"] == "succeeded")
    if o["status"] == "succeeded":
        for t in TABLES:
            check("%s identical in bigdb_pitr" % t, fp("bigdb_pitr", t) == base.get(t))
        check("documents back (TRUNCATE undone)", fp("bigdb_pitr", "docs.documents") == base.get("docs.documents"))
    sql("postgres", "DROP DATABASE IF EXISTS bigdb_pitr WITH (FORCE)")
if "live" in STEPS:
    # backup AND restore while the application keeps writing: one row per transaction (id, commit-time stamp, payload, checksum) at full speed.
    # Consistency = the recovered copy holds EXACTLY a prefix 1..N of the ledger (no gap, no torn row), all stamped before the target, and the writer never stopped.
    print("== live: backup and restore under continuous inserts", flush=True)
    sql("bigdb", "DROP SCHEMA IF EXISTS live CASCADE; CREATE SCHEMA live; CREATE TABLE live.ledger(id bigint PRIMARY KEY, ts timestamptz NOT NULL, payload text NOT NULL, chk text NOT NULL); CREATE TABLE live.stop(x int)")
    sql("bigdb", """CREATE OR REPLACE PROCEDURE live.writer() LANGUAGE plpgsql AS $w$ DECLARE i bigint := 0; BEGIN
        LOOP i := i + 1; INSERT INTO live.ledger VALUES (i, clock_timestamp(), repeat(md5(i::text), 20), md5(i::text)); COMMIT;
             IF i % 200 = 0 THEN EXIT WHEN EXISTS (SELECT 1 FROM live.stop); END IF; END LOOP; END $w$""")
    wr = subprocess.Popen(["docker", "exec", "solo1", "gosu", "postgres", "psql", "-X", "-h", "/run/pg15", "-p", "5433", "-d", "bigdb", "-c", "CALL live.writer()"],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    time.sleep(20)
    n0 = int(sql("bigdb", "SELECT count(*) FROM live.ledger"))
    o = timed("incremental backup DURING inserts", "backup_run", {"type": "incr"}); check("backup while writing", o["status"] == "succeeded")
    t_live = sql("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US')||'+00'"); time.sleep(15)
    sql("postgres", "SELECT pg_switch_wal()"); time.sleep(10)
    o = timed("restore live.ledger at a point DURING inserts", "restore_object", {"object": "bigdb.live.ledger", "stage_db": "pgarca_stage_live", "target_time": t_live})
    check("restore while writing", o["status"] == "succeeded")
    if o["status"] == "succeeded":
        r = sql("pgarca_stage_live", "SELECT count(*), coalesce(min(id),0), coalesce(max(id),0), count(*) FILTER (WHERE chk <> md5(id::text) OR payload <> repeat(md5(id::text), 20)), count(*) FILTER (WHERE ts > '%s') FROM live.ledger" % t_live).split("|")
        cnt, lo, hi, torn, late = (int(x) for x in r)
        print("   recovered %d rows (ids %d..%d), torn %d, stamped after the target %d; live table now %s rows" % (cnt, lo, hi, torn, late, sql("bigdb", "SELECT count(*) FROM live.ledger")), flush=True)
        check("recovered rows are an exact prefix 1..N (no gap)", cnt == hi and lo == 1)
        check("no torn row", torn == 0)
        check("nothing committed after the target", late == 0)
        nxt = sql("bigdb", "SELECT ts > '%s' FROM live.ledger WHERE id = %d" % (t_live, hi + 1))
        check("the next row in the live table is after the target (the cut is exactly at the target)", nxt == "t", nxt)
        before = int(sql("bigdb", "SELECT count(*) FROM live.ledger"))
        p = timed("promote as_new DURING inserts", "restore_promote", {"stage_db": "pgarca_stage_live", "mode": "as_new"})
        check("promotion while writing", p["status"] == "succeeded")
        check("the writer kept writing during the promotion", int(sql("bigdb", "SELECT count(*) FROM live.ledger")) > before)
    sql("postgres", "DROP DATABASE IF EXISTS pgarca_stage_live WITH (FORCE)")
    sql("bigdb", "INSERT INTO live.stop VALUES (1)")
    try:
        out, err = wr.communicate(timeout=120)
    except subprocess.TimeoutExpired:
        wr.kill(); out, err = wr.communicate()
    check("the writer never failed", wr.returncode == 0 and "ERROR" not in (err or ""), (err or "")[:300])
    print("   writer: %s rows written, %d before the backup started" % (sql("bigdb", "SELECT count(*) FROM live.ledger"), n0))
if "instance" in STEPS:
    dest = "/srv/restore_big"
    subprocess.run(["docker", "exec", "solo1", "rm", "-rf", dest, dest + "_tblspc"])
    o = timed("restore whole instance to %s" % dest, "restore_instance", {"destination": dest, "action": "pause"})
    check("restore_instance", o["status"] == "succeeded")
    subprocess.run(["docker", "exec", "solo1", "rm", "-rf", dest, dest + "_tblspc"])
if "expire" in STEPS:
    o = timed("expire (retention)", "backup_expire", {}); check("expire", o["status"] == "succeeded")

print("\n== timings")
for label, wall, status, low in TIMES:
    print("   %-48s %8.1f s  %-10s lowest free %.1f GB" % (label, wall, status, low))
print("%d/%d checks passed; VM free now %.1f GB" % (sum(RES), len(RES), free_gb()))
