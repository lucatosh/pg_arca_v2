#!/bin/bash
# Create (or recreate) the restore-lab database `arca_restore_lab` (2 schemas, 10 tables x 100 rows, FKs, views, trigger, grants).
#   tools/lab/testdb.sh lab [db]      -> on the CURRENT Patroni leader of the docker lab (needs docker access + tools/lab/.env)
#   tools/lab/testdb.sh [psql args]   -> on any instance, e.g.  -p 5433 -h /var/run/postgresql   (run as postgres OS user or pass -U)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$1" = lab ]; then
  cd "$here"; set -a; . ./.env; set +a
  L=$(docker exec pg1 patronictl -c /etc/patroni.yml list -f json | python3 -c "import sys,json;print([m['Member'] for m in json.load(sys.stdin) if m['Role']=='Leader'][0])")
  echo "leader: $L"
  docker exec -i -e PGPASSWORD="$PG_SUPER_PASSWORD" "$L" psql -X -h localhost -U postgres -d postgres < "$here/testdb.sql"
  exit 0
fi
if [ "$(id -un)" = postgres ] || [ "$#" -gt 0 ]; then exec psql -X "$@" -f "$here/testdb.sql"; fi
exec sudo -u postgres psql -X -f "$here/testdb.sql"
