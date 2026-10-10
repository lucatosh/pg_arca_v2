#!/bin/bash
# Lab scenario: backups taken FROM A REPLICA (offloading the primary), then verified and restored.
cd "$(dirname "$0")/../.."; T=tools/lab; ok=0; bad=0
chk() { if [[ $1 == 0 ]]; then ok=$((ok+1)); echo "PASS: $2"; else bad=$((bad+1)); echo "FAIL: $2"; fi; }
for n in pg3 pg1; do
  for t in full incr; do
    echo "=== $t from replica $n"; python3 $T/op.py arca-lab backup_run "{\"type\":\"$t\"}" --node $n --wait 400 | head -8; chk ${PIPESTATUS[0]} "$t backup from $n"
  done
done
echo "=== verify deep"; python3 $T/op.py arca-lab backup_verify '{"deep":true}' --wait 600 | head -5; chk ${PIPESTATUS[0]} "verify deep"
echo "=== restore drill (from latest, taken on a replica)"; python3 $T/op.py arca-lab restore_drill '{}' --wait 900 | head -8; chk ${PIPESTATUS[0]} "drill"
echo SUMMARY pass=$ok fail=$bad
