#!/bin/bash
# Lab: resume the big scenario after an interruption: wait until solo1 has no data operation running, free the WAL of the load (retention 1 full), run the given steps, then the matrix.
# usage (VM): nohup sg docker tools/lab/big-resume.sh "diff,damage,..." > /tmp/big-resume.log 2>&1 &
cd "$(dirname "$0")" || exit 1
pkill -f "scenario-big.py" 2>/dev/null; pkill -f big-after-load.sh 2>/dev/null
CL=$(./api.sh GET /api/clusters | jq -r '.clusters[] | select(.name|test("solo")) | .id' | head -1)
while ./api.sh GET "/api/clusters/$CL/activity" | jq -e '.activity | length > 0' >/dev/null; do sleep 15; done
echo "idle at $(date)"; python3 scenario-big.py expire0 >> /tmp/big-scn.log 2>&1
python3 scenario-big.py "${1:-diff,damage,forensics,plan,table,schema,database,live,instance,expire}" >> /tmp/big-scn.log 2>&1
echo "scenario finished at $(date)"
./matrix.sh 14 15 17 18 > /tmp/matrix-run.log 2>&1 < /dev/null; echo "matrix finished at $(date)"; cat /tmp/matrix-summary.txt
