#!/bin/bash
# Lab: a large mixed-type database (tools/lab/big.sql) on the solo1 node (PostgreSQL 15, unusual layout) for performance tests of backup / restore.
#   sg docker tools/lab/big.sh info              sizes: VM disk, solo1 volumes, databases, pg_arca repository and WAL archive
#   sg docker tools/lab/big.sh load <units>      create database bigdb and load <units> x ~0.9 GB in the background (log /tmp/big-load.log)
#   sg docker tools/lab/big.sh drop              drop bigdb
cd "$(dirname "$0")" || exit 1
C=${BIG_NODE:-solo1}
PSQL="docker exec -i $C gosu postgres psql -X -h /run/pg15 -p 5433 -U postgres"
case "$1" in
  info)
    echo "== VM /"; df -h / | tail -1
    echo "== $C"; docker exec $C sh -c 'df -h / /srv 2>/dev/null | tail -n +2; du -sh /var/lib/pgarca/* /srv/pg15* 2>/dev/null'
    $PSQL -d postgres -Atc "select datname || ' ' || pg_size_pretty(pg_database_size(datname)) from pg_database where datallowconn order by pg_database_size(datname) desc"
    ;;
  load)
    U=${2:-12}
    TS=$($PSQL -d postgres -Atc "select coalesce((select spcname from pg_tablespace where spcname not like 'pg\_%' limit 1), '')")
    $PSQL -d postgres -Atc "select 1 from pg_database where datname='bigdb'" | grep -q 1 || $PSQL -d postgres -c "CREATE DATABASE bigdb"
    $PSQL -d bigdb -q -v ts="$TS" < big.sql 2>&1 | grep -v NOTICE
    echo "tablespace for telemetry.events: ${TS:-none}"
    nohup sh -c "date; $PSQL -d bigdb -c 'CALL big_load($U)' -c 'CALL big_finish()'; date; $PSQL -d postgres -Atc \"select pg_size_pretty(pg_database_size('bigdb'))\"" > /tmp/big-load.log 2>&1 < /dev/null &
    echo "loading $U units in the background (pid $!), log /tmp/big-load.log"
    ;;
  drop) $PSQL -d postgres -c "DROP DATABASE IF EXISTS bigdb WITH (FORCE)";;
  *) sed -n 2,6p "$0";;
esac
