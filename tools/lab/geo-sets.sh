#!/bin/bash
# Lab helper: backup sets of the geo catalogue (start WAL, timeline) and the retention runs with what they removed.   bash geo-sets.sh
cd "$(dirname "$0")"
id=$(./api.sh GET /api/clusters | jq -r '.clusters[] | select(.name=="geo-dc1") | .id')
./api.sh GET "/api/clusters/$id/backups" | jq -c '(.backup.recent_sets // .sets // [])[] | {id, type, status, start_time, start_wal: (.start_wal // .wal_start // null), tl: (.timeline // null), start_lsn: (.start_lsn // null)}' | tail -12
./api.sh GET '/api/operations?limit=500' | jq -c '(.operations // .)[] | select(.type=="backup_expire" and (.clusterId as $c | ["'"$id"'", "'"$(./api.sh GET /api/clusters | jq -r '.clusters[] | select(.name=="geo-dc2") | .id')"'"] | index($c))) | {createdAt, createdBy, status, removed: (.result.wal_removed // null), del: (.result.delete_sets // null), keep: (.result.keep_sets // null), oldest: (.result.wal_kept_from // .result.oldest_wal // null)}'
