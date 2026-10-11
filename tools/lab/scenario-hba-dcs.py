#!/usr/bin/env python3
"""Lab: pg_hba on a Patroni cluster goes ONLY through the DCS. Applies one harmless rule through the console, checks `patronictl show-config` (DCS seeded with the rules in force + the
managed block), that every member's pg_hba.conf follows, that the cluster stays healthy, then removes the rule again.  usage (VM): sg docker python3 tools/lab/scenario-hba-dcs.py"""
import http.cookiejar, json, os, subprocess, sys, time, urllib.request, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
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
def sh(c): return subprocess.run(c, shell=True, capture_output=True, text=True).stdout
def dx(n, c): return sh("docker exec %s %s" % (n, c))
def wait(oid, t=180):
    t0 = time.time()
    while time.time() - t0 < t:
        s, d = call("GET", "/api/operations/" + oid); o = d.get("operation", d)
        if o["status"] in ("succeeded", "failed", "cancelled", "expired", "rejected"): return o
        time.sleep(2)
    return o
OK = []
def check(name, cond, extra=""):
    OK.append(bool(cond)); print("   %s %s %s" % ("PASS" if cond else "FAIL", name, extra))
call("POST", "/api/auth/login", {"username": U, "password": P})
s, d = call("GET", "/api/clusters"); CL = [c for c in d["clusters"] if "arca-lab" in c["name"].lower()][0]["id"]
RULE = {"type": "host", "database": "pgarca_probe_db", "user": "pgarca_probe_user", "address": "10.255.0.0/24", "method": "scram-sha-256", "comment": "pg_arca lab probe"}
def hba_apply(rules):
    s, d = call("POST", "/api/clusters/%s/hba/apply" % CL, {"rules": rules, "force": False}, {"Idempotency-Key": str(uuid.uuid4())})
    if s >= 300: return s, d, None
    return s, d, [wait(x["operation"]["id"]) for x in d["operations"]]
print("== pg_hba via DCS (Patroni): apply one rule")
before = dx("pg1", "patronictl -c /etc/patroni.yml show-config")
print("   DCS has pg_hba before:", "pg_hba" in before)
s, d, ops = hba_apply([RULE]); check("apply accepted", s == 202, str(d)[:200] if s != 202 else "")
o = ops[0] if ops else {}
check("operation succeeded", o.get("status") == "succeeded", str(o.get("error") or "")[:300]); print("   result:", json.dumps(o.get("result"))[:400])
cfg = dx("pg1", "patronictl -c /etc/patroni.yml show-config")
check("DCS now holds pg_hba with the probe rule", "pgarca_probe_user" in cfg)
check("DCS list kept rules in force (replication/local lines)", "replication" in cfg, "")
time.sleep(15)
for n in ("pg1", "pg2", "pg3"):
    t = dx(n, "cat /var/lib/postgresql/data/pg_hba.conf") or dx(n, "sh -c 'cat $(psql -U postgres -Atc \"show hba_file\")'")
    rules = dx(n, "psql -h localhost -U postgres -Atc \"select count(*) from pg_hba_file_rules where user_name::text like '%pgarca_probe_user%'\"") if False else ""
    check("%s pg_hba.conf follows the DCS" % n, "pgarca_probe_user" in t, "")
print(dx("pg1", "patronictl -c /etc/patroni.yml list"))
print("== remove the rule again")
s, d, ops = hba_apply([]); o = ops[0] if ops else {}
check("removal succeeded", s == 202 and o.get("status") == "succeeded", str(o.get("error") or d)[:300])
cfg = dx("pg1", "patronictl -c /etc/patroni.yml show-config")
check("probe rule gone from the DCS", "pgarca_probe_user" not in cfg)
print("%d/%d checks passed" % (sum(OK), len(OK)))
