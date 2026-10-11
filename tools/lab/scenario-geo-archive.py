#!/usr/bin/env python3
"""Lab: archive fallback of the standby site. Enable it through the console (one click = agent op geo_archive_fallback), check the DCS, then CUT THE WAN:
rows written on DC1 must still reach DC2 through the shared WAL archive (restore_command), and streaming must resume when the WAN is back.
usage (VM): sg docker python3 tools/lab/scenario-geo-archive.py"""
import http.cookiejar, json, os, subprocess, time, urllib.request, uuid
BASE = os.environ.get("PG_ARCA_URL", "http://localhost:3000")
U = os.environ.get("ARCA_USER", "claude-test"); P = os.environ.get("ARCA_PASS", "claude-lab-test-pass-1")
jar = http.cookiejar.CookieJar(); opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
HERE = os.path.dirname(os.path.abspath(__file__))
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
print("== enable the archive fallback on geo-dc2 (console op)")
s, d = call("POST", "/api/clusters/%s/operations" % ids["geo-dc2"], {"type": "geo_archive_fallback", "params": {"enable": True}})
o = d.get("operation") or {}
for _ in range(60):
    s, x = call("GET", "/api/operations/" + o.get("id", "x")); o = x.get("operation", x)
    if o.get("status") in ("succeeded", "failed"): break
    time.sleep(2)
check("op succeeded", o.get("status") == "succeeded", str(o.get("error") or o.get("result"))[:300])
l2 = leader("dc2")
cfg = json.loads(sh("docker exec %s curl -s localhost:8008/config" % l2) or "{}")
rc = (cfg.get("standby_cluster") or {}).get("restore_command")
check("restore_command in DC2's DCS", bool(rc), str(rc))
time.sleep(20)
print("== WAN cut: DC2 must keep up through the archive")
l1 = leader("dc1")
psql(l1, "CREATE TABLE IF NOT EXISTS geo_arch(id bigserial, at timestamptz default now())")
time.sleep(5)
print("  ", sh("cd %s && ./geo.sh wan-cut 2>&1" % HERE))
time.sleep(70)                                     # wal_receiver_timeout: the standby leader notices the WAN is gone
print("   receiver after the cut:", psql(l2, "SELECT coalesce(status,'none') FROM pg_stat_wal_receiver") or "none")
tok = int(time.time())
psql(l1, "INSERT INTO geo_arch(id) SELECT %d::bigint*1000+g FROM generate_series(1,500) g" % tok)
psql(l1, "SELECT pg_switch_wal()"); time.sleep(3); psql(l1, "SELECT pg_switch_wal()")
seen = "0"
for _ in range(60):
    seen = psql(l2, "SELECT count(*) FROM geo_arch WHERE id > %d::bigint*1000" % tok) or "0"
    if seen == "500": break
    time.sleep(3)
rcv = psql(l2, "SELECT coalesce(status,'none') FROM pg_stat_wal_receiver") or "none"
check("rows written on DC1 during the WAN cut reached DC2 through the archive (%s/500, receiver %s)" % (seen, rcv), seen == "500" and rcv != "streaming")
print("  ", sh("cd %s && ./geo.sh wan-restore 2>&1" % HERE))
print("== WAN back: streaming resumes")
st = ""
for _ in range(60):
    st = psql(l2, "SELECT status FROM pg_stat_wal_receiver")
    if st == "streaming": break
    time.sleep(3)
check("streaming again", st == "streaming", st)
print("%d/%d checks passed" % (sum(OK), len(OK)))
