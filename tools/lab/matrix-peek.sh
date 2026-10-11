#!/bin/bash
# Lab helper: what the running matrix container is doing (processes, ephemeral instance logs).   bash matrix-peek.sh
c=$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /^postgres:[0-9]+-/ {print $1; exit}')
[ -z "$c" ] && { echo "no matrix container"; exit 0; }
echo "== $c"
docker exec "$c" bash -c 'ps -eo pid,etime,pcpu,args | grep -E "python3|postgres -D|startup|restore|wal|pg-arca|sleep" | grep -v grep | cut -c1-240
for d in /tmp/pgarca-e2e-*/*/eph-* /tmp/pgarca-e2e-*/eph-*; do [ -d "$d" ] || continue; echo "== $d"; ls "$d" | head -30
  for f in $(find "$d" -maxdepth 2 -name "*.log" -o -maxdepth 2 -path "*log/*" -type f 2>/dev/null | head -5); do echo "-- $f"; tail -n 25 "$f" | cut -c1-240; done
  for f in "$d"/postgresql.auto.conf "$d"/recovery.conf "$d"/postgresql.conf; do [ -f "$f" ] && { echo "-- $f"; grep -E "restore_command|recovery_target|primary_conninfo" "$f"; }; done
done' 2>/dev/null
