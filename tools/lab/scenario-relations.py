#!/usr/bin/env python3
"""Lab: primary/standby relations between clusters: detected by themselves, excluded by the operator ('nessuna relazione'), declared by hand,
and a declaration towards a DIFFERENT database reported as impossible.   usage (VM): python3 tools/lab/scenario-relations.py"""
import http.cookiejar, json, os, urllib.request, uuid, time
BASE = os.environ.get("PG_ARCA_URL", "http://localhost:3000")
U = os.environ.get("ARCA_USER", "claude-test"); P = os.environ.get("ARCA_PASS", "claude-lab-test-pass-1")
jar = http.cookiejar.CookieJar(); opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(m, path, body=None):
    r = urllib.request.Request(BASE + path, method=m, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json", "Idempotency-Key": str(uuid.uuid4())})
    try:
        with opener.open(r, timeout=60) as x: return x.status, json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e:
        t = e.read()
        try: return e.code, json.loads(t)
        except Exception: return e.code, {"raw": t[:300].decode(errors="replace")}
OK = []
def check(name, cond, extra=""):
    OK.append(bool(cond)); print("   %s %s %s" % ("PASS" if cond else "FAIL", name, extra), flush=True)
call("POST", "/api/auth/login", {"username": U, "password": P})
def cl():
    s, d = call("GET", "/api/clusters"); return dict((c["name"], c) for c in d["clusters"])
c = cl(); D1, D2 = c["geo-dc1"]["id"], c["geo-dc2"]["id"]
other = next((x for n, x in c.items() if not n.startswith("geo-") and not x.get("isSandbox")), None)
g2 = c["geo-dc2"].get("geo") or {}
check("detected: geo-dc2 is a standby site of geo-dc1", g2.get("role") == "standby" and any(p["clusterId"] == D1 and p["role"] == "primary" for p in g2.get("peers", [])), json.dumps(g2)[:200])
print("== 'nessuna relazione' on geo-dc2")
s, d = call("PUT", "/api/clusters/%s/geo-link" % D2, {"none": True}); check("accepted", s == 200, str(d)[:200])
c = cl(); check("geo-dc2 no longer paired", not c["geo-dc2"].get("geo"), json.dumps(c["geo-dc2"].get("geo"))[:200])
check("geo-dc1 no longer shows a replica", not (c["geo-dc1"].get("geo") or {}).get("peers"), json.dumps(c["geo-dc1"].get("geo"))[:200])
print("== back to automatic")
s, d = call("PUT", "/api/clusters/%s/geo-link" % D2, {}); c = cl()
check("paired again automatically", (c["geo-dc2"].get("geo") or {}).get("role") == "standby")
print("== cycle refused")
s, d = call("PUT", "/api/clusters/%s/geo-link" % D2, {"primary": D1}); check("declared dc2 -> dc1", s == 200)
s, d = call("PUT", "/api/clusters/%s/geo-link" % D1, {"primary": D2}); check("dc1 -> dc2 refused as a cycle", s == 400 and d.get("error") == "cycle", str(d)[:200])
call("PUT", "/api/clusters/%s/geo-link" % D2, {})
if other:
    print("== declared towards a different database (%s)" % other["name"])
    s, d = call("PUT", "/api/clusters/%s/geo-link" % other["id"], {"primary": D1}); time.sleep(1)
    c = cl(); g = c[other["name"]].get("geo") or {}
    check("reported as impossible", g.get("health") == "bad" and any("diverso" in p or "different" in p for p in g.get("problems", [])), json.dumps(g)[:300])
    call("PUT", "/api/clusters/%s/geo-link" % other["id"], {})
    c = cl(); check("cleared", not c[other["name"]].get("geo"))
print("%d/%d checks passed" % (sum(OK), len(OK)))
