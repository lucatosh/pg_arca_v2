#!/bin/bash
# What a DBA does on a fresh Rocky / RHEL 9 server BEFORE pg_arca exists (not part of the product). Run as root on the server.
#   prep-rocky.sh pg <scope> <etcd host:port> [<standby host> <standby port> <slot>]
#       PostgreSQL 16 (PGDG rpm) + Patroni (rpm), RHEL layout (/var/lib/pgsql/16/data, /usr/pgsql-16/bin), systemd unit patroni.service.
#       With a standby host the cluster is a Patroni STANDBY CLUSTER of the other site (bootstrapped by pg_basebackup through it).
#   prep-rocky.sh nfs <server:/export>      mounts the shared archive at /mnt/arca (fstab), as a storage admin would
#   prep-rocky.sh seed                       a small "shop" database on the leader
# Passwords are the lab's (both sites share the roles: they are the same database).
set -euo pipefail
what=$1; shift
SU=hy-super-pw; REPL=hy-repl-pw; RW=hy-rewind-pw
pkgs() {
  rpm -q pgdg-redhat-repo >/dev/null 2>&1 || dnf -y -q install https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm >/dev/null
  dnf -y -q module disable postgresql >/dev/null 2>&1 || true
  rpm -q epel-release >/dev/null 2>&1 || dnf -y -q install epel-release >/dev/null
  dnf config-manager --set-enabled crb >/dev/null 2>&1 || dnf -y -q install dnf-plugins-core >/dev/null && dnf config-manager --set-enabled crb >/dev/null 2>&1 || true
  dnf -y -q install postgresql16-server postgresql16-contrib patroni patroni-etcd >/dev/null
}
case $what in
  pg)
    scope=$1 etcd=$2 sh=${3:-} sp=${4:-} slot=${5:-}
    pkgs
    me=$(hostname -s); ip=$(hostname -I | awk '{print $1}')
    install -d -o postgres -g postgres -m 0700 /var/lib/pgsql/16/data
    install -d -o postgres -g postgres /etc/patroni /var/log/patroni
    standby=""; slots="{}"
    if [ -n "$sh" ]; then standby="    standby_cluster: {host: $sh, port: $sp, primary_slot_name: $slot, create_replica_methods: [basebackup]}"; else slots="{${slot:-geo_hy_rm}: {type: physical}}"; fi
    cat > /etc/patroni/patroni.yml <<YML
scope: $scope
name: $me
log: {level: INFO, dir: /var/log/patroni}
restapi: {listen: 0.0.0.0:8008, connect_address: "$ip:8008"}
etcd3: {hosts: "$etcd"}
bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    slots: $slots
$standby
    postgresql:
      use_pg_rewind: true
      use_slots: true
      parameters: {wal_level: replica, hot_standby: "on", max_wal_senders: 10, max_replication_slots: 10, wal_log_hints: "on", wal_keep_size: 512MB}
      pg_hba:
        - local all all peer
        - host all all 127.0.0.1/32 scram-sha-256
        - host replication replicator 127.0.0.1/32 scram-sha-256
        - host replication replicator 172.30.40.0/24 scram-sha-256
        - host replication replicator 192.168.1.0/24 scram-sha-256
        - host all all 172.30.40.0/24 scram-sha-256
        - host all all 192.168.1.0/24 scram-sha-256
  initdb: [encoding: UTF8, data-checksums]
postgresql:
  listen: 0.0.0.0:5432
  connect_address: "$ip:5432"
  data_dir: /var/lib/pgsql/16/data
  bin_dir: /usr/pgsql-16/bin
  pgpass: /var/lib/pgsql/.pgpass_patroni
  authentication:
    superuser: {username: postgres, password: "$SU"}
    replication: {username: replicator, password: "$REPL"}
    rewind: {username: rewinder, password: "$RW"}
YML
    chown postgres:postgres /etc/patroni/patroni.yml; chmod 600 /etc/patroni/patroni.yml
    systemctl enable --now patroni >/dev/null 2>&1
    for i in $(seq 60); do s=$(curl -s localhost:8008/patroni 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("role"), d.get("state"))' 2>/dev/null || true); case "$s" in *running*|*streaming*) break;; esac; sleep 5; done
    echo "$me: $s"; patronictl -c /etc/patroni/patroni.yml list 2>/dev/null | tail -n +1 ;;
  pkgs) pkgs; rpm -q postgresql16-server patroni | tr '\n' ' '; echo ;;
  nfs)
    src=$1; install -d /mnt/arca
    grep -q " /mnt/arca " /etc/fstab || echo "$src /mnt/arca nfs4 rw,hard,noatime,_netdev 0 0" >> /etc/fstab
    mountpoint -q /mnt/arca || mount /mnt/arca
    df -h /mnt/arca | tail -1 ;;
  seed)
    sudo -u postgres psql -qX -c "select 1" >/dev/null
    if ! sudo -u postgres psql -tAXc "select 1 from pg_database where datname='shop'" | grep -q 1; then
      sudo -u postgres createdb shop
      sudo -u postgres psql -qX -d shop -c "create table customers(id bigserial primary key, name text not null, city text, created timestamptz default now());
        insert into customers(name, city) select 'cust '||g, (array['Milano','Roma','Torino'])[1+g%3] from generate_series(1,20000) g;
        create table orders(id bigserial primary key, customer_id bigint references customers, amount numeric(10,2), at timestamptz default now());
        insert into orders(customer_id, amount) select 1+(g % 20000), (g % 977)/3.0 from generate_series(1,80000) g;"
    fi
    sudo -u postgres psql -tAXc "select count(*) from shop.public.orders" 2>/dev/null || sudo -u postgres psql -tAX -d shop -c "select count(*) from orders" ;;
  *) echo "usage: prep-rocky.sh pg|nfs|seed ..."; exit 2 ;;
esac
