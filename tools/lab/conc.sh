#!/bin/bash
# Lab scenario: two backups requested at the same moment (the UI allows it) + cancel of a running one. Shows whether they serialise and how fast cancel acts.
cd "$(dirname "$0")"
date -u +%T; python3 op.py arca-lab backup_run '{"type":"full"}' --wait 400 > /tmp/conc1.log 2>&1 &
sleep 0.5; python3 op.py arca-lab backup_run '{"type":"incr"}' --wait 400 > /tmp/conc2.log 2>&1 &
sleep 20; echo "--- after 20s:"; python3 opstat.py 2>/dev/null | grep -E "ACTIVE"
wait; date -u +%T; echo "== full"; head -3 /tmp/conc1.log; echo "== incr"; head -3 /tmp/conc2.log
