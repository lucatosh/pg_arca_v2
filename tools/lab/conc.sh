#!/bin/bash
# Lab scenario: backups with a SPREAD checkpoint (start_fast=false) on a server with dirty buffers: progress phase, cancel latency, and two requests at once.
cd "$(dirname "$0")/../.."; T=tools/lab
$T/q.sh shop "insert into customers(name,email) select 'x'||g,'x'||g||'@y.it' from generate_series(1,40000) g; update customers set email=email||'.'" >/dev/null
$T/q.sh postgres "alter system set checkpoint_timeout='1h'" >/dev/null; $T/q.sh postgres "select pg_reload_conf()" >/dev/null
echo "== A: spread checkpoint, cancel after ~12s"
python3 $T/op.py arca-lab backup_run '{"type":"incr","start_fast":false}' --wait 200 > /tmp/conc1.log 2>&1 &
sleep 8; python3 $T/opstat.py | grep -E "ACTIVE"; python3 $T/opstat.py backup_run | tail -4 | head -3
id=$(python3 $T/opstat.py | grep ACTIVE | grep -o "'[0-9a-f]\{6\}'" | head -1 | tr -d "'")
full=$(python3 - <<'PY'
import json;s=json.load(open('data/state.json'));print([o['id'] for o in s['operations'] if o['status'] in ('leased','running')][-1])
PY
); echo "cancelling $full"; date -u +%T; $T/api.sh POST /api/operations/$full/cancel | head -c 100; echo
wait; date -u +%T; head -3 /tmp/conc1.log
echo "== B: start_fast=true (default of the UI)"
python3 $T/op.py arca-lab backup_run '{"type":"incr","start_fast":true}' --wait 200 | head -4
$T/q.sh postgres "alter system reset checkpoint_timeout" >/dev/null; $T/q.sh postgres "select pg_reload_conf()" >/dev/null
