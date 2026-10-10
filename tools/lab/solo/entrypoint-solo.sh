#!/usr/bin/env bash
# Standalone PostgreSQL 15 with an unusual layout; starts the pg_arca agent beside it (installed from the mounted repo with the real installer).
set -euo pipefail
export LC_ALL=C.UTF-8
DATA=/srv/pg15/main; CONF=/etc/pg15; TS=/srv/pg15_ts/fast; SOCK=/run/pg15; LOGD=/var/log/pg15
install -d -o postgres -g postgres -m 0700 "$DATA" "$TS"; install -d -o postgres -g postgres "$CONF" "$SOCK" "$LOGD" /var/log/pgarca /srv/pg15_ts
if [[ ! -f "$DATA/PG_VERSION" ]]; then
  echo "[solo] initdb (no checksums) at $DATA"
  gosu postgres /usr/lib/postgresql/15/bin/initdb -D "$DATA" -U postgres --auth-local=trust --auth-host=scram-sha-256 -E UTF8 >/dev/null
  for f in postgresql.conf pg_hba.conf pg_ident.conf; do mv "$DATA/$f" "$CONF/$f"; done
  cat >> "$CONF/postgresql.conf" <<CFG

# ---- solo lab layout
data_directory = '$DATA'
hba_file = '$CONF/pg_hba.conf'
ident_file = '$CONF/pg_ident.conf'
port = 5433
listen_addresses = '*'
unix_socket_directories = '$SOCK'
cluster_name = 'erp-solo'
wal_level = minimal
max_wal_senders = 0
archive_mode = off
logging_collector = on
log_directory = '$LOGD'
log_filename = 'erp-%a.log'
log_line_prefix = '%m [%p] %u@%d '
shared_buffers = 128MB
max_connections = 60
CFG
  printf 'host all all 0.0.0.0/0 scram-sha-256\n' >> "$CONF/pg_hba.conf"
  chown -R postgres:postgres "$CONF"
  echo "[solo] seeding"
  gosu postgres /usr/lib/postgresql/15/bin/pg_ctl -D "$DATA" -o "-c config_file=$CONF/postgresql.conf" -w start >/dev/null
  P="gosu postgres psql -X -h $SOCK -p 5433 -U postgres"
  $P -c "create tablespace fastts location '$TS'" -c "alter user postgres password '${PG_SUPER_PASSWORD:-solo-secret}'" -c "create database erp"
  $P -d erp -c "create table customers(id serial primary key, name text, email text); insert into customers(name,email) select 'c'||g,'c'||g||'@erp.it' from generate_series(1,3000) g;
                create table invoices(id serial primary key, customer_id int, amount numeric) tablespace fastts; insert into invoices(customer_id,amount) select (random()*2999)::int+1, random()*500 from generate_series(1,12000) g;"
  gosu postgres /usr/lib/postgresql/15/bin/pg_ctl -D "$DATA" -m fast -w stop >/dev/null
fi
if [[ -n "${ARCA_URL:-}" && -f /work/unix-agent/install-agent.sh ]]; then
  echo "[solo] installing pg_arca agent -> ${ARCA_URL}"
  PG_ARCA_URL="$ARCA_URL" PG_ARCA_NODE_NAME="${NODE:-solo1}" PG_ARCA_ENROLL_TOKEN="${ARCA_ENROLL_TOKEN:-}" PG_ARCA_NO_SERVICE=1 bash /work/unix-agent/install-agent.sh || echo "[solo] agent install FAILED"
  if [[ -f /opt/pg-arca/pg-arca-agent.py ]]; then
    gosu postgres bash -c 'export PYTHONPATH=/opt/pg-arca PG_ARCA_CONF_FILE=/etc/pg-arca/agent.conf
      while true; do [ -f /etc/pg-arca/enroll.env ] && set -a && . /etc/pg-arca/enroll.env && set +a; python3 /opt/pg-arca/pg-arca-agent.py >>/var/log/pgarca/agent.out 2>&1; sleep 5; done' &
  fi
fi
exec gosu postgres /usr/lib/postgresql/15/bin/postgres -c config_file="$CONF/postgresql.conf"
