#!/usr/bin/env bash
# Driver for the GEO-REDUNDANT lab (geo/docker-compose.geo.yml): DC1 primary site, DC2 standby site, bk1 backup server.   ./geo.sh help
set -euo pipefail
cd "$(dirname "$0")"
DC="docker compose -f geo/docker-compose.geo.yml --env-file geo/.env"
API=./api.sh
need_env() {
  [[ -f geo/.env ]] && return
  rnd() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24; }
  umask 077; { echo "PG_SUPER_PASSWORD=$(rnd)"; echo "PG_REPL_PASSWORD=$(rnd)"; echo "ARCA_URL=http://host.docker.internal:3000"; } > geo/.env
  # one single-use enrollment token per node (the console must be running on this host); bk1 enrolls as an operational machine
  for n in DC1_PG1 DC1_PG2 DC2_PG1 DC2_PG2; do
    t=$($API POST /api/enrollment-tokens "{\"label\":\"geo ${n,,}\",\"environment\":\"prod\",\"ttlMinutes\":240}" | jq -r .token); echo "TOKEN_$n=$t" >> geo/.env; done
  t=$($API POST /api/enrollment-tokens '{"label":"geo bk1","kind":"worker","ttlMinutes":240}' | jq -r .token); echo "TOKEN_BK1=$t" >> geo/.env
  echo "created geo/.env (passwords + enrollment tokens)"
}
site_leader() { for n in $1-pg1 $1-pg2; do if [[ $(docker exec "$n" curl -s -o /dev/null -w '%{http_code}' localhost:8008/leader 2>/dev/null) == 200 ]]; then echo "$n"; return; fi; done; return 1; }
case "${1:-help}" in
  up)     need_env; $DC up -d; echo "waiting for both sites..."; for _ in $(seq 80); do a=$(site_leader dc1 || true); b=$(site_leader dc2 || true); [[ -n $a && -n $b ]] && break; sleep 5; done; ./geo.sh status ;;
  down)   $DC down ;;
  reset)  $DC down -v; rm -f geo/.env ;;
  status)
    for s in dc1 dc2; do echo "== $s"; l=$(site_leader $s || true); docker exec "${l:-$s-pg1}" patronictl -c /etc/patroni.yml list 2>&1 | tail -n +1 | head -8; done
    l=$(site_leader dc1 || true)
    [[ -n $l ]] && { echo "== DC1 -> DC2 replication (slot geo_dc2)"; docker exec "$l" gosu postgres psql -XAtc "select slot_name, active, wal_status, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as retained from pg_replication_slots where slot_name='geo_dc2'" -c "select application_name, client_addr, state, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) as lag, replay_lag from pg_stat_replication"; }
    docker exec bk1 bash -c 'du -sh /backup/repo /backup/wal 2>/dev/null; tail -n 2 /var/log/pgarca/agent.out' 2>/dev/null || true ;;
  latency) # one-way delay on the WAN side of the DC2 nodes (e.g. ./geo.sh latency 40ms; ./geo.sh latency 0 removes it)
    for n in dc2-pg1 dc2-pg2; do dev=$(docker exec "$n" ip -o -4 addr | awk '/172\.30\.0\./{print $2}'); docker exec "$n" tc qdisc del dev "$dev" root 2>/dev/null || true
      [[ ${2:-0} != 0 ]] && docker exec "$n" tc qdisc add dev "$dev" root netem delay "$2" && echo "$n: WAN delay $2 on $dev"; done ;;
  wan-cut)   docker network disconnect arca-geo_wan dc1-haproxy && echo "WAN cut: DC2 no longer reaches DC1" ;;
  wan-restore) docker network connect arca-geo_wan dc1-haproxy && echo "WAN restored" ;;
  promote-dc2)  # DR: DC2 becomes a normal (writable) cluster. Through Patroni's DCS (edit-config), never by hand on PostgreSQL.
    l=$(site_leader dc2) || { echo "no DC2 leader"; exit 1; }
    docker exec "$l" bash -c "patronictl -c /etc/patroni.yml edit-config --force -s standby_cluster=null" ;;
  organise)  # put both sites in the console folder 'geo' and name them
    for c in $($API GET /api/clusters | jq -r '.clusters[] | select(.name|test("^geo-dc")) | .id'); do $API PATCH /api/clusters/$c '{"folder":"geo"}' >/dev/null; done; echo done ;;
  *) sed -n 2,3p "$0"; echo "commands: up down reset status latency <ms> wan-cut wan-restore promote-dc2 organise" ;;
esac
