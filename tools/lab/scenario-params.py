#!/usr/bin/env python3
"""Lab (Patroni): parameters go through the DCS only, and a bad one never reaches it.  usage (VM): sg docker python3 tools/lab/scenario-params.py"""
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
def wait(oid, t=120):
    t0 = time.time()
    while time.time() - t0 < t:
        s, d = call("GET", "/api/operations/" + oid); o = d.get("operation", d)
        if o["status"] in ("succeeded", "failed", "cancelled", "expired", "rejected"): return o
        time.sleep(2)
    return o
call("POST", "/api/auth/login", {"username": U, "password": P})
s, d = call("GET", "/api/clusters"); CL = [c for c in d["clusters"] if "arca-lab" in c["name"].lower()][0]["id"]
OK = []
def check(n, c, x=""): OK.append(bool(c)); print("   %s %s %s" % ("PASS" if c else "FAIL", n, x))
def setp(name, value):
    s, d = call("POST", "/api/clusters/%s/operations" % CL, {"type": "pg_set_param", "params": {"name": name, "value": value}}, {"Idempotency-Key": str(uuid.uuid4())})
    if s >= 300 or "operation" not in d: return {"status": "http%s" % s, "error": json.dumps(d)[:300]}
    return wait(d["operation"]["id"])
def dcs(): return subprocess.run("docker exec pg1 patronictl -c /etc/patroni.yml show-config", shell=True, capture_output=True, text=True).stdout
print("== parameters through the DCS")
before = dcs()
for name, value, frag in (("shared_bufers", "1GB", "unknown parameter"), ("max_connections", "0", "below the minimum"), ("wal_level", "turbo", "allowed values"), ("autovacuum", "maybe", "boolean"), ("listen_addresses", "*", "Patroni configuration")):
    o = setp(name, value); err = str(o.get("error") or "")
    check("refused %s=%s" % (name, value), o["status"] == "failed" and frag in err, err[:140])
check("DCS untouched by the refused ones", dcs() == before)
o = setp("log_min_duration_statement", "5s"); check("valid value with unit accepted", o["status"] == "succeeded", str(o.get("error") or o.get("result"))[:200])
check("DCS holds it", "log_min_duration_statement" in dcs())
time.sleep(12)
r = subprocess.run("docker exec pg1 psql -U postgres -h localhost -Atc \"show log_min_duration_statement\"", shell=True, capture_output=True, text=True, env=dict(os.environ))
print("   pg1 reports:", (r.stdout or r.stderr).strip()[:80])
o = setp("log_min_duration_statement", None); check("reset removes it from the DCS", o["status"] == "succeeded" and "log_min_duration_statement" not in dcs(), str(o.get("error") or "")[:160])
print("%d/%d checks passed" % (sum(OK), len(OK)))
