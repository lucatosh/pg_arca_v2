#!/bin/bash
# "versions" lab target (docker-compose.vers.yml): s14 (PG14 standalone, Debian layout) + p18a/p18b (Patroni on PG18). See vers/prep.sh.
#   vers.sh all | up | prep | status | logs <host> | down | reset      (all = up + prep + status)
cd "$(dirname "$0")"
D="sg docker -c"
case $1 in
  all)    "$0" up && "$0" prep && "$0" status ;;
  up)     $D "docker compose -f docker-compose.vers.yml up -d --build" ;;
  prep)   for h in s14 p18a p18b; do $D "docker cp vers/prep.sh $h:/root/prep.sh"; done
          $D "docker exec s14 bash /root/prep.sh s14" 2>&1 | tail -3
          $D "docker exec p18a bash /root/prep.sh p18 p18a" 2>&1 | tail -6
          $D "docker exec p18b bash /root/prep.sh p18 p18b" 2>&1 | tail -6 ;;
  status) for h in s14 p18a p18b; do echo "== $h"; $D "docker exec $h bash -c 'systemctl is-system-running; systemctl --no-pager --plain list-units --type=service --state=running | grep -E \"postgres|patroni|pg-arca\"; pgrep -af pg-arca | head -3'"; done
          $D "docker exec p18a patronictl -c /etc/patroni/config.yml list" 2>/dev/null ;;
  logs)   $D "docker exec $2 bash -c 'journalctl --no-pager -n 60 -u pg-arca-agent 2>/dev/null; tail -n 30 /var/log/pg-arca/*.log /var/log/pgarca/*.log 2>/dev/null'" ;;
  down)   $D "docker compose -f docker-compose.vers.yml down" ;;
  reset)  $D "docker compose -f docker-compose.vers.yml down -v" ;;
  *) echo "usage: vers.sh up|prep|status|logs <host>|down|reset"; exit 2 ;;
esac
