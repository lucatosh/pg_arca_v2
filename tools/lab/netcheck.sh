#!/bin/bash
# Lab helper: can every container reach the console on the host? (host.docker.internal:3000)
for n in $(docker ps --format '{{.Names}}' | grep -vE 'etcd|haproxy'); do
  printf "%-10s %s  " "$n" "$(docker exec "$n" getent hosts host.docker.internal | awk '{print $1}')"
  docker exec "$n" curl -s -m 5 -o /dev/null -w "%{http_code} %{time_total}s\n" http://host.docker.internal:3000/api/auth/status || echo "FAIL"
done
sudo iptables -S INPUT 2>/dev/null | head -20; sudo ufw status 2>/dev/null | head -5
