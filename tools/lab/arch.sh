#!/bin/bash
# Lab helper: archiver state of the current leader + tail of its postgres log
cd "$(dirname "$0")"
./q.sh postgres "select archived_count,failed_count,last_archived_wal,last_archived_time,coalesce(last_failed_wal,'-'),coalesce(last_failed_time::text,'-') from pg_stat_archiver"
./q.sh postgres "select pg_current_wal_lsn(), now(), pg_is_in_recovery(), (select setting from pg_settings where name='archive_timeout')"
L=$(docker exec pg1 patronictl -c /etc/patroni.yml list -f json | python3 -c "import sys,json;print([m['Member'] for m in json.load(sys.stdin) if m['Role']=='Leader'][0])")
docker exec $L bash -c 'tail -n 14 /var/lib/postgresql/data/pgdata/log/*.log | cut -c1-230'
