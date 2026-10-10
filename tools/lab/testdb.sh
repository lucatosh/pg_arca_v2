#!/bin/bash
# Create (or recreate) the restore-lab database on a PostgreSQL instance.   usage: tools/lab/testdb.sh [psql args, e.g. -p 5433]
# Needs a superuser: run it as the postgres OS user, or pass connection options (-h host -U postgres).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$(id -un)" = postgres ] || [ "$#" -gt 0 ]; then exec psql -X "$@" -f "$here/testdb.sql"; fi
exec sudo -u postgres psql -X -f "$here/testdb.sql"
