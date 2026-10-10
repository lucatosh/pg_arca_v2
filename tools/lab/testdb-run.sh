#!/bin/bash
# Lab: backup + restore smoke on arca_restore_lab.   usage: tools/lab/testdb-run.sh [backup-type]   (run on the VM, after testdb.sh lab)
cd "$(dirname "$0")"
echo "== cluster"; python3 op.py - /api/clusters | python3 -c 'import sys,json;[print(c["id"],c["name"],c.get("source"),c.get("status")) for c in json.load(sys.stdin)["clusters"] if c.get("source")!="demo"]'
echo "== backup ${1:-incr}"; python3 op.py arca-lab backup_run "{\"type\":\"${1:-incr}\"}" --wait 600 | head -12
echo "== restore database (default target = latest)"; python3 op.py arca-lab restore_database '{"database":"arca_restore_lab","new_name":"arca_rl_latest"}' --wait 900 | head -30
echo "== restore database, target in the future (used to fail PGA-PITR-010)"; python3 op.py arca-lab restore_database "{\"database\":\"arca_restore_lab\",\"new_name\":\"arca_rl_future\",\"target_time\":\"$(date -u -d '+3 hours' +%Y-%m-%dT%H:%M:%SZ)\"}" --wait 900 | head -30
