#!/usr/bin/env python3
"""Lab: the same product on an UNUSUAL layout - standalone PostgreSQL 15 with PGDATA /srv/pg15/main, configuration in /etc/pg15 (outside PGDATA), port 5433, socket /run/pg15, a tablespace
in /srv/pg15_ts/fast, no systemd, no Patroni, archiving off, wal_level minimal, no checksums (container solo1, tools/lab/solo).  Driven through the console API.
Steps: archive_enable (restart) -> full backup -> add data -> incr backup -> delete -> restore_database (PITR) / restore_object of a TABLESPACE table / restore_drill.
usage (VM): sg docker python3 tools/lab/scenario-solo.py"""
import http.cookiejar, json, os, subprocess, sys, time, urllib.request, uuid
BASE = os.environ.get("PG_ARCA_URL", "http://localhost:3000")
U = os.environ.get("ARCA_USER", "claude-test"); P = os.environ.get("ARCA_PASS", "claude-lab-test-pass-1")
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
s, d = call("GET", "/api/clusters"); CL = [c for c in d["clusters"] if "solo" in c["name"].lower()][0]["id"]
def op(typ, params, wait=900):
    s, d = call("POST", "/api/clusters/%s/operations" % CL, {"type": typ, "params": params}, {"Idempotency-Key": str(uuid.uuid4())})
    if s >= 300 or "operation" not in d: return {"status": "http%s" % s, "error": json.dumps(d)[:400]}
    o = d["operation"]; t0 = time.time()
    while o["status"] not in ("succeeded", "failed", "cancelled", "canceled", "expired", "rejected") and time.time() - t0 < wait:
        time.sleep(2); s, d = call("GET", "/api/operations/" + o["id"]); o = d.get("operation", d)
    return o
def sql(db, q):
    r = subprocess.run(["docker", "exec", "solo1", "gosu", "postgres", "psql", "-X", "-h", "/run/pg15", "-p", "5433", "-U", "postgres", "-d", db, "-Atc", q], capture_output=True, text=True)
    if r.returncode: raise RuntimeError(r.stderr.strip()[:300])
    return r.stdout.strip()
def fp(db, t):
    try: return sql(db, "SELECT count(*)||':'||coalesce(md5(string_agg(t::text,'|' ORDER BY t::text)),'-') FROM %s t" % t)
    except RuntimeError: return "MISSING"
RES = []
def check(n, ok, x=""): RES.append(bool(ok)); print("   %s %s %s" % ("PASS" if ok else "FAIL", n, x), flush=True)
def show(o): return str(o.get("error") or "")[:300]

print("== the agent sees the unusual layout")
o = op("discovery_scan", {}); r = o.get("result") or {}
inst = (r.get("postgres_instances") or [{}])[0]
print("   data_directory", inst.get("data_directory"), "| config_file", inst.get("config_file"), "| socket", inst.get("socket_directory"), "| port", inst.get("port"), "| bin_dir", inst.get("bin_dir"))
check("PGDATA, port, socket and bin dir found", inst.get("data_directory") == "/srv/pg15/main" and inst.get("port") == 5433 and inst.get("socket_directory") == "/run/pg15" and inst.get("bin_dir"))
check("configuration outside PGDATA found", (inst.get("config_file") or "").startswith("/etc/pg15"))
check("tablespace seen", any("fast" in (t.get("location") or "") for t in inst.get("tablespaces", [])))

print("== archive_enable (wal_level minimal -> replica, restart needed)")
o = op("archive_enable", {}); check("archive_enable", o["status"] == "succeeded", show(o)); res = o.get("result") or {}
print("   ", json.dumps(res)[:400])
cmd = sql("postgres", "show archive_command")
check("archive_command points to an existing executable", cmd and subprocess.run(["docker", "exec", "solo1", "sh", "-c", "test -x %s" % cmd.split()[0 if not cmd.startswith("env") else -3]], capture_output=True).returncode == 0, cmd[:120])
if res.get("restart_required"):
    subprocess.run(["docker", "restart", "solo1"], capture_output=True); time.sleep(25)
check("archive_mode on after the restart", sql("postgres", "show archive_mode") == "on")

print("== full backup, data, incremental, damage, PITR")
sql("erp", "DROP TABLE IF EXISTS pitr_probe"); 
o = op("backup_run", {"type": "full"}); check("full backup (tablespace included)", o["status"] == "succeeded", show(o))
sql("erp", "CREATE TABLE pitr_probe(id int primary key, v text); INSERT INTO pitr_probe SELECT g, 'v'||g FROM generate_series(1,500) g; INSERT INTO invoices(customer_id,amount) SELECT 1, 9.99 FROM generate_series(1,200)")
o = op("backup_run", {"type": "incr"}); check("incremental backup", o["status"] == "succeeded", show(o))
base = {t: fp("erp", t) for t in ("pitr_probe", "invoices", "customers")}
time.sleep(2); t_ok = sql("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US')||'+00'"); time.sleep(2)
sql("erp", "DELETE FROM invoices WHERE id > 12000; DROP TABLE pitr_probe"); sql("postgres", "SELECT pg_switch_wal()"); time.sleep(8)
o = op("restore_database", {"database": "erp", "new_name": "erp_pitr", "target_time": t_ok}); check("restore_database to a side database", o["status"] == "succeeded", show(o))
if o["status"] == "succeeded":
    for t in base: check("%s identical after PITR" % t, fp("erp_pitr", t) == base[t])
sql("postgres", "DROP DATABASE IF EXISTS erp_pitr WITH (FORCE)")

print("== table in a TABLESPACE: restore_object + promote")
sql("erp", "DROP TABLE invoices"); sql("postgres", "SELECT pg_switch_wal()"); time.sleep(6)
o = op("restore_object", {"object": "erp.public.invoices", "stage_db": "pgarca_stage_solo", "target_time": t_ok}); check("restore_object invoices", o["status"] == "succeeded", show(o))
o2 = op("restore_promote", {"stage_db": "pgarca_stage_solo", "object": "erp.public.invoices", "mode": "replace"}); check("restore_promote", o2["status"] == "succeeded", show(o2))
check("invoices identical", fp("erp", "invoices") == base["invoices"])

print("== restore drill (whole cluster in scratch)")
o = op("restore_drill", {}); check("restore_drill", o["status"] == "succeeded", show(o)); print("   ", json.dumps(o.get("result"))[:300])
print("== hba on a file outside PGDATA")
o = op("hba_read", {}); check("hba_read finds /etc/pg15/pg_hba.conf", o["status"] == "succeeded" and "/etc/pg15" in json.dumps(o.get("result")), show(o))
print("%d/%d checks passed" % (sum(RES), len(RES)))
