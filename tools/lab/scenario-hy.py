#!/usr/bin/env python3
"""Lab "hy": geo-redundant pair Docker (hy-mi, primary) + Proxmox (hy-rm, standby), Rocky 9 + PGDG + Patroni, shared NFS archive.
Everything through the console, as an operator would (the same API calls the pages make):
  setup     shared destination on NFS for both sites, WAL archiving on both (DCS) + Patroni restarts, endpoints of the sites, readiness, full backup
  switch    planned switchover hy-mi -> hy-rm and back: no row lost, the old primary follows the new one, the right slot active
  dr        automatic failover: rows written, the whole primary site dies (hy.sh kill-a), the standby site is promoted BY THE CONSOLE with the most
            recent WAL; then the old site comes back (start-a) and is realigned as a replica of the new primary by itself; then a switchover back
  wan       the standby site loses the link to the primary site (hy.sh wan-cut) for longer than the confirmation time: NO failover (the console still
            sees the primary site); link restored
usage (VM, docker group):  python3 tools/lab/scenario-hy.py setup,switch,dr,wan"""
import http.cookiejar, json, os, subprocess, sys, time, urllib.request, uuid
BASE = os.environ.get("PG_ARCA_URL", "http://localhost:3000")
U = os.environ.get("ARCA_USER", "claude-test"); P = os.environ.get("ARCA_PASS", "claude-lab-test-pass-1")
HERE = os.path.dirname(os.path.abspath(__file__)); HY = os.path.join(HERE, "hy.sh")
jar = http.cookiejar.CookieJar(); opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
WHICH = (sys.argv[1] if len(sys.argv) > 1 else "setup,switch,dr,wan").split(",")


def call(m, path, body=None, key=None):
    r = urllib.request.Request(BASE + path, method=m, data=json.dumps(body).encode() if body is not None else None,
                               headers={"content-type": "application/json", "Idempotency-Key": key or str(uuid.uuid4())})
    try:
        with opener.open(r, timeout=60) as x:
            return x.status, json.loads(x.read() or b"{}")
    except urllib.error.HTTPError as e:
        t = e.read()
        try:
            return e.code, json.loads(t)
        except Exception:
            return e.code, {"raw": t[:300].decode(errors="replace")}


