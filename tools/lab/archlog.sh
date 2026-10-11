#!/bin/bash
# Lab helper: archiver state and archive failures on every geo node.   bash archlog.sh
for n in dc1-pg1 dc1-pg2 dc2-pg1 dc2-pg2; do
  echo "== $n: $(docker exec $n curl -s localhost:8008/patroni | jq -c '{role, timeline}')"
  docker exec $n gosu postgres psql -XAtc "select archived_count, last_archived_wal, last_archived_time, failed_count, last_failed_wal, last_failed_time from pg_stat_archiver" 2>/dev/null
  docker exec $n bash -c 'grep -hE "archive command failed|archive_command|PGA-WAL|archiver" /var/lib/postgresql/data/pgdata/log/postgresql*.log 2>/dev/null | tail -n 6 | cut -c1-260'
  docker exec $n bash -c 'ls /var/lib/postgresql/data/pgdata/pg_wal/archive_status 2>/dev/null | grep -c ready'
done
