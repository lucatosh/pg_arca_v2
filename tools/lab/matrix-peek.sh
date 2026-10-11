#!/bin/bash
# Lab helper: what the running matrix container is doing (processes, ephemeral instance logs).   bash matrix-peek.sh
c=$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /^postgres:[0-9]+-/ {print $1; exit}')
[ -z "$c" ] && { echo "no matrix container"; exit 0; }
echo "== $c"
docker exec "$c" bash -c 'ps -eo etime,pcpu,args | grep -E "python3|postgres -D|startup|restore_command|pg-arca" | grep -v grep | cut -c1-220
for f in /tmp/pgarca-e2e-*/my-scratch/eph-*/log/* /tmp/pgarca-e2e-*/*/eph-*/log/*; do [ -f "$f" ] && { echo "== $f"; tail -n 15 "$f" | cut -c1-240; }; done' 2>/dev/null
