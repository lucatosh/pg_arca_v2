#!/bin/bash
# Lab: run SQL on the PRIMARY of a cluster of the console, found by its name in the console (whatever machine runs it):
#   tools/lab/ui/sql.sh <cluster name> <database> '<sql>'        (or the SQL on stdin)
#   tools/lab/ui/sql.sh <cluster name> --node                     prints "<node> <port>" of the primary
#   tools/lab/ui/sql.sh <cluster name> --on <node> <port> <db> '<sql>'   on that node / port (e.g. a restored copy)
# Docker containers on this VM or Proxmox containers (node.sh):  as the postgres OS user (or the lab superuser password). Output: psql -At (one row per line, | between columns).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/.."
name=$1; shift
if [ "${1:-}" = --on ]; then node=$2; port=$3; shift 3
else
  read -r node port < <(./api.sh GET /api/clusters | python3 -c '
import json, sys
m = [c for c in json.load(sys.stdin)["clusters"] if c["name"] == sys.argv[1]]
if not m:
    sys.exit("no cluster named %s in the console" % sys.argv[1])
nodes = m[0].get("agentNodes") or []
p = [n for n in nodes if n.get("role") == "primary"] or nodes
print(p[0]["name"], (p[0].get("settings") or {}).get("port") or 5432) if p else sys.exit("cluster %s: no agent node" % sys.argv[1])' "$name")
fi
if [ "${1:-}" = --node ]; then echo "$node $port"; exit 0; fi
db=$1; sql=${2:-$(cat)}
set -a; [ -f .env ] && . ./.env; set +a
psql_peer="psql -X -At -q -v ON_ERROR_STOP=1 -p $port${SOCK:+ -h $SOCK}"     # SOCK=<socket dir>: a restored copy listens on its private socket
N="$HERE/node.sh"
if "$N" "$node" "su postgres -s /bin/bash -c \"$psql_peer -d postgres -c 'select 1'\"" >/dev/null 2>&1 </dev/null; then
  printf '%s\n' "$sql" | "$N" "$node" "cd / && su postgres -s /bin/bash -c \"$psql_peer -d '$db'\""
else
  printf '%s\n' "$sql" | "$N" "$node" "PGPASSWORD='${PG_SUPER_PASSWORD:-}' psql -X -At -q -v ON_ERROR_STOP=1 -h localhost -U postgres -p $port -d '$db'"
fi
