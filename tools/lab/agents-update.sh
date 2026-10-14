#!/bin/bash
# Lab: update every agent the console reports as outdated (Docker containers on this VM or Proxmox containers), with the console's own upgrade command.
#   tools/lab/agents-update.sh            (console on localhost:3000, user from ARCA_USER / ARCA_PASS)
set -uo pipefail
cd "$(dirname "$0")"
BASE=${PG_ARCA_URL:-http://localhost:3000}; U=${ARCA_USER:-claude-test}; P=${ARCA_PASS:-claude-lab-test-pass-1}
jar=$(mktemp); trap 'rm -f "$jar"' EXIT
curl -fsS -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$U\",\"password\":\"$P\"}" "$BASE/api/auth/login" >/dev/null || { echo "login failed"; exit 1; }
curl -fsS -b "$jar" "$BASE/api/nodes" | python3 -c '
import json, sys
for n in json.load(sys.stdin).get("nodes", []):
    if n.get("agentOutdated") and n.get("upgradeCommand") and n.get("online"):
        print(n["name"] + "\t" + n["upgradeCommand"])' | while IFS=$'\t' read -r name cmd; do
  # the command runs as root inside the node: drop sudo, keep the console URL the node already uses
  c=${cmd/| sudo /| }
  if ./ui/node.sh "$name" "$c" </dev/null >/tmp/agent-update-$name.log 2>&1; then echo "== $name updated"; else echo "== $name FAILED (see /tmp/agent-update-$name.log)"; fi
done
