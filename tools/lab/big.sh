#!/bin/bash
# Lab: a large mixed-type database (tools/lab/big.sql) on the solo1 node (PostgreSQL 15, unusual layout) for performance tests of backup / restore.
#   sg docker tools/lab/big.sh info              sizes: VM disk, solo1 volumes, databases, pg_arca repository and WAL archive
#   sg docker tools/lab/big.sh load <units>      create database bigdb and load <units> x ~0.9 GB in the background (log /tmp/big-load.log)
#   sg docker tools/lab/big.sh drop              drop bigdb
#   sg docker tools/lab/big.sh status            load / scenario / matrix progress and disk
#   sg docker tools/lab/big.sh run [steps]       timed backup/restore scenario in the background (log /tmp/big-scn.log)
#   sg docker tools/lab/big.sh matrix ["14 15"]  version matrix in the background
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
  status)
    tail -3 /tmp/big-load.log; df -h / | tail -1
    $PSQL -d postgres -Atc "select 'busy: ' || count(*) from pg_stat_activity where datname='bigdb' and state='active'"
    $PSQL -d postgres -Atc "select 'bigdb ' || pg_size_pretty(pg_database_size('bigdb'))"
    docker exec $C sh -c 'du -sh /var/lib/pgarca/wal /var/lib/pgarca/repo 2>/dev/null'
    [ -f /tmp/big-scn.log ] && { echo "== scenario"; grep -E "^--|PASS|FAIL|   (succeeded|failed)|timings|checks passed" /tmp/big-scn.log | tail -40; }
    [ -f /tmp/matrix-summary.txt ] && { echo "== matrix"; cat /tmp/matrix-summary.txt; }
    ;;
  run)  # the timed backup/restore scenario, in the background
    pgrep -f "scenario-big.py" >/dev/null && { echo "already running"; exit 0; }
    nohup python3 scenario-big.py ${2:-} > /tmp/big-scn.log 2>&1 < /dev/null &
    echo "scenario started (pid $!), log /tmp/big-scn.log";;
  matrix) pgrep -f matrix.sh >/dev/null && { echo "matrix already running"; exit 0; }
    nohup ./matrix.sh ${2:-14 15 17 18} > /tmp/matrix-run.log 2>&1 < /dev/null & echo "matrix started";;
  *) sed -n 2,6p "$0";;
esac
