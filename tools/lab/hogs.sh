#!/bin/bash
# Lab helper: which containers burn CPU, and what etcd says.   bash hogs.sh
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.BlockIO}}' | sort -t$'\t' -k2 -rn | head -12
for e in $(docker ps --format '{{.Names}}' | grep -i etcd); do echo "== $e"; docker logs --tail 4 $e 2>&1 | cut -c1-250; done
uptime; free -m | head -2; nproc
