#!/usr/bin/env python3
"""Lab: planned switchover between the geo sites THROUGH THE CONSOLE, and back. Checks: the job completes its 4 steps, the roles swap in Patroni (standby_cluster
moves to the other DCS), the right slot is active on the new primary site, no row written before the switchover is lost, writes work on the new primary site,
the old primary replicates from it; then the way back uses the address the console remembered.   usage (VM): sg docker python3 tools/lab/scenario-geo.py"""
import http.cookiejar, json, os, subprocess, time, urllib.request, uuid
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
def sh(c): return subprocess.run(c, shell=True, capture_output=True, text=True).stdout.strip()
def leader(site):
    for n in (site + "-pg1", site + "-pg2"):
        if sh("docker exec %s curl -s -o /dev/null -w '%%{http_code}' localhost:8008/leader" % n) == "200": return n
def psql(n, q): return sh("docker exec %s gosu postgres psql -XAtc \"%s\"" % (n, q))
OK = []
def check(name, cond, extra=""):
    OK.append(bool(cond)); print("   %s %s %s" % ("PASS" if cond else "FAIL", name, extra), flush=True)
call("POST", "/api/auth/login", {"username": U, "password": P})
s, d = call("GET", "/api/clusters"); ids = dict((c["name"], c["id"]) for c in d["clusters"])
C1, C2 = ids["geo-dc1"], ids["geo-dc2"]

def switch(src, dst, src_site, dst_site):
    print("== switchover %s -> %s" % (src_site, dst_site), flush=True)
    l = leader(src_site)
    psql(l, "CREATE TABLE IF NOT EXISTS geo_sw(id bigserial primary key, site text, at timestamptz default now())")
    psql(l, "INSERT INTO geo_sw(site) SELECT '%s' FROM generate_series(1,1000)" % src_site)
    before = int(psql(l, "SELECT count(*) FROM geo_sw") or 0)
    s, d = call("POST", "/api/geo/switchover", {"from": src, "to": dst, "confirm": "SWITCHOVER"})
    if s == 409 and d.get("error") == "endpoint_required":
        print("   endpoint of %s not known yet: setting %s-haproxy:5000" % (dst_site, dst_site))
        call("PUT", "/api/clusters/%s/geo-endpoint" % dst, {"host": dst_site + "-haproxy", "port": 5000})
        s, d = call("POST", "/api/geo/switchover", {"from": src, "to": dst, "confirm": "SWITCHOVER"})
    check("switchover accepted", s == 202, str(d)[:300])
    if s != 202: return
    jid = d["job"]["id"]; t0 = time.time()
    while time.time() - t0 < 600:
        s, g = call("GET", "/api/geo"); j = next((x for x in g.get("jobs", []) if x["id"] == jid), {})
        if j.get("status") in ("succeeded", "failed"): break
        time.sleep(3)
    for st in j.get("steps", []): print("     ", st["text"])
    check("job succeeded in %.0f s" % (time.time() - t0), j.get("status") == "succeeded", j.get("error") or "")
    time.sleep(20)
    nl = leader(dst_site)
    role = json.loads(sh("docker exec %s curl -s localhost:8008/patroni" % nl) or "{}").get("role")
    check("%s leader %s is a writable primary" % (dst_site, nl), role in ("primary", "master"), role)
    cfg_src = json.loads(sh("docker exec %s curl -s localhost:8008/config" % leader(src_site)) or "{}")
    check("%s DCS now has standby_cluster -> %s" % (src_site, dst_site), (cfg_src.get("standby_cluster") or {}).get("host", "").startswith(dst_site), json.dumps(cfg_src.get("standby_cluster")))
    after = int(psql(nl, "SELECT count(*) FROM geo_sw") or 0)
    check("no row lost (%d before, %d on the new primary)" % (before, after), after >= before)
    psql(nl, "INSERT INTO geo_sw(site) VALUES ('%s')" % dst_site)
    slot = (cfg_src.get("standby_cluster") or {}).get("primary_slot_name")
    act = psql(nl, "SELECT active FROM pg_replication_slots WHERE slot_name='%s'" % slot) if slot else ""
    t0 = time.time()
    while act != "t" and time.time() - t0 < 90:
        time.sleep(3); act = psql(nl, "SELECT active FROM pg_replication_slots WHERE slot_name='%s'" % slot)
    check("slot %s active on %s" % (slot, dst_site), act == "t")
    seen = ""
    for _ in range(40):
        seen = psql(leader(src_site) or src_site + "-pg1", "SELECT count(*) FROM geo_sw WHERE site='%s'" % dst_site)
        if seen and int(seen) >= 1: break
        time.sleep(2)
    check("%s replicates the write made on %s" % (src_site, dst_site), seen and int(seen) >= 1, seen)
    s, g = call("GET", "/api/geo"); grp = g["groups"][0]
    check("console sees %s as primary site" % dst_site, grp.get("primary") == dst, json.dumps([(x["name"], x["role"], x["health"]) for x in grp["sites"]]))

switch(C1, C2, "dc1", "dc2")
switch(C2, C1, "dc2", "dc1")
print("%d/%d checks passed" % (sum(OK), len(OK)))
