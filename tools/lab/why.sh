#!/bin/bash
# Lab helper: the reasons behind the briefing items and the failed operations of the last 24 h.   bash why.sh
cd "$(dirname "$0")"
echo "== WAL continuity reported by the geo agents"
./api.sh GET /api/clusters | jq -c '.clusters[] | select(.name|test("geo")) | {name, id}' 
for n in dc1-pg1 dc2-pg1; do docker exec $n bash -c 'ls /backup/wal | head -3; ls /backup/wal/* 2>/dev/null | head -0'; done
./api.sh GET /api/clusters | jq -r '.clusters[] | select(.name|test("geo")) | .id' | while read id; do ./api.sh GET "/api/clusters/$id/backups" | jq -c '{stanza: .backup.stanza, wal: (.wal // .backup.wal // null)}' | cut -c1-1500; done
echo "== worker bk1"
./api.sh GET /api/workers | jq -c '.workers[] | {name, roles, pgMajors, usedBy: (.usedBy // .users // null), needs: (.needsMajors // null)}'
echo "== failed operations, last 24 h, by type and error"
./api.sh GET '/api/operations?limit=500' | jq -r --arg since "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M)" '(.operations // .)[] | select(.status=="failed" and .createdAt > $since) | "\(.type)\t\(.createdBy)\t\((.error // "") | gsub("\n";" ") | .[0:110])"' | sort | uniq -c | sort -rn | head -40
