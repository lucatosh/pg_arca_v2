#!/bin/bash
# Lab helper: look inside a stuck ephemeral (restore) instance on a node.  eph.sh <node>
n=${1:-pg2}
docker exec $n bash -c '
d=$(ls -d /var/tmp/pg_arca_scratch/eph-* | head -1); echo "dir=$d"; ls $d | head -30
echo "--- psql processes"; ps -eo pid,etime,args | grep -E "bin/psql" | grep -v grep | cut -c1-300
echo "--- log tail"; for f in $d/log/* $d/*.log $d/postmaster.log; do [ -f "$f" ] && { echo "[$f]"; tail -8 "$f" | cut -c1-300; }; done
port=$(head -4 $d/postmaster.pid | tail -1); echo "port=$port"
su postgres -c "psql -h $d/.s -p $port -U postgres -d shop -Atc \"select pg_is_in_recovery(), pg_is_wal_replay_paused(), now()\"" 2>&1 | head -3
su postgres -c "psql -h $d/.s -p $port -U postgres -d postgres -Atc \"select pid,state,wait_event_type,wait_event,left(query,150) from pg_stat_activity where backend_type=$$client backend$$\"" 2>&1 | head
'
