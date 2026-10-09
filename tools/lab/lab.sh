#!/usr/bin/env bash
# Driver for the Patroni lab (3 etcd + 3 PostgreSQL16/Patroni + pg_arca agent + HAProxy).  ./lab.sh help
set -euo pipefail
cd "$(dirname "$0")"
DC="docker compose"; ENVF=.env
need_env() {
  if [[ ! -f $ENVF ]]; then
    rnd() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24; }
    umask 077; { echo "PG_SUPER_PASSWORD=$(rnd)"; echo "PG_REPL_PASSWORD=$(rnd)"
      echo "# where the nodes reach the pg_arca console running on this host (Docker host-gateway)"
      echo "ARCA_URL=http://host.docker.internal:3000"; echo "# optional: Cluster -> Collega cluster -> agent token. Empty = nodes announce themselves and wait for approval"
      echo "ARCA_ENROLL_TOKEN="; } > $ENVF; echo "created $ENVF (random passwords, gitignored)"
  fi
}
leader() { for n in pg1 pg2 pg3; do if [[ $(docker exec "$n" curl -s -o /dev/null -w '%{http_code}' localhost:8008/primary 2>/dev/null) == 200 ]]; then echo "$n"; return; fi; done; return 1; }
case "${1:-help}" in
  up)      need_env; $DC up -d --build; echo "waiting for a leader..."; for _ in $(seq 60); do l=$(leader || true); [[ -n $l ]] && break; sleep 3; done; ./lab.sh status ;;
  down)    $DC down ;;
  reset)   read -rp "Delete ALL lab data (databases, backup repo, agent credentials)? [yes/N] " a; [[ $a == yes ]] && $DC down -v ;;
  status)  l=$(leader || true); [[ -n $l ]] && docker exec "$l" patronictl -c /etc/patroni.yml list || echo "no leader yet"; $DC ps --format 'table {{.Service}}\t{{.Status}}' ;;
  shell)   docker exec -it "${2:-$(leader)}" bash -l ;;
  psql)    docker exec -it "$(leader)" gosu postgres psql ;;
  logs)    $DC logs -f --tail=100 "${2:-pg1}" ;;
  agentlog) docker exec -it "${2:-$(leader)}" tail -f /var/log/pgarca/agent.out ;;
  console) # run the web console on this host (background), from the repo root
    cd ../..; [[ -d node_modules/express ]] || npm install; [[ -f dist/index.html ]] || npx vite build; setsid nohup npm start >/tmp/pg_arca_console.log 2>&1 < /dev/null & echo "console on :3000, log /tmp/pg_arca_console.log" ;;
  agent-reset) # forget the console enrollment on every node and restart them one by one (then delete the old clusters in the console and approve again)
    for n in pg1 pg2 pg3; do docker exec "$n" rm -f /etc/pg-arca/credentials.json /etc/pg-arca/join.json /etc/pg-arca/enroll.env; docker restart "$n" >/dev/null; echo "$n restarted"; sleep 20; done ;;
  switchover) l=$(leader); t=${2:?target node (pg1|pg2|pg3)}; docker exec "$l" patronictl -c /etc/patroni.yml switchover --leader "$l" --candidate "$t" --force; sleep 8; ./lab.sh status ;;
  failover) l=$(leader); echo "stopping leader $l (kill -9 style)"; docker kill "$l" >/dev/null; for _ in $(seq 40); do n=$(leader || true); [[ -n $n && $n != "$l" ]] && break; sleep 3; done; echo "new leader: ${n:-NONE}"; docker start "$l" >/dev/null; sleep 20; ./lab.sh status ;;
  smoke)   # sanity checks, exits non-zero on the first failure
    l=$(leader) || { echo "FAIL no leader"; exit 1; }; echo "leader $l"
    q() { docker exec "$1" gosu postgres psql -XAtc "$2"; }
    q "$l" "create table if not exists lab_smoke(t timestamptz default now(), v text)"; q "$l" "insert into lab_smoke(v) values ('hello')"
    for _ in $(seq 40); do n=$(q "$l" "select count(*) from pg_stat_replication where state='streaming'"); [[ $n -ge 2 ]] && break; echo "   waiting for replicas to finish their base backup ($n/2 streaming)..."; sleep 5; done; [[ $n -ge 2 ]] && echo "ok  $n replicas streaming" || { echo "FAIL replicas streaming: $n"; exit 1; }
    sleep 2; for r in pg1 pg2 pg3; do [[ $r == $l ]] && continue; c=$(q "$r" "select count(*) from lab_smoke"); [[ $c -ge 1 ]] && echo "ok  $r replicated ($c rows)" || { echo "FAIL $r not replicated"; exit 1; }; done
    q "$l" "select pg_switch_wal()" >/dev/null; sleep 5
    docker exec "$l" bash -c 'ls /var/lib/pgarca/wal | head -3 | grep -q .' && echo "ok  WAL archive receiving" || echo "WARN WAL archive empty (check archive_command / agent install)"
    for r in pg1 pg2 pg3; do docker exec "$r" pgrep -f pg-arca-agent.py >/dev/null && echo "ok  agent running on $r" || echo "WARN agent not running on $r (see: ./lab.sh logs $r)"; done
    echo "HAProxy: $(curl -s -o /dev/null -w '%{http_code}' localhost:7000) on :7000, primary :5000, replicas :5001" ;;
  bench)   docker exec -u postgres -e PGHOST=localhost -e PGPASSWORD="$(grep ^PG_SUPER .env | cut -d= -f2)" "$(leader)" bash /work/tools/lab/bench.sh "${2:-10}" /tmp/pgarca-bench ;;
  *) cat <<H
./lab.sh up | down | reset | status | smoke
         shell [node] | psql | logs [node] | agentlog [node]
         agent-reset        forget console enrollment on all nodes (re-announce)
         console            start the pg_arca web console on this host (npm start, :3000)
         switchover <node>  planned role change   |  failover  kill the leader and watch Patroni elect another
         bench [scale]      tools/lab/bench.sh on the leader (default scale 10)
Ports on the host: 5000 primary, 5001 replicas, 7000 HAProxy stats. Config: tools/lab/.env
H
  ;;
esac
