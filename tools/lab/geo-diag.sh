#!/bin/bash
# Lab helper: what the console sees of the geo sites + what Patroni has in each site's DCS. Run from tools/lab.  (bash geo-diag.sh)
cd "$(dirname "$0")" 2>/dev/null || true; API=${API:-$( [ -x ./api.sh ] && echo ./api.sh || echo /opt/pg_arca_v2/tools/lab/api.sh)}
echo "== console clusters"
$API GET /api/clusters | jq -r '.clusters[] | select(.name|test("geo|dc")) | "\(.id) \(.name) env=\(.environment) folder=\(.folder) status=\(.status) geo=\(.geo.role // "-")/\(.geo.health // "-") lag=\(.geo.lagBytes) agents=\([.agentNodes[]|.name+":"+(.lastSeen//"-")]|join(","))"'
echo "== console nodes of the geo clusters"
$API GET /api/clusters | jq -c '.clusters[] | select(.name|test("geo")) | {name, ha: [.haState.nodes[]? | {name, role, state, agent: (.agentNodeId // .hasAgent // null)}]}'
echo "== recent ops on geo nodes"
$API GET '/api/operations?limit=60' | jq -r '(.operations // .)[]? | select(.type|test("agent_config|hba|geo|ephemeral")) | "\(.createdAt) \(.nodeId) \(.clusterId) \(.type) \(.status) \((.error // .result.error // "") | tostring | .[0:200])"' | tail -15
for s in dc1 dc2; do for n in $s-pg1 $s-pg2; do
  echo "== $n patroni"; docker exec $n curl -s localhost:8008/patroni | jq -c '{role, state, sysid: .database_system_identifier, replication_state}'
  echo "-- agent log"; docker exec $n tail -n 4 /var/log/pgarca/agent.out
done
  echo "== $s DCS config (patronictl show-config)"; docker exec $s-pg1 patronictl -c /etc/patroni.yml show-config 2>&1 | grep -vE 'password' | head -40
done
echo "== slots on the DC1 leader"; for n in dc1-pg1 dc1-pg2; do docker exec $n gosu postgres psql -XAtc "select '$n', slot_name, active, wal_status from pg_replication_slots" 2>/dev/null; done
echo "== bk1"; docker exec bk1 tail -n 3 /var/log/pgarca/agent.out
