#!/bin/bash
# Lab helper: q.sh <db> <sql>  -> run SQL on the current Patroni leader as superuser (needs docker access + .env)
cd "$(dirname "$0")"; set -a; . ./.env; set +a
L=$(docker exec pg1 patronictl -c /etc/patroni.yml list -f json | python3 -c "import sys,json;print([m['Member'] for m in json.load(sys.stdin) if m['Role']=='Leader'][0])")
docker exec -e PGPASSWORD="$PG_SUPER_PASSWORD" "$L" psql -h localhost -U postgres -d "$1" -Atc "$2"
