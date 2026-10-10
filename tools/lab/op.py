#!/usr/bin/env python3
"""Lab helper: run one console operation and wait for it.   op.py <cluster-id|name-substring> <type> ['{"json":"params"}'] [--node NAME] [--wait SEC]
   op.py - GET /api/...   (raw GET)      Prints status, error/result (truncated). Exit 0 only when the operation succeeded."""
import http.cookiejar, json, os, sys, time, urllib.request, uuid
BASE = os.environ.get("PG_ARCA_URL", "http://localhost:3000")
U = os.environ.get("ARCA_USER", "claude-test"); P = os.environ.get("ARCA_PASS", "claude-lab-test-pass-1")
jar = http.cookiejar.CookieJar(); op_ = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(m, path, body=None, hdr=None):
    r = urllib.request.Request(BASE + path, method=m, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json", **(hdr or {})})
    try:
        with op_.open(r, timeout=60) as x: return x.status, json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e:
        t = e.read();
        try: return e.code, json.loads(t)
        except Exception: return e.code, {"raw": t[:300].decode(errors="replace")}
call("POST", "/api/auth/login", {"username": U, "password": P})
a = sys.argv[1:]
if a and a[0] == "-":
    s, d = call("GET", a[1]); print(json.dumps(d, indent=1)[:int(os.environ.get("MAXC", "6000"))]); sys.exit(0)
if a and a[0] == "last":      # op.py last [N]  -> the latest operations of the console, one line each
    s, d = call("GET", "/api/operations"); ops = d.get("operations", d)
    for o in ops[-int(a[1] if len(a) > 1 else 5):]: print(o["id"][-6:], o["type"], o["status"], o.get("createdAt", "")[11:19], o.get("updatedAt", "")[11:19], str(o.get("error") or "")[:200])
    sys.exit(0)
if a and a[0] == "show":      # op.py show <id-suffix> -> full record of an operation
    s, d = call("GET", "/api/operations"); ops = d.get("operations", d)
    for o in ops:
        if o["id"].endswith(a[1]): print(json.dumps(o, indent=1)[:4000])
    sys.exit(0)
cl, typ = a[0], a[1]; params = json.loads(a[2]) if len(a) > 2 and not a[2].startswith("--") else {}
node = a[a.index("--node") + 1] if "--node" in a else None; wait = int(a[a.index("--wait") + 1]) if "--wait" in a else 300
s, d = call("GET", "/api/clusters"); cs = [c for c in d["clusters"] if c["id"] == cl or cl.lower() in c["name"].lower()]
if not cs: print("cluster not found"); sys.exit(2)
cid = cs[0]["id"]; body = {"type": typ, "params": params}
if node:
    s, d = call("GET", "/api/nodes"); nn = [n for n in d.get("nodes", d) if n["name"] == node and n["clusterId"] == cid]
    if not nn: print("node not found"); sys.exit(2)
    body["nodeId"] = nn[0]["id"]
s, d = call("POST", "/api/clusters/%s/operations" % cid, body, {"Idempotency-Key": str(uuid.uuid4())})
if s >= 300 or "operation" not in d: print("HTTP", s, json.dumps(d)[:800]); sys.exit(1)
o = d["operation"]; t0 = time.time()
while o["status"] not in ("succeeded", "failed", "cancelled", "canceled", "expired", "rejected") and time.time() - t0 < wait:
    time.sleep(2); s, d = call("GET", "/api/operations/" + o["id"]); o = d.get("operation", d)
print("STATUS", o["status"], "(%ds)" % (time.time() - t0))
if o.get("error"): print("ERROR", json.dumps(o["error"])[:1500])
if o.get("result") is not None: print("RESULT", json.dumps(o["result"], indent=1)[:int(os.environ.get("MAXC", "3000"))])
sys.exit(0 if o["status"] == "succeeded" else 1)
