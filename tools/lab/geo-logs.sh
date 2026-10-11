#!/bin/bash
# Lab helper: what Patroni / PostgreSQL say on the geo nodes (rewind, timelines, errors).   bash geo-logs.sh [nodes...]
for n in ${@:-dc1-pg1 dc1-pg2 dc2-pg1 dc2-pg2}; do
  echo "=== $n ($(docker exec $n patroni --version 2>/dev/null))"
  docker exec $n bash -c 'grep -iE "rewind|timeline|diverg|basebackup|reinit|bootstrap|ERROR|WARN|FATAL" /var/log/patroni/patroni.log | tail -n 8; echo "-- pg"; tail -n 6 /var/lib/postgresql/data/pgdata/log/postgresql.log 2>/dev/null' 2>&1 | cut -c1-260
done
