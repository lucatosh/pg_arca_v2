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
NAME = sys.argv[1] if len(sys.argv) > 1 else "arca-lab"          # cluster name (e.g. geo-dc1, geo-dc2)
NODES = sys.argv[2].split(",") if len(sys.argv) > 2 else ["pg1", "pg2", "pg3"]   # its docker containers
s, d = call("GET", "/api/clusters"); CL = [c for c in d["clusters"] if c["name"].lower() == NAME.lower()][0]["id"]
RULE = {"type": "host", "database": "pgarca_probe_db", "user": "pgarca_probe_user", "address": "10.255.0.0/24", "method": "scram-sha-256", "comment": "pg_arca lab probe"}
def hba_apply(rules):
    s, d = call("POST", "/api/clusters/%s/hba/apply" % CL, {"rules": rules, "force": False}, {"Idempotency-Key": str(uuid.uuid4())})
    if s >= 300: return s, d, None
    return s, d, [wait(x["operation"]["id"]) for x in d["operations"]]
DATA = (dx(NODES[0], "grep -m1 data_dir /etc/patroni.yml").split(":", 1) + ["/var/lib/postgresql/data"])[1].strip()
print("== pg_hba via DCS (Patroni): apply one rule; data_dir", DATA)
before = dx(NODES[0], "patronictl -c /etc/patroni.yml show-config")
print("   DCS has pg_hba before:", "pg_hba" in before)
s, d, ops = hba_apply([RULE]); check("apply accepted", s == 202, str(d)[:200] if s != 202 else "")
o = ops[0] if ops else {}
check("operation succeeded", o.get("status") == "succeeded", str(o.get("error") or "")[:300]); print("   result:", json.dumps(o.get("result"))[:400])
cfg = dx(NODES[0], "patronictl -c /etc/patroni.yml show-config")
check("DCS now holds pg_hba with the probe rule", "pgarca_probe_user" in cfg)
check("DCS list kept rules in force (replication/local lines)", "replication" in cfg, "")
time.sleep(15)
for n in NODES:
    t = dx(n, "cat %s/pg_hba.conf" % DATA)
    check("%s pg_hba.conf follows the DCS" % n, "pgarca_probe_user" in t, "")
print(dx(NODES[0], "patronictl -c /etc/patroni.yml list"))
print("== read through the console: DCS-only, no file path")
s, d = call("POST", "/api/clusters/%s/operations" % CL, {"type": "hba_read", "params": {}, "nodeId": ops[0]["nodeId"] if ops else None}, {"Idempotency-Key": str(uuid.uuid4())})
o = wait(d["operation"]["id"]) if s == 202 else {}
r = o.get("result") or {}
check("hba_read mode patroni, list from the DCS", r.get("mode") == "patroni" and r.get("hba_file", "").startswith("Patroni DCS") and not r.get("dcs_seed"), json.dumps({k: r.get(k) for k in ("mode", "hba_file", "dcs_seed")}))
check("managed block holds the probe rule", any(x.get("user") == "pgarca_probe_user" for x in (r.get("managed") or {}).get("rules", [])))
s, h = call("GET", "/api/clusters/%s/hba/history" % CL)
check("console kept the previous list", s == 200 and len(h.get("history", [])) >= 1, str(len(h.get("history", []))))
print("== temporary rule already elapsed -> hba_expire removes it from the DCS")
past = time.strftime("%Y-%m-%dT%H:%M", time.gmtime(time.time() - 120))
TMP = dict(RULE, user="pgarca_tmp_user", comment="lab [until=%sZ]" % past)
s, d, ops2 = hba_apply([RULE, TMP]); check("apply with temporary rule", s == 202 and ops2 and ops2[0].get("status") == "succeeded", str((ops2 or [{}])[0].get("error") or d)[:300])
s, d = call("POST", "/api/clusters/%s/operations" % CL, {"type": "hba_expire", "params": {}, "nodeId": ops2[0]["nodeId"]}, {"Idempotency-Key": str(uuid.uuid4())})
o = wait(d["operation"]["id"]) if s == 202 else {}
check("hba_expire removed 1 rule", (o.get("result") or {}).get("removed") == 1, str(o.get("error") or o.get("result"))[:300])
check("expired rule gone from the DCS", "pgarca_tmp_user" not in dx(NODES[0], "patronictl -c /etc/patroni.yml show-config"))
print("== restore the previous version (with the probe + temp rule) and back")
s, h = call("GET", "/api/clusters/%s/hba/history" % CL); hist = h.get("history", [])
idx = next((x["index"] for x in hist if any("pgarca_tmp_user" in l for l in x["list"])), None)
s, d = call("POST", "/api/clusters/%s/hba/restore" % CL, {"index": idx}, {"Idempotency-Key": str(uuid.uuid4())})
o = wait(d["operation"]["id"]) if s == 202 else {}
check("restore succeeded", o.get("status") == "succeeded", str(o.get("error") or d)[:300])
check("restored list in the DCS", "pgarca_tmp_user" in dx(NODES[0], "patronictl -c /etc/patroni.yml show-config"))
print("== lock-out guard: dropping every rule for the live replicas is refused")
s, d, ops3 = hba_apply([{"type": "host", "database": "replication", "user": "all", "address": "0.0.0.0/0", "method": "reject", "comment": "lab lockout probe"}])
o = (ops3 or [{}])[0]
check("lock-out refused (no force)", o.get("status") == "failed" and "lock out" in str(o.get("error")), str(o.get("error") or d)[:300])
print("== remove the rule again")
s, d, ops = hba_apply([]); o = ops[0] if ops else {}
check("removal succeeded", s == 202 and o.get("status") == "succeeded", str(o.get("error") or d)[:300])
cfg = dx(NODES[0], "patronictl -c /etc/patroni.yml show-config")
check("probe rule gone from the DCS", "pgarca_probe_user" not in cfg)
print("%d/%d checks passed" % (sum(OK), len(OK)))
