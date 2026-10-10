#!/bin/bash
# Lab: pull, deploy and run the restore scenarios in the background; the log is /tmp/scn.log.   usage (on the VM): sg docker tools/lab/run-scn.sh [database|schema|table|all]
cd "$(dirname "$0")/../.." || exit 1
pkill -f "[p]ython3 tools/lab/scenario-restore" 2>/dev/null
git pull -q --ff-only; git log --oneline | head -1
tools/lab/deploy.sh 2>&1 | tail -2
sleep 15
nohup python3 tools/lab/scenario-restore.py "${1:-all}" > /tmp/scn.log 2>&1 < /dev/null &
echo "started pid $!"
