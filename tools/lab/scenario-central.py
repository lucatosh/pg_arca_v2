#!/usr/bin/env python3
"""Lab: centralised ephemeral instance. Cluster setting placement=central with a REPLICA as the central node; a table restore (restore_object, stage only: nothing in the live tables is touched)
must run on that node and create the stage database on the primary.  usage (VM): sg docker python3 tools/lab/scenario-central.py [node-name]"""
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
def wait(oid, t=600):
    t0 = time.time()
    while time.time() - t0 < t:
        s, d = call("GET", "/api/operations/" + oid); o = d.get("operation", d)
        if o["status"] in ("succeeded", "failed", "cancelled", "expired", "rejected"): return o
        time.sleep(2)
    return o
call("POST", "/api/auth/login", {"username": U, "password": P})
s, d = call("GET", "/api/clusters"); CL = [c for c in d["clusters"] if "arca-lab" in c["name"].lower()][0]["id"]
s, d = call("GET", "/api/clusters/%s/destination" % CL); nodes = {n["name"]: n["id"] for n in d["nodes"]}
want = sys.argv[1] if len(sys.argv) > 1 else "pg3"
s, d = call("PUT", "/api/scoped/ephemeral/assignments", {"scope": "cluster", "key": CL, "value": {"placement": "central", "centralNode": nodes[want]}}); print("assign", s, str(d)[:200])
s, d = call("GET", "/api/clusters/%s/scoped/ephemeral" % CL); print("effective:", json.dumps(d)[:400])
s, d = call("POST", "/api/clusters/%s/operations" % CL, {"type": "restore_object", "params": {"object": "arca_restore_lab.hr.timesheets", "stage_db": "pgarca_stage_central"}}, {"Idempotency-Key": str(uuid.uuid4())})
print("submit", s, str(d)[:300])
if "operation" in d:
    o = wait(d["operation"]["id"]); print("status:", o["status"], "node:", o.get("nodeId"), [n for n, i in nodes.items() if i == o.get("nodeId")])
    print("error:", o.get("error")); print("result:", json.dumps(o.get("result"))[:700])
call("PUT", "/api/scoped/ephemeral/assignments", {"scope": "cluster", "key": CL, "inherit": True}); print("assignment removed")
