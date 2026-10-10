#!/bin/bash
# Lab scenario: cluster administration through the console API: switchover (explicit + automatic candidate), restart of a replica, reload, reinit, pause/resume, failover, per-node views
cd "$(dirname "$0")"; A="python3 op.py arca-lab"; ok=0; bad=0
step() { echo; echo "=== $*"; }
chk() { if [[ $1 == 0 ]]; then ok=$((ok+1)); echo "PASS: $2"; else bad=$((bad+1)); echo "FAIL: $2"; fi; }
members() { docker exec pg1 patronictl -c /etc/patroni.yml list -f json 2>/dev/null || docker exec pg2 patronictl -c /etc/patroni.yml list -f json; }
leader() { members | python3 -c "import sys,json;print([m['Member'] for m in json.load(sys.stdin) if m['Role']=='Leader'][0])"; }
other() { members | python3 -c "import sys,json;print([m['Member'] for m in json.load(sys.stdin) if m['Role']!='Leader' and m['State'] in ('streaming','running')][0])"; }
L=$(leader); C=$(other); echo "leader=$L candidate=$C"; docker exec pg1 patronictl -c /etc/patroni.yml list | tail -6
step "switchover $L -> $C"; $A patroni_switchover "{\"leader\":\"$L\",\"candidate\":\"$C\"}" --wait 120; chk $? "switchover explicit"
sleep 10; echo "now leader=$(leader)"; [[ $(leader) == "$C" ]]; chk $? "leader changed to $C"
L2=$(leader); step "switchover without candidate (automatic)"; $A patroni_switchover "{\"leader\":\"$L2\"}" --wait 120; chk $? "switchover auto candidate"
sleep 10; echo "now leader=$(leader)"
R=$(other); step "restart replica $R"; $A patroni_restart "{\"member\":\"$R\"}" --wait 120; chk $? "restart member"
step "reload patroni"; $A patroni_reload '{}' --wait 60; chk $? "patroni reload"
sleep 5; R=$(other); step "reinit replica $R"; $A patroni_reinit "{\"member\":\"$R\"}" --wait 300; chk $? "reinit replica"
sleep 20; docker exec pg1 patronictl -c /etc/patroni.yml list | tail -6
step "pause on"; $A patroni_pause '{"enable":true}' --wait 60; chk $? "pause"
step "pause off"; $A patroni_pause '{"enable":false}' --wait 60; chk $? "resume"
echo; echo "SUMMARY pass=$ok fail=$bad"
