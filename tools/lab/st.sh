#!/bin/bash
# Lab helper: quick state.  st.sh  -> patroni list, last operations, agent log tails
cd "$(dirname "$0")"
docker exec pg1 patronictl -c /etc/patroni.yml list 2>&1 | tail -7
python3 op.py last 6
for n in pg1 pg2 pg3; do echo "-- $n"; docker exec $n tail -n 3 /var/log/pgarca/agent.out | cut -c1-240; done
