#!/usr/bin/env bash
# Lab helper: what a console button does - submit one operation to a cluster and wait for its outcome.
#   usage: op.sh <cluster name> <type> [base64 of the params JSON] [wait seconds]
cd "$(dirname "$0")"
name=$1; type=$2; params=$( [ -n "${3:-}" ] && [ "$3" != "-" ] && echo "$3" | base64 -d || echo '{}'); wait=${4:-600}
cid=$(./api.sh GET /api/clusters | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(c["id"] for c in (d.get("clusters") if isinstance(d, dict) else d) if c.get("name") == sys.argv[1]))' "$name")
key="lab-$(date +%s%N)"
r=$(curl -s -b "${TMPDIR:-/tmp}/arca-api.jar" -H 'content-type: application/json' -H "idempotency-key: $key" -d "{\"type\":\"$type\",\"params\":$params}" "${PG_ARCA_URL:-http://localhost:3000}/api/clusters/$cid/operations")
id=$(echo "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("operation") or {}).get("id") or "")')
if [ -z "$id" ]; then echo "NOT SUBMITTED: $r" | cut -c1-1500; exit 1; fi
for i in $(seq 1 "$wait"); do
  o=$(./api.sh GET /api/operations/$id)
  st=$(echo "$o" | python3 -c 'import json,sys; print(json.load(sys.stdin)["operation"]["status"])')
  case $st in succeeded|failed|cancelled|expired) break;; esac; sleep 1
done
echo "$o" | python3 -c '
import json, sys
o = json.load(sys.stdin)["operation"]
print("%s %s on %s: %s" % (o["type"], o["id"], o.get("nodeId"), o["status"]))
if o.get("error"): print("ERROR:", o["error"][:1500])
print(json.dumps(o.get("result"), indent=1)[:4000])'
