#!/bin/bash
# Lab: do the PostgreSQL binaries installed by ephemeral_install (private mode) really run? initdb + start + SELECT version() + stop, as the agent's user.  usage (VM): sg docker tools/lab/check-private-bin.sh [major] [node]
M=${1:-17}; N=${2:-pg1}
docker exec -u postgres "$N" bash -c '
B=/var/lib/pgarca/pg/'"$M"'/usr/lib/postgresql/'"$M"'/bin; D=/tmp/priv'"$M"'
$B/postgres --version; rm -rf $D
$B/initdb -D $D -A trust >/dev/null && echo initdb-ok
$B/pg_ctl -D $D -o "-p 55432 -c listen_addresses= -c unix_socket_directories=/tmp" -w -l $D.log start >/dev/null && echo started
$B/psql -X -h /tmp -p 55432 -Atc "select version()" postgres
$B/pg_ctl -D $D -m fast stop >/dev/null; rm -rf $D $D.log'
