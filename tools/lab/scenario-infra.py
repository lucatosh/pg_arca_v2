#!/usr/bin/env python3
"""Lab: ephemeral_preflight (installed major, missing major -> install plan), private install of a missing major (optional) and destination_check on every node,
through the console API. Nothing is APPLIED: the destination is only checked. usage (on the VM): python3 tools/lab/scenario-infra.py [install]"""
import http.cookiejar, json, os, sys, time, urllib.request, uuid
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
def wait(oid, t=900):
    t0 = time.time()
    while time.time() - t0 < t:
        s, d = call("GET", "/api/operations/" + oid); o = d.get("operation", d)
        if o["status"] in ("succeeded", "failed", "cancelled", "expired", "rejected"): return o
        time.sleep(2)
    return o
call("POST", "/api/auth/login", {"username": U, "password": P})
s, d = call("GET", "/api/clusters"); CL = [c for c in d["clusters"] if "arca-lab" in c["name"].lower()][0]["id"]
s, d = call("GET", "/api/clusters/%s/destination" % CL); nodes = d["nodes"]
print("nodes:", [(n["name"], n["online"], n["repo_path"]) for n in nodes])
def run(typ, node, params):
    s, d = call("POST", "/api/clusters/%s/operations" % CL, {"type": typ, "nodeId": node, "params": params}, {"Idempotency-Key": str(uuid.uuid4())})
    if s >= 300 or "operation" not in d: return {"status": "http%s" % s, "error": json.dumps(d)[:300]}
    return wait(d["operation"]["id"])
for n in nodes:
    for major in (16, 12):
        o = run("ephemeral_preflight", n["id"], {"major": major})
        r = o.get("result") or {}
        print("\n== preflight %s PG%s: %s" % (n["name"], major, o["status"]))
        print(json.dumps(r, indent=1)[:1800] if r else o.get("error"))
if "install" in sys.argv:
    n = nodes[0]; o = run("ephemeral_install", n["id"], {"major": 12, "mode": "private", "confirm": "INSTALL"})
    print("\n== install private PG12 on %s: %s" % (n["name"], o["status"])); print(json.dumps(o.get("result") or o.get("error"), indent=1)[:2500])
# destination: check only, in a scratch path next to the repo (never applied)
repo = nodes[0]["repo_path"] or "/var/lib/pg_arca"
base = os.path.dirname(repo.rstrip("/")) or "/"
s, d = call("PUT", "/api/scoped/destination/assignments", {"scope": "cluster", "key": CL, "value": {"type": "local", "repoPath": base + "/dest-test/{cluster}/repo", "walPath": base + "/dest-test/{cluster}/wal", "minFreeGb": 1}})
print("\nassign:", s)
s, d = call("POST", "/api/clusters/%s/destination/check" % CL, {"bench": True}, {"Idempotency-Key": str(uuid.uuid4())})
print("check:", s, d.get("error"))
for x in d.get("operations", []):
    o = wait(x["operation"]["id"]); print("\n== destination_check", x["nodeName"], o["status"]); print(json.dumps(o.get("result") or o.get("error"), indent=1)[:1800])
# negative: NFS expected but the path is a plain directory -> must be refused, nothing created
call("PUT", "/api/scoped/destination/assignments", {"scope": "cluster", "key": CL, "value": {"type": "nfs", "repoPath": base + "/dest-nfs/{cluster}/repo"}})
s, d = call("POST", "/api/clusters/%s/destination/check" % CL, {}, {"Idempotency-Key": str(uuid.uuid4())})
for x in d.get("operations", []):
    o = wait(x["operation"]["id"]); r = o.get("result") or {}
    print("\n== NFS expected on a local dir,", x["nodeName"], "ok =", r.get("ok"), [c["text"][:110] for p in r.get("paths", []) for c in p["checks"] if c["level"] == "bad"])
call("PUT", "/api/scoped/destination/assignments", {"scope": "cluster", "key": CL, "inherit": True})
print("\nassignment removed")
