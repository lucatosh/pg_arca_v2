#!/usr/bin/env python3
"""Lab: configure the backup server bk1 and the backups of the geo pair like at a customer, then prove it works.
  1. bk1 (operational machine): roles repository + recovery, a label;
  2. folder 'geo' (both sites): strategy 'Produzione standard', recovery instance on bk1 (central placement);
  3. full backup of the PRIMARY site through the console, catalogue visible from both sites (one stanza per database);
  4. restore plan + DR drill (full recovery test) of the newest set on bk1, without touching the sites.
usage (VM): python3 tools/lab/setup-geo-backup.py"""
import http.cookiejar, json, os, time, urllib.request, uuid
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
def run(cid, typ, params, wait=3600):
    s, d = call("POST", "/api/clusters/%s/operations" % cid, {"type": typ, "params": params})
    if s >= 300: return {"status": "refused", "error": json.dumps(d)[:400]}
    o = d.get("operation") or {}; t0 = time.time()
    while time.time() - t0 < wait:
        s, x = call("GET", "/api/operations/" + o["id"]); o = x.get("operation", x)
        if o.get("status") in ("succeeded", "failed", "cancelled", "expired"): break
        time.sleep(5)
    o["_sec"] = round(time.time() - t0, 1); return o
call("POST", "/api/auth/login", {"username": U, "password": P})
s, d = call("GET", "/api/clusters"); ids = dict((c["name"], c["id"]) for c in d["clusters"])
s, w = call("GET", "/api/workers"); bk = next((x for x in w.get("workers", []) if x["name"] == "bk1"), None)
print("== 1. backup server bk1:", bk and {k: bk.get(k) for k in ("id", "online", "roles", "pgMajors")})
check("bk1 is an online operational machine", bool(bk and bk.get("online")))
if bk:
    s, d = call("PATCH", "/api/workers/%s" % bk["id"], {"label": "Backup server (lab)", "roles": ["repository", "recovery"]}); check("roles set", s == 200, str(d)[:200])
print("== 2. strategy and recovery instance for folder geo")
s, d = call("PUT", "/api/policies/assignments", {"scope": "folder", "key": "geo", "templateId": "prod-standard"}); check("strategy Produzione standard on folder geo", s == 200, str(d)[:200])
if bk:
    s, d = call("PUT", "/api/scoped/ephemeral/assignments", {"scope": "folder", "key": "geo", "value": {"placement": "central", "centralNode": bk["id"]}}); check("recovery instance on bk1 for folder geo", s == 200, str(d)[:300])
s, pl = call("GET", "/api/clusters/%s/placement" % ids["geo-dc1"]); print("   placement:", json.dumps(pl)[:500])
print("== 3. full backup of the primary site")
o = run(ids["geo-dc1"], "backup_run", {"type": "full"})
check("full backup on geo-dc1 in %ss" % o.get("_sec"), o.get("status") == "succeeded", str(o.get("error"))[:400])
time.sleep(30)
s, b1 = call("GET", "/api/clusters/%s/backups" % ids["geo-dc1"]); s2, b2 = call("GET", "/api/clusters/%s/backups" % ids["geo-dc2"])
cnt = lambda b: (b.get("backup") or {}).get("sets") if isinstance((b.get("backup") or {}).get("sets"), int) else len((b.get("backup") or {}).get("sets") or b.get("sets") or [])
n1, n2 = cnt(b1), cnt(b2)
check("catalogue visible from both sites (%d / %d sets)" % (n1, n2), n1 >= 1 and n2 >= 1 and n1 == n2, json.dumps(b2)[:300])
print("== 4. restore plan and DR drill on bk1")
o = run(ids["geo-dc1"], "restore_plan", {"scope": "database", "database": "postgres", "new_name": "postgres_pitr"}, 600)
r = o.get("result") or {}
check("restore plan", o.get("status") == "succeeded", str(o.get("error"))[:300])
print("   pre-flight:", [(c.get("id"), c.get("level"), c.get("text", "")[:100]) for c in (r.get("preflight") or {}).get("checks", [])])
o = run(ids["geo-dc1"], "restore_drill", {}, 3600)
r = o.get("result") or {}
check("DR drill in %ss" % o.get("_sec"), o.get("status") == "succeeded", str(o.get("error"))[:400])
print("   drill:", json.dumps({k: r.get(k) for k in ("ok", "node", "recovered_to", "duration_sec", "rto_sec", "where", "checks") if k in r})[:600], "| ran on node", o.get("nodeId"), "bk1 =", bk and bk["id"])
check("drill ran on bk1", bool(bk) and o.get("nodeId") == bk["id"])
print("%d/%d checks passed" % (sum(OK), len(OK)))
