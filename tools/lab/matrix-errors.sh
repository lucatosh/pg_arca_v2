#!/bin/bash
# Lab helper: the errors / failures of the matrix logs, with their traceback tail.   bash matrix-errors.sh [versions]
cat /tmp/matrix-summary.txt 2>/dev/null
for v in ${*:-14 15 16 17 18}; do f=/tmp/matrix-$v.log; [ -f "$f" ] || continue
  echo "=================== PG $v"
  awk '/^(ERROR|FAIL): /{p=1; n=0} p{print; n++} n>40{p=0}' "$f" | grep -vE '^\s*$' | cut -c1-260 | head -120
done
