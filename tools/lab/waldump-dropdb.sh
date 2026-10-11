#!/bin/bash
# Lab experiment: what DROP DATABASE writes in the WAL on a given major (pg_database invalid marking, drop record).   waldump-dropdb.sh 14
v=${1:-14}
docker run --rm -e LC_ALL=C.UTF-8 postgres:$v-bookworm bash -c '
B=$(ls -d /usr/lib/postgresql/*/bin); D=/tmp/d; mkdir -p $D; chown postgres $D
su postgres -c "$B/initdb -D $D -A trust >/dev/null && $B/pg_ctl -D $D -o \"-k /tmp\" -l $D/log start >/dev/null"
P="$B/psql -h /tmp -XAtq postgres"
su postgres -c "$P -c \"select version()\""
su postgres -c "$P -c \"create database gone\" -c \"select oid from pg_database where datname=\x27gone\x27\" -c checkpoint -c \"select pg_switch_wal()\"" 
S=$(su postgres -c "$P -c \"select pg_current_wal_lsn()\"")
su postgres -c "$P -c \"drop database gone\""
E=$(su postgres -c "$P -c \"select pg_current_wal_lsn()\"")
echo "range $S .. $E"
su postgres -c "$B/pg_waldump -p $D/pg_wal -s $S -e $E" 2>&1 | grep -vE "Btree|Standby  |RUNNING_XACTS" | cut -c1-230 | head -40
'
