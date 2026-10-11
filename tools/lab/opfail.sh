#!/bin/bash
# Lab helper: full detail of failed operations of the last 24 h whose type matches a regex.   opfail.sh <type-regex> [createdBy-regex]
cd "$(dirname "$0")"; T=${1:-.}; B=${2:-.}
./api.sh GET "/api/operations?limit=1000" | jq -r --arg t "$T" --arg b "$B" --arg since "$(date -u -d '24 hours ago' +%FT%T)" '(.operations // .) | map(select(.status=="failed" and .updatedAt > $since and (.type|test($t)) and ((.createdBy//"")|test($b))))[]
  | "== \(.updatedAt[0:19]) \(.type) cluster=\(.clusterId) node=\(.nodeId) by=\(.createdBy)\n   params: \(.params|tostring|.[0:400])\n   error: \(.error|tostring|.[0:700])"'
