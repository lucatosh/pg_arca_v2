#!/bin/bash
# Lab helper: console health: recent log, process CPU/RSS, response time of a cheap and of a heavy endpoint, data dir size.
sudo journalctl -u pg-arca-console --since "${1:-15 min ago}" --no-pager | tail -n ${2:-40}
ps -o pid,pcpu,rss,etime,args -C node | cut -c1-160
cd "$(dirname "$0")"
for u in /api/auth/status /api/clusters /api/geo /api/health /api/operations?limit=50; do /usr/bin/time -f "$u %es" ./api.sh GET "$u" > /dev/null; done
sudo du -sh /opt/pg_arca_v2/data 2>/dev/null; sudo ls -la /opt/pg_arca_v2/data | head
