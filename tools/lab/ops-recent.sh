#!/bin/bash
# Lab helper: the last N operations (type, node, status, error/result excerpt).   ops-recent.sh [N] [type-regex]
cd "$(dirname "$0")"; N=${1:-15}; T=${2:-.}
./api.sh GET "/api/operations?limit=200" | jq -r --arg t "$T" '(.operations // .) | map(select(.type|test($t))) | sort_by(.createdAt) | .[-'"$N"':][] | "\(.createdAt[11:19]) \(.type) \(.nodeId) \(.status) \((.error // (.result|tostring)) | .[0:220])"'
