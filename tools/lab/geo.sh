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
  agent-update) # reinstall the agent from /work (= this checkout) on every geo node and restart only the agent process (Patroni/PostgreSQL untouched, credentials kept)
    for n in dc1-pg1 dc1-pg2 dc2-pg1 dc2-pg2 bk1; do
      docker exec -e PG_ARCA_NO_SERVICE=1 "$n" bash /work/unix-agent/install-agent.sh >/dev/null 2>&1 || echo "$n: install FAILED"
      docker exec "$n" pkill -f '^python3 /opt/pg-arca/pg-arca-agent.py' || true; done
    sleep 12; for n in dc1-pg1 dc1-pg2 dc2-pg1 dc2-pg2 bk1; do echo "== $n"; docker exec "$n" tail -n 2 /var/log/pgarca/agent.out; done ;;
  fix-dcs)   # bring both DCS to the intended geo layout, ONLY through Patroni's REST /config (= patronictl edit-config), never files:
             #   DC1: permanent slot geo_dc2; DC2: standby_cluster -> dc1-haproxy:5000 with slot geo_dc2, no permanent slots of its own; pg_hba kept in the DCS on both
    hba='["local all all trust","host all all 127.0.0.1/32 trust","host replication replicator 127.0.0.1/32 scram-sha-256","host replication replicator 172.30.0.0/16 scram-sha-256","host all all 172.30.0.0/16 scram-sha-256"]'
    l1=$(site_leader dc1) && docker exec -i "$l1" curl -s -XPATCH -H 'content-type: application/json' --data-binary @- localhost:8008/config <<<"{\"slots\":{\"geo_dc2\":{\"type\":\"physical\"}},\"postgresql\":{\"pg_hba\":$hba}}" >/dev/null && echo "DC1 DCS ok"
    l2=$(site_leader dc2) && docker exec -i "$l2" curl -s -XPATCH -H 'content-type: application/json' --data-binary @- localhost:8008/config <<<"{\"slots\":null,\"standby_cluster\":{\"host\":\"dc1-haproxy\",\"port\":5000,\"primary_slot_name\":\"geo_dc2\",\"create_replica_methods\":[\"basebackup\"]},\"postgresql\":{\"pg_hba\":$hba}}" >/dev/null && echo "DC2 DCS ok"
    sleep 15; ./geo.sh verify ;;
  verify)    # is it REALLY a geo-redundant pair? DCS content, slot, receiver, and a row written on DC1 read back on DC2
    ok=0; bad=0; chk() { if eval "$2"; then echo "  PASS $1"; ok=$((ok+1)); else echo "  FAIL $1"; bad=$((bad+1)); fi; }
    l1=$(site_leader dc1 || true); l2=$(site_leader dc2 || true)
    c1=$(docker exec "$l1" curl -s localhost:8008/config); c2=$(docker exec "$l2" curl -s localhost:8008/config)
    r1=$(docker exec "$l1" curl -s localhost:8008/patroni | jq -r .role); r2=$(docker exec "$l2" curl -s localhost:8008/patroni | jq -r .role)
    echo "DC1 leader $l1 ($r1), DC2 leader $l2 ($r2)"
    chk "DC1 is a normal primary site (no standby_cluster in its DCS)" '[[ $r1 == primary || $r1 == master ]] && [[ $(jq -r ".standby_cluster // empty" <<<"$c1") == "" ]]'
    chk "DC1 DCS has the permanent slot geo_dc2" '[[ $(jq -r ".slots.geo_dc2.type // empty" <<<"$c1") == physical ]]'
    chk "DC2 is a standby cluster led by a standby leader" '[[ $r2 == standby_leader ]]'
    chk "DC2 DCS standby_cluster -> dc1-haproxy:5000 slot geo_dc2" '[[ $(jq -r ".standby_cluster | \"\(.host):\(.port):\(.primary_slot_name)\"" <<<"$c2") == dc1-haproxy:5000:geo_dc2 ]]'
    chk "DC2 DCS has no permanent slots of its own" '[[ $(jq -r ".slots // {} | length" <<<"$c2") == 0 ]]'
    chk "pg_hba kept in both DCS (edit-config)" '[[ $(jq -r ".postgresql.pg_hba | length" <<<"$c1") -gt 0 && $(jq -r ".postgresql.pg_hba | length" <<<"$c2") -gt 0 ]]'
    act=$(docker exec "$l1" gosu postgres psql -XAtc "select active from pg_replication_slots where slot_name='geo_dc2'")
    rcv=$(docker exec "$l2" gosu postgres psql -XAtc "select status||'@'||sender_host from pg_stat_wal_receiver")
    chk "slot geo_dc2 active on the DC1 leader" '[[ $act == t ]]'
    chk "DC2 standby leader streams from DC1 (wal receiver: $rcv)" '[[ $rcv == streaming@dc1-haproxy ]]'
    tok="geo-$(date +%s%N)"
    docker exec "$l1" gosu postgres psql -XAtqc "create table if not exists geo_probe(t text, at timestamptz default now()); insert into geo_probe(t) values ('$tok')" >/dev/null
    seen=""; for _ in $(seq 30); do for n in dc2-pg1 dc2-pg2; do [[ $(docker exec "$n" gosu postgres psql -XAtc "select count(*) from geo_probe where t='$tok'" 2>/dev/null) == 1 ]] && seen="$seen $n"; done; [[ $seen == *dc2-pg1* && $seen == *dc2-pg2* ]] && break; seen=""; sleep 1; done
    chk "a row written on DC1 is readable on both DC2 nodes" '[[ $seen == *dc2-pg1* && $seen == *dc2-pg2* ]]'
    echo "$ok passed, $bad failed"; [[ $bad == 0 ]] ;;
  organise)  # put both sites in the console folder 'geo' and name them
    for c in $($API GET /api/clusters | jq -r '.clusters[] | select(.name|test("^geo-dc")) | .id'); do $API PATCH /api/clusters/$c '{"folder":"geo"}' >/dev/null; done; echo done ;;
  *) sed -n 2,3p "$0"; echo "commands: up down reset status verify fix-dcs agent-update latency <ms> wan-cut wan-restore promote-dc2 organise" ;;
esac
