#!/bin/bash
# Lab: wait until big.sh load has finished (its log ends with the database size), then start the timed scenario and, after it, the version matrix.
# usage (VM): nohup sg docker tools/lab/big-after-load.sh > /tmp/big-after.log 2>&1 &
cd "$(dirname "$0")" || exit 1
until tail -1 /tmp/big-load.log 2>/dev/null | grep -Eq '^[0-9]+ (MB|GB)$'; do sleep 20; done
echo "load finished: $(tail -1 /tmp/big-load.log) at $(date)"
python3 scenario-big.py > /tmp/big-scn.log 2>&1 < /dev/null
echo "scenario finished at $(date)"; tail -25 /tmp/big-scn.log
./matrix.sh 14 15 17 18 > /tmp/matrix-run.log 2>&1 < /dev/null
echo "matrix finished at $(date)"; cat /tmp/matrix-summary.txt