def sh(c, timeout=600):
    return subprocess.run(c, shell=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


OK = []


def check(name, cond, extra=""):
    OK.append(bool(cond)); log("  %s %s %s" % ("PASS" if cond else "FAIL", name, extra))
    return bool(cond)


def run(cid, typ, params, wait=1800, node=None):
    s, d = call("POST", "/api/clusters/%s/operations" % cid, {"type": typ, "params": params, **({"nodeId": node} if node else {})})
    if s >= 300:
        return {"status": "refused", "error": json.dumps(d)[:500]}
    if d.get("approval"):
        return {"status": "approval", "error": json.dumps(d)[:300]}
    o = d.get("operation") or {}; t0 = time.time()
    while time.time() - t0 < wait:
        s, x = call("GET", "/api/operations/" + o["id"]); o = x.get("operation", x)
        if o.get("status") in ("succeeded", "failed", "cancelled", "expired"):
            break
        time.sleep(3)
    o["_sec"] = round(time.time() - t0, 1)
    return o


def sql(site, q):
    return sh("%s sql-%s %s" % (HY, site, json.dumps(q).replace("$", "\\$")), 120)


def clusters():
    s, d = call("GET", "/api/clusters")
    out = {}
    for c in d["clusters"]:
        names = [n["name"] for n in c.get("agentNodes") or []]
        if "hy1" in names or "hy2" in names:
            out["a"] = c
        if "hyb1" in names or "hyb2" in names:
            out["b"] = c
    return out


def group():
    s, g = call("GET", "/api/geo")
    for x in g.get("groups", []):
        ids = [y["clusterId"] for y in x["sites"]]
        if C["a"]["id"] in ids or C["b"]["id"] in ids:
            return x
    return {}


def wait_job(jid, wait=900):
    t0 = time.time(); j = {}
    while time.time() - t0 < wait:
        s, g = call("GET", "/api/geo"); j = next((x for x in g.get("jobs", []) if x["id"] == jid), {})
        if j.get("status") in ("succeeded", "failed"):
            break
        time.sleep(3)
    for st in j.get("steps", []):
        log("     ", st.get("status", ""), st.get("text", ""))
    return j, round(time.time() - t0)


def primary_site():
    g = group(); p = g.get("primary")
    return "a" if p == C["a"]["id"] else "b" if p == C["b"]["id"] else None


call("POST", "/api/auth/login", {"username": U, "password": P})
C = clusters()
if "a" not in C or "b" not in C:
    sys.exit("both sites must be in the console (agents installed): found %s" % list(C))
log("hy-mi = %s (%s), hy-rm = %s (%s)" % (C["a"]["name"], C["a"]["id"], C["b"]["name"], C["b"]["id"]))
s, adv = call("GET", "/api/advanced"); log("four-eyes approvals:", adv.get("approvals"))

if "setup" in WHICH:
    log("== setup: shared destination on NFS for the database (both sites)")
    for k in ("a", "b"):
        s, d = call("PUT", "/api/scoped/destination/assignments", {"scope": "cluster", "key": C[k]["id"], "value": {"type": "nfs", "repoPath": "/mnt/arca/pgarca", "walPath": "/mnt/arca/wal/hy", "requireMount": True}})
        check("destination assigned to %s" % C[k]["name"], s == 200, json.dumps(d)[:300])
        s, d = call("GET", "/api/clusters/%s/destination" % C[k]["id"])
        check("no WAL collision between the two sites of one database", not (d.get("configured") or d.get("destination") or {}).get("wal_collision"), json.dumps(d)[:400])
        s, d = call("POST", "/api/clusters/%s/destination/check" % C[k]["id"], {})
        check("destination check submitted on %s" % C[k]["name"], s == 202, json.dumps(d)[:300])
        for o in d.get("operations", []):
            oid = o["operation"]["id"]; t0 = time.time()
            while time.time() - t0 < 300:
                s, x = call("GET", "/api/operations/" + oid); x = x.get("operation", x)
                if x.get("status") in ("succeeded", "failed", "expired"):
                    break
                time.sleep(3)
            check("  check on %s: %s" % (o["nodeName"], x.get("status")), x.get("status") == "succeeded" and (x.get("result") or {}).get("ok", True), json.dumps(x.get("result") or x.get("error"))[:400])
        s, d = call("POST", "/api/clusters/%s/destination/apply" % C[k]["id"], {})
        check("destination applied on %s" % C[k]["name"], s in (200, 202), json.dumps(d)[:400])
    log("== setup: WAL archiving on both sites (through each site's DCS), then Patroni restarts")
    for k in ("a", "b"):
        o = run(C[k]["id"], "archive_enable", {})
        r = o.get("result") or {}
        check("archive_enable on %s (%s)" % (C[k]["name"], r.get("via")), o.get("status") == "succeeded", str(o.get("error"))[:400])
        if r.get("restart_required"):
            nodes = sorted(clusters()[k].get("agentNodes") or [], key=lambda n: 0 if n.get("role") != "primary" and n.get("role") != "standby_leader" else 1)
            for n in nodes:
                o2 = run(C[k]["id"], "patroni_restart", {"member": n["name"]}, 300)
                check("  Patroni restart of %s" % n["name"], o2.get("status") == "succeeded", str(o2.get("error"))[:300])
    log("== setup: how the sites reach each other (the leader endpoints)")
    check("endpoint hy-mi", call("PUT", "/api/clusters/%s/geo-endpoint" % C["a"]["id"], {"host": "192.168.1.179", "port": 15432})[0] == 200)
    check("endpoint hy-rm", call("PUT", "/api/clusters/%s/geo-endpoint" % C["b"]["id"], {"host": "192.168.1.232", "port": 5000})[0] == 200)
    time.sleep(30)
    g = group()
    check("one geo pair, hy-mi primary", g.get("primary") == C["a"]["id"], json.dumps([(x["name"], x["role"], x.get("health")) for x in g.get("sites", [])]))
    for c in (g.get("readiness") or {}).get("checks", []):
        log("     readiness %-5s %s" % (c["level"], c["text"][:160]))
    log("== setup: full backup of the database (primary site) into the shared repository")
    o = run(C["a"]["id"], "backup_run", {"type": "full", "start_fast": True}, 3600)
    check("full backup in %ss" % o.get("_sec"), o.get("status") == "succeeded", str(o.get("error"))[:400])

if "switch" in WHICH:
    for src, dst in (("a", "b"), ("b", "a")):
        log("== switchover %s -> %s" % (C[src]["name"], C[dst]["name"]))
        sql(src, "CREATE TABLE IF NOT EXISTS hy_sw(id bigserial primary key, site text, at timestamptz default now())")
        sql(src, "INSERT INTO hy_sw(site) SELECT '%s' FROM generate_series(1,1000)" % src)
        before = int(sql(src, "SELECT count(*) FROM hy_sw") or 0)
        s, d = call("POST", "/api/geo/switchover", {"from": C[src]["id"], "to": C[dst]["id"], "confirm": "SWITCHOVER"})
        if not check("switchover accepted", s == 202 and d.get("job"), json.dumps(d)[:400]):
            break
        j, sec = wait_job(d["job"]["id"])
        check("job succeeded in %d s" % sec, j.get("status") == "succeeded", j.get("error") or "")
        time.sleep(15)
        after = int(sql(dst, "SELECT count(*) FROM hy_sw") or 0)
        check("no row lost (%d before, %d on the new primary)" % (before, after), after >= before)
        sql(dst, "INSERT INTO hy_sw(site) VALUES ('%s')" % dst)
        seen = ""
        for _ in range(45):
            seen = sql(src, "SELECT count(*) FROM hy_sw WHERE site='%s'" % dst)
            if seen.isdigit() and int(seen) >= 1:
                break
            time.sleep(2)
        check("the old primary %s follows the new one" % C[src]["name"], seen.isdigit() and int(seen) >= 1, seen)
        check("console: %s is the primary site" % C[dst]["name"], primary_site() == dst)

if "dr" in WHICH:
    g = group(); key = g.get("sysid")
    s, d = call("PUT", "/api/geo/policy/%s" % key, {"autoFailover": True, "confirmSec": 30, "maxLossMB": 16, "autoRejoin": True})
    check("automatic failover on (30 s, max 16 MB)", s == 200, json.dumps(d)[:300])
    p0 = primary_site(); sb = "b" if p0 == "a" else "a"
    if p0 != "a":
        log("   (primary is %s: the disaster is simulated on the Docker site only, switch back first)" % p0)
    else:
        sql("a", "CREATE TABLE IF NOT EXISTS hy_dr(id bigserial primary key, at timestamptz default now())")
        sql("a", "INSERT INTO hy_dr SELECT FROM generate_series(1,5000)")
        last = sql("a", "INSERT INTO hy_dr DEFAULT VALUES RETURNING id")
        n0 = int(sql("a", "SELECT count(*) FROM hy_dr") or 0)
        log("   %d rows committed on hy-mi (last id %s): the whole site goes down NOW" % (n0, last))
        jobs0 = set(x["id"] for x in call("GET", "/api/geo")[1].get("jobs", []))
        log("  ", sh("%s kill-a" % HY))
        t0 = time.time(); fj = None
        while time.time() - t0 < 600:
            s, gg = call("GET", "/api/geo")
            fj = next((x for x in gg.get("jobs", []) if x.get("type") == "failover_auto" and x.get("to") == C["b"]["id"] and x["id"] not in jobs0), None)
            w = next((x.get("watch") for x in gg.get("groups", []) if x.get("sysid") == key), None)
            if fj and fj.get("status") in ("succeeded", "failed", "held"):
                break
            time.sleep(5)
        log("   failover job:", json.dumps({k: (fj or {}).get(k) for k in ("id", "type", "status", "error")}))
        for st in (fj or {}).get("steps", []):
            log("     ", st.get("status", ""), st.get("text", ""))
        check("automatic failover done by the console in %d s" % (time.time() - t0), bool(fj) and fj.get("status") == "succeeded")
        n1 = int(sql("b", "SELECT count(*) FROM hy_dr") or 0)
        check("no committed row lost: %d on hy-rm, %d committed on hy-mi" % (n1, n0), n1 >= n0)
        sql("b", "INSERT INTO hy_dr DEFAULT VALUES")
        check("hy-rm is writable", int(sql("b", "SELECT count(*) FROM hy_dr") or 0) == n1 + 1)
        log("== the old site comes back: it must become a replica of hy-rm by itself")
        log("  ", sh("%s start-a" % HY))
        t0 = time.time(); seen = ""
        while time.time() - t0 < 900:
            seen = sql("a", "SELECT count(*) FROM hy_dr")
            if seen.isdigit() and int(seen) >= n1 + 1:
                break
            time.sleep(10)
        check("hy-mi realigned as replica of hy-rm in %d s (%s rows)" % (time.time() - t0, seen), seen.isdigit() and int(seen) >= n1 + 1)
        log("  ", sh("%s status" % HY)[-1500:])
        s, gg = call("GET", "/api/geo"); grp = next((x for x in gg.get("groups", []) if x.get("sysid") == key), {})
        check("console: hy-rm primary, failover marked rejoined", grp.get("primary") == C["b"]["id"] and (grp.get("failover") or {}).get("rejoinedAt"), json.dumps(grp.get("failover"))[:300])
        log("== switchover back to hy-mi")
        s, d = call("POST", "/api/geo/switchover", {"from": C["b"]["id"], "to": C["a"]["id"], "confirm": "SWITCHOVER"})
        if check("switchover back accepted", s == 202, json.dumps(d)[:300]):
            j, sec = wait_job(d["job"]["id"])
            check("switchover back in %d s" % sec, j.get("status") == "succeeded", j.get("error") or "")

if "wan" in WHICH:
    g = group(); key = g.get("sysid")
    call("PUT", "/api/geo/policy/%s" % key, {"autoFailover": True, "confirmSec": 30})
    p0 = primary_site()
    log("== WAN cut for 120 s (primary %s): the console still sees the primary site, no failover allowed" % p0)
    log("  ", sh("%s wan-cut" % HY))
    t0 = time.time(); jobs0 = set(x["id"] for x in call("GET", "/api/geo")[1].get("jobs", []))
    w = None
    while time.time() - t0 < 120:
        s, gg = call("GET", "/api/geo"); grp = next((x for x in gg.get("groups", []) if x.get("sysid") == key), {})
        w = grp.get("watch") or w
        time.sleep(10)
    log("  ", sh("%s wan-restore" % HY))
    s, gg = call("GET", "/api/geo"); new = [x for x in gg.get("jobs", []) if x["id"] not in jobs0]
    check("no failover during the WAN cut", not new and primary_site() == p0, json.dumps(new)[:400])
    log("   watch seen:", json.dumps(w)[:400])

print("%d/%d checks passed" % (sum(OK), len(OK)))
sys.exit(0 if all(OK) else 1)
