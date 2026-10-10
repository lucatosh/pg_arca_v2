#!/bin/bash
# Lab helper: what are the nodes' agents doing right now?  where.sh  (needs docker access)
for n in pg1 pg2 pg3; do echo "== $n"; docker exec $n ps -eo pid,etime,args 2>/dev/null | grep -E 'eph-|pg_arca_agent|pg_basebackup' | grep -v grep | cut -c1-200 | tail -5; docker exec $n tail -3 /var/log/pgarca/agent.out | cut -c1-260; done
