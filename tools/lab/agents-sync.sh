#!/bin/bash
# Lab: bring EVERY agent the console knows to the console's current build, then prove it.
#   tools/lab/agents-sync.sh            (console on localhost:3000, user from ARCA_USER / ARCA_PASS)
#
# 1. every online node the console reports as outdated gets the console's own upgrade command (what a customer runs), as root in its container
#    (Docker on this VM or Proxmox, see ui/node.sh); the command keeps configuration and credentials;
# 2. a container without systemd keeps the OLD agent process running after the reinstall: the agent process alone is restarted (its supervisor
#    loop, or the service, starts the new code; PostgreSQL / Patroni are never touched);
# 3. the console is asked again until every online node reports the current build (or the time is up), and a table says, node by node,
#    version, build, state. Exit 1 when an online node is still outdated (offline nodes are listed, not counted: they update when they are back).
set -uo pipefail
cd "$(dirname "$0")"
BASE=${PG_ARCA_URL:-http://localhost:3000}; U=${ARCA_USER:-claude-test}; P=${ARCA_PASS:-claude-lab-test-pass-1}; WAIT=${WAIT:-180}
jar=$(mktemp); trap 'rm -f "$jar"' EXIT
for i in $(seq 1 30); do curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break; sleep 2; done           # the console may just have been restarted
curl -fsS -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$U\",\"password\":\"$P\"}" "$BASE/api/auth/login" >/dev/null || { echo "login failed"; exit 1; }
nodes() { curl -fsS -b "$jar" "$BASE/api/nodes"; }
outdated() { nodes | python3 -c '
import json, sys
for n in json.load(sys.stdin).get("nodes", []):
    if n.get("agentOutdated") and n.get("online"):
        print(n["name"] + "\t" + (n.get("upgradeCommand") or ""))'; }

# 1. the console's upgrade command, in parallel (each node is independent)
outdated | while IFS=$'\t' read -r name cmd; do
  [ -n "$cmd" ] || { echo "== $name: no upgrade command from the console"; continue; }
  c=${cmd/| sudo /| }                                   # runs as root inside the node already
  ( if ./ui/node.sh "$name" "$c" </dev/null >/tmp/agent-sync-$name.log 2>&1; then echo "== $name: reinstalled"; else echo "== $name: reinstall FAILED (see /tmp/agent-sync-$name.log)"; fi ) &
done; wait

# 2. still outdated after a heartbeat or two: restart the agent process only (anchored pattern: never the supervising shell loop)
sleep 25
outdated | while IFS=$'\t' read -r name _; do
  ./ui/node.sh "$name" 'if command -v systemctl >/dev/null 2>&1 && systemctl list-units --type=service 2>/dev/null | grep -q pg-arca-agent; then
      systemctl restart $(systemctl list-units --type=service --no-legend 2>/dev/null | awk "/pg-arca-agent/{print \$1}") ;
    else pkill -f "^python3 /opt/pg-arca/pg-arca-agent.py" || pkill -f "^/usr/bin/python3 /opt/pg-arca/pg-arca-agent.py" || true; fi' </dev/null >>/tmp/agent-sync-$name.log 2>&1 \
    && echo "== $name: agent process restarted" || echo "== $name: restart FAILED (see /tmp/agent-sync-$name.log)"
done

# 3. proof: every online node on the current build
end=$((SECONDS + WAIT))
while [ $SECONDS -lt $end ] && [ -n "$(outdated)" ]; do sleep 10; done
nodes | python3 -c '
import json, sys
d = json.load(sys.stdin); want = d.get("consoleBuild")
bad = 0
print("%-22s %-14s %-14s %s" % ("NODE", "VERSION", "BUILD", "STATE"))
for n in sorted(d.get("nodes", []), key=lambda x: x["name"]):
    st = "offline" if not n.get("online") else ("OUTDATED" if n.get("agentOutdated") else "current")
    if st == "OUTDATED": bad += 1
    print("%-22s %-14s %-14s %s" % (n["name"], n.get("agentVersion") or "-", (n.get("agentBuild") or "-")[:12], st))
print("console build %s: %s" % (str(want)[:12], "every online agent is current" if not bad else "%d online agent(s) still outdated" % bad))
sys.exit(1 if bad else 0)'
