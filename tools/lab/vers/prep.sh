#!/bin/bash
# What a DBA does on a fresh Debian server BEFORE pg_arca exists (not part of the product). Run inside the container as root.
#   prep.sh s14        -> PostgreSQL 14 from PGDG, Debian layout, systemd, a small "shop" database. archive_mode off (as installed).
#   prep.sh p18 <name> -> PostgreSQL 18 + Patroni (PGDG apt) with etcd3 at etcdv:2379, scope "vers18". No archive_command (pg_arca will set it).
set -euo pipefail
role=$1; me=${2:-$(hostname)}
export DEBIAN_FRONTEND=noninteractive
if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
fi
case $role in
  s14)
    apt-get install -y -qq postgresql-14 >/dev/null
    C=/etc/postgresql/14/main
    sed -i "s/^#listen_addresses.*/listen_addresses = '*'/" $C/postgresql.conf
    grep -q '0.0.0.0/0' $C/pg_hba.conf || echo "host all all 0.0.0.0/0 scram-sha-256" >> $C/pg_hba.conf
    systemctl enable --now postgresql@14-main; systemctl restart postgresql@14-main
    sudo -u postgres psql -qX -c "ALTER USER postgres PASSWORD 's14-secret'"
    if ! sudo -u postgres psql -tAXc "select 1 from pg_database where datname='shop'" | grep -q 1; then
      sudo -u postgres createdb shop
      sudo -u postgres psql -qX -d shop -c "create table customers(id bigserial primary key, name text not null, email text unique, created timestamptz default now());
        insert into customers(name,email) select 'cust '||g, 'c'||g||'@shop.example' from generate_series(1,20000) g;
        create table orders(id bigserial primary key, customer_id bigint references customers, amount numeric(10,2), status text default 'new');
        insert into orders(customer_id, amount) select 1+(g % 20000), (g % 977)/3.0 from generate_series(1,80000) g;
        create index on orders(customer_id); create view big_orders as select * from orders where amount > 300;"
    fi
    sudo -u postgres psql -tAXc "select version()" ;;
  p18)
    apt-get install -y -qq postgresql-18 patroni >/dev/null
    systemctl disable --now postgresql >/dev/null 2>&1 || true
    pg_lsclusters -h | grep -q '^18 *main' && pg_dropcluster 18 main --stop || true
    install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/18/main
    install -d -o postgres -g postgres /etc/patroni /var/log/patroni
    ip=$(hostname -I | awk '{print $1}')
    cat > /etc/patroni/config.yml <<YML
scope: vers18
name: $me
log: {level: INFO, dir: /var/log/patroni}
restapi: {listen: 0.0.0.0:8008, connect_address: "$ip:8008"}
etcd3: {hosts: "etcdv:2379"}
bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    postgresql:
      use_pg_rewind: true
      use_slots: true
      parameters: {wal_level: replica, hot_standby: "on", max_wal_senders: 10, max_replication_slots: 10, wal_log_hints: "on"}
      pg_hba:
        - local all all peer
        - host all all 127.0.0.1/32 scram-sha-256
        - host replication replicator 127.0.0.1/32 scram-sha-256
        - host replication replicator 172.30.18.0/24 scram-sha-256
        - host all all 0.0.0.0/0 scram-sha-256
  initdb: [encoding: UTF8]
postgresql:
  listen: 0.0.0.0:5432
  connect_address: "$ip:5432"
  data_dir: /var/lib/postgresql/18/main
  bin_dir: /usr/lib/postgresql/18/bin
  pgpass: /var/lib/postgresql/.pgpass_patroni
  authentication:
    superuser: {username: postgres, password: "p18-secret"}
    replication: {username: replicator, password: "p18-repl"}
    rewind: {username: rewinder, password: "p18-rewind"}
YML
    chown postgres:postgres /etc/patroni/config.yml; chmod 600 /etc/patroni/config.yml
    systemctl enable --now patroni
    sleep 15; patronictl -c /etc/patroni/config.yml list || true ;;
  *) echo "usage: prep.sh s14 | p18 <name>"; exit 2 ;;
esac
