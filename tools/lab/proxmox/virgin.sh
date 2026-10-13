#!/bin/bash
# Virgin PostgreSQL servers on a Proxmox host, for testing pg_arca the way a customer meets it: PostgreSQL installed and running the way each
# distribution / vendor does it, with some data, and NOTHING of pg_arca. The agent is then installed from the console ("Genera comando"),
# exactly like a user would. Every container gets a snapshot "virgin" right after setup: `reset` brings it back to that state in seconds.
#
# Run ON THE PROXMOX HOST as root:
#   ./virgin.sh list                     profiles
#   ./virgin.sh create all | <name>...   create + set up + snapshot "virgin" (idempotent: an existing container is skipped)
#   ./virgin.sh status                   state, IP, PostgreSQL version and port of each
#   ./virgin.sh reset all | <name>...    roll back to the snapshot "virgin" (agent, archive settings, backups... all gone)
#   ./virgin.sh destroy all | <name>...  stop and delete
#   ./virgin.sh sh <name> '<command>'    run a command inside (as root)
#   ./virgin.sh agent '<cmd>' all|<name>  run the agent install command copied from the console ("Genera comando") on those servers
#
# Settings (environment):
#   STORAGE=local-lvm   rootfs storage (needs snapshots: lvm-thin, zfs, btrfs; NOT plain directory storage)
#   TSTORE=local        where templates are downloaded
#   BRIDGE=vmbr0        network bridge
#   IPBASE=             e.g. 192.168.1.200: static addresses .200, .201, ... (GW required); empty = DHCP (Patroni nodes then use the leases they got)
#   GW=                 gateway for static addresses
#   CTID0=410           first container id
#   PW=arca-lab-pw      password of the postgres superuser and of the replicator role (lab only)
# The containers take the host's clock (keep the Proxmox host on NTP: chrony is installed by default) - no clock drift as on the old VM.
set -euo pipefail

STORAGE=${STORAGE:-local-lvm}; TSTORE=${TSTORE:-local}; BRIDGE=${BRIDGE:-vmbr0}; IPBASE=${IPBASE:-}; GW=${GW:-}; CTID0=${CTID0:-410}; PW=${PW:-arca-lab-pw}
SNAP=virgin

# name | offset | template prefix | memory MB | disk GB | setup function | what it reproduces
PROFILES="
deb12-pg15|0|debian-12-standard|1024|8|setup_debian_distro 15|Debian 12, PostgreSQL 15 from Debian itself: /var/lib/postgresql/15/main, configuration in /etc/postgresql, systemd postgresql@15-main
ubu24-pg16|1|ubuntu-24.04-standard|1024|8|setup_debian_distro 16|Ubuntu 24.04, PostgreSQL 16 from Ubuntu itself
deb12-pg17-custom|2|debian-12-standard|1024|8|setup_custom_layout 17|Debian 12, PostgreSQL 17 (PGDG) in /srv/pgdata/17 on port 5544, a tablespace in /srv/ts/fast, logs in /var/log/pg17
rocky9-pg14|3|rockylinux-9-default|1024|8|setup_rhel_pgdg 14|Rocky Linux 9, PostgreSQL 14 (PGDG RPM): /var/lib/pgsql/14/data, configuration inside PGDATA, systemd postgresql-14
deb12-pg18-two|4|debian-12-standard|1536|10|setup_two_instances 18|Debian 12, PostgreSQL 18 (PGDG) with TWO clusters on the same host (5432 and 5433): which one does the agent pick?
pat1|5|debian-12-standard|1024|8|setup_patroni 16|Patroni 3 nodes (1/3) + etcd, PostgreSQL 16 (PGDG), Debian packages
pat2|6|debian-12-standard|1024|8|setup_patroni 16|Patroni 3 nodes (2/3)
pat3|7|debian-12-standard|1024|8|setup_patroni 16|Patroni 3 nodes (3/3)
"

die() { echo "ERROR: $*" >&2; exit 1; }
row() { echo "$PROFILES" | awk -F'|' -v n="$1" '$1==n'; }
names() { echo "$PROFILES" | awk -F'|' 'NF>3{print $1}'; }
ctid() { echo $(( CTID0 + $(row "$1" | cut -d'|' -f2) )); }
ip_of() { pct exec "$(ctid "$1")" -- sh -c "hostname -I 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true; }
in_ct() { local id; id=$(ctid "$1"); shift; pct exec "$id" -- bash -c "$*"; }
expand() { if [ "${1:-}" = all ]; then names; else printf '%s\n' "$@"; fi; }

template() {
  local prefix=$1 f
  f=$(pveam list "$TSTORE" 2>/dev/null | awk '{print $1}' | grep "/${prefix}_" | sort | tail -1 || true)
  if [ -z "$f" ]; then
    pveam update >/dev/null
    local t; t=$(pveam available --section system | awk '{print $2}' | grep "^${prefix}_" | sort | tail -1)
    [ -n "$t" ] || die "no template ${prefix}_* (pveam available --section system)"
    pveam download "$TSTORE" "$t" >&2
    f="$TSTORE:vztmpl/$t"
  fi
  echo "$f"
}

net_for() {
  local off; off=$(row "$1" | cut -d'|' -f2)
  if [ -n "$IPBASE" ]; then
    [ -n "$GW" ] || die "IPBASE needs GW"
    local last=${IPBASE##*.} pre=${IPBASE%.*}
    local ip="$pre.$(( last + off ))"
    if ping -c1 -W1 "$ip" >/dev/null 2>&1; then die "$ip is already in use on the network (choose another IPBASE)"; fi
    echo "name=eth0,bridge=$BRIDGE,ip=$ip/24,gw=$GW"
  else echo "name=eth0,bridge=$BRIDGE,ip=dhcp"; fi
}

# ---------------------------------------------------------------- setups (run inside the container)
SEED_SQL="CREATE SCHEMA IF NOT EXISTS sales;
CREATE TABLE IF NOT EXISTS sales.customers (id int PRIMARY KEY, name text, city text);
CREATE TABLE IF NOT EXISTS sales.orders (id int PRIMARY KEY, customer_id int REFERENCES sales.customers(id), at timestamptz DEFAULT now(), total numeric(12,2));
INSERT INTO sales.customers SELECT g, 'c' || g, (ARRAY['Roma','Milano','Zurigo'])[1 + g % 3] FROM generate_series(1, 2000) g ON CONFLICT DO NOTHING;
INSERT INTO sales.orders SELECT g, 1 + g % 2000, now() - g * interval '1 minute', g % 500 FROM generate_series(1, 20000) g ON CONFLICT DO NOTHING;
CREATE OR REPLACE VIEW sales.v_city AS SELECT city, count(*) FROM sales.customers GROUP BY 1;"

base_debian() {
  in_ct "$1" 'export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8; apt-get update -qq && apt-get install -y -qq curl ca-certificates gnupg locales sudo procps less python3 >/dev/null
    sed -i "s/^# *it_IT.UTF-8/it_IT.UTF-8/; s/^# *en_US.UTF-8/en_US.UTF-8/" /etc/locale.gen && locale-gen >/dev/null'
}
pgdg_debian() {
  in_ct "$1" 'install -d /usr/share/postgresql-common/pgdg
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
    . /etc/os-release; echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq'
}
seed() {   # $1 name, $2 port, $3 extra PATH (RHEL keeps the tools in /usr/pgsql-N/bin): database "app" with pgbench tables and a small schema with a FK and a view
  local name=$1 port=${2:-5432} xp=${3:-}
  local f; f=$(mktemp); printf '%s\n' "$SEED_SQL" > "$f"; pct push "$(ctid "$name")" "$f" /tmp/seed.sql --perms 0644; rm -f "$f"
  in_ct "$name" "su - postgres -c 'export PATH=${xp:+$xp:}\$PATH; createdb -p $port app 2>/dev/null; pgbench -q -i -s 5 -p $port app && psql -q -v ON_ERROR_STOP=1 -p $port -d app -f /tmp/seed.sql'"
}

setup_debian_distro() {   # $1 = name, $2 = major (must be the distribution's own)
  base_debian "$1"
  in_ct "$1" "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-$2 postgresql-contrib >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-$2 >/dev/null; systemctl enable --now postgresql"
  seed "$1"
}
setup_custom_layout() {
  base_debian "$1"; pgdg_debian "$1"
  in_ct "$1" "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-common >/dev/null
    sed -i 's/^#\?create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-$2 >/dev/null
    install -d -o postgres -g postgres /srv/pgdata /srv/ts/fast /var/log/pg$2
    pg_createcluster $2 main -d /srv/pgdata/$2 -p 5544 -- --data-checksums
    echo \"log_directory = '/var/log/pg$2'\" >> /etc/postgresql/$2/main/postgresql.conf
    systemctl enable --now postgresql@$2-main
    su - postgres -c \"psql -p 5544 -c \\\"CREATE TABLESPACE fast LOCATION '/srv/ts/fast'\\\"\""
  seed "$1" 5544
  in_ct "$1" "su - postgres -c \"psql -p 5544 -d app -c 'CREATE TABLE sales.big_fast TABLESPACE fast AS SELECT g, md5(g::text) FROM generate_series(1,200000) g'\""
}
setup_rhel_pgdg() {
  # an up-to-date point release first: PGDG publishes only for current minors (rhel-9.4 is gone: 404 on its metadata)
  in_ct "$1" "set -e; dnf -q -y upgrade --refresh >/dev/null
    dnf -q -y install https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm >/dev/null
    dnf -q -y module disable postgresql >/dev/null 2>&1 || true
    dnf -q -y --disablerepo='pgdg*' --enablerepo=pgdg$2 --enablerepo=pgdg-common install postgresql$2-server postgresql$2-contrib procps-ng sudo glibc-langpack-it python3 >/dev/null
    /usr/pgsql-$2/bin/postgresql-$2-setup initdb && systemctl enable --now postgresql-$2"
  seed "$1" 5432 "/usr/pgsql-$2/bin"
}
setup_two_instances() {
  base_debian "$1"; pgdg_debian "$1"
  in_ct "$1" "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-$2 >/dev/null
    pg_createcluster $2 second -p 5433 && systemctl enable --now postgresql@$2-second"
  seed "$1" 5432
  in_ct "$1" "su - postgres -c \"psql -p 5433 -c 'CREATE DATABASE other' && pgbench -i -s 2 -p 5433 other\""
}
setup_patroni() {   # all three nodes are set up when pat3 is created (it needs the three addresses)
  local name=$1 major=$2
  base_debian "$name"; pgdg_debian "$name"
  in_ct "$name" "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-common >/dev/null
    sed -i 's/^#\?create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-$major etcd-server etcd-client patroni python3-etcd >/dev/null
    systemctl stop patroni etcd 2>/dev/null; systemctl disable patroni 2>/dev/null; true"
  [ "$name" = pat3 ] || return 0
  local i1 i2 i3; i1=$(ip_of pat1); i2=$(ip_of pat2); i3=$(ip_of pat3)
  [ -n "$i1" ] && [ -n "$i2" ] && [ -n "$i3" ] || die "Patroni nodes need addresses (pat1=$i1 pat2=$i2 pat3=$i3)"
  [ -n "$IPBASE" ] || echo "NOTE: Patroni/etcd configured with the DHCP addresses $i1 $i2 $i3: reserve them in the router (or recreate with IPBASE=...)"
  local cluster="pat1=http://$i1:2380,pat2=http://$i2:2380,pat3=http://$i3:2380"
  for n in pat1 pat2 pat3; do
    local me; me=$(ip_of $n)
    in_ct "$n" "cat > /etc/default/etcd <<EOF
ETCD_NAME=$n
ETCD_DATA_DIR=/var/lib/etcd/default
ETCD_LISTEN_PEER_URLS=http://$me:2380
ETCD_LISTEN_CLIENT_URLS=http://$me:2379,http://127.0.0.1:2379
ETCD_INITIAL_ADVERTISE_PEER_URLS=http://$me:2380
ETCD_ADVERTISE_CLIENT_URLS=http://$me:2379
ETCD_INITIAL_CLUSTER=$cluster
ETCD_INITIAL_CLUSTER_STATE=new
ETCD_INITIAL_CLUSTER_TOKEN=arca-pat
ETCD_ENABLE_V2=true
EOF
rm -rf /var/lib/etcd/default; systemctl enable etcd >/dev/null 2>&1; (systemctl restart etcd &)"
  done
  sleep 15
  for n in pat1 pat2 pat3; do
    local me; me=$(ip_of $n)
    in_ct "$n" "install -d -o postgres -g postgres /var/lib/postgresql/$major/patroni /var/log/patroni && chmod 700 /var/lib/postgresql/$major/patroni
cat > /etc/patroni/config.yml <<EOF
scope: arca-pat
name: $n
log: { dir: /var/log/patroni }
restapi: { listen: 0.0.0.0:8008, connect_address: $me:8008 }
etcd: { hosts: [ '$i1:2379', '$i2:2379', '$i3:2379' ] }
bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    postgresql:
      use_pg_rewind: true
      parameters: { wal_level: replica, hot_standby: 'on', max_wal_senders: 10, max_replication_slots: 10, wal_log_hints: 'on' }
      pg_hba:
        - local all all peer
        - host replication replicator 0.0.0.0/0 scram-sha-256
        - host all all 0.0.0.0/0 scram-sha-256
  initdb: [ { encoding: UTF8 }, data-checksums ]
postgresql:
  listen: 0.0.0.0:5432
  connect_address: $me:5432
  data_dir: /var/lib/postgresql/$major/patroni
  bin_dir: /usr/lib/postgresql/$major/bin
  pgpass: /var/lib/postgresql/.pgpass_patroni
  authentication:
    superuser: { username: postgres, password: '$PW' }
    replication: { username: replicator, password: '$PW' }
EOF
chown postgres:postgres /etc/patroni/config.yml; chmod 600 /etc/patroni/config.yml
systemctl enable patroni >/dev/null 2>&1; systemctl restart patroni"
    [ $n = pat1 ] && sleep 25
  done
  sleep 20
  in_ct pat1 "for i in \$(seq 30); do curl -sf http://127.0.0.1:8008/leader >/dev/null && break; curl -sf http://$i2:8008/leader >/dev/null && break; curl -sf http://$i3:8008/leader >/dev/null && break; sleep 3; done; patronictl -c /etc/patroni/config.yml list"
  local leader; leader=$(for n in pat1 pat2 pat3; do in_ct $n "curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:8008/leader" 2>/dev/null | grep -q 200 && { echo $n; break; }; done)
  [ -n "$leader" ] && seed "$leader"
}

# ---------------------------------------------------------------- commands
create_one() {
  local name=$1 r id tpl mem disk setup
  r=$(row "$name"); [ -n "$r" ] || die "unknown profile $name (./virgin.sh list)"
  id=$(ctid "$name")
  if pct status "$id" >/dev/null 2>&1; then echo "== $name ($id) exists: skipped"; return 0; fi
  tpl=$(template "$(echo "$r" | cut -d'|' -f3)"); mem=$(echo "$r" | cut -d'|' -f4); disk=$(echo "$r" | cut -d'|' -f5); setup=$(echo "$r" | cut -d'|' -f6)
  echo "== $name ($id): $(echo "$r" | cut -d'|' -f7)"
  pct create "$id" "$tpl" --hostname "$name" --memory "$mem" --swap 512 --cores 2 --rootfs "$STORAGE:$disk" --net0 "$(net_for "$name")" \
    ${IPBASE:+--nameserver "${DNS:-$GW}"} --unprivileged 1 --features nesting=1 --onboot 0 --password "$PW" --description "pg_arca virgin test server: $(echo "$r" | cut -d'|' -f7)" >/dev/null
  pct start "$id"
  for _ in $(seq 60); do [ -n "$(ip_of "$name")" ] && break; sleep 2; done
  [ -n "$(ip_of "$name")" ] || die "$name has no network address"
  local fn=${setup%% *} args=${setup#* }; $fn "$name" $args
  echo "   ok: $name at $(ip_of "$name")"
}
snapshot_all() {   # after everything is set up (Patroni needs its three nodes), each container is frozen as "virgin"
  for n in "$@"; do local id; id=$(ctid "$n"); pct listsnapshot "$id" 2>/dev/null | grep -q " $SNAP " || pct snapshot "$id" "$SNAP" --description "fresh: PostgreSQL + data, no pg_arca" >/dev/null && echo "   snapshot $SNAP: $n"; done
}

cmd=${1:-}; shift || true
case "$cmd" in
  list) echo "$PROFILES" | awk -F'|' -v c="$CTID0" 'NF>3{printf "%-20s ct %-4d %5s MB  %s\n", $1, c+$2, $4, $7}' ;;
  create)
    [ $# -gt 0 ] || die "create all | <name>..."
    command -v pct >/dev/null || die "run this on the Proxmox host"
    list=$(expand "$@")
    if echo "$list" | grep -q '^pat'; then list=$(echo "$list" | grep -v '^pat'; echo pat1; echo pat2; echo pat3); fi   # Patroni: always the three, in order
    ok=""; for n in $list; do if ( create_one "$n" ); then ok="$ok $n"; else echo "   FAILED: $n (the others go on; fix and run create $n again after ./virgin.sh destroy $n)"; fi; done
    snapshot_all $ok ;;
  status)
    for n in $(names); do id=$(ctid "$n")
      if ! pct status "$id" >/dev/null 2>&1; then printf '%-20s %-4s %s\n' "$n" "$id" "-"; continue; fi
      st=$(pct status "$id" | awk '{print $2}'); ip=$([ "$st" = running ] && ip_of "$n" || true)
      pg=$([ "$st" = running ] && pct exec "$id" -- sh -c "ps -eo args | grep -E '[p]ostgres( |:).*-D|[p]ostmaster' | head -3 | tr '\n' ';'" 2>/dev/null || true)
      printf '%-20s %-4s %-8s %-15s %s\n' "$n" "$id" "$st" "${ip:--}" "${pg:0:110}"
    done ;;
  reset)
    for n in $(expand "$@"); do id=$(ctid "$n"); pct status "$id" >/dev/null 2>&1 || continue
      pct listsnapshot "$id" | grep -q " $SNAP " || die "$n has no snapshot $SNAP"
      pct stop "$id" >/dev/null 2>&1 || true; pct rollback "$id" "$SNAP"; pct start "$id"; echo "reset: $n"; done ;;
  destroy)
    for n in $(expand "$@"); do id=$(ctid "$n"); pct status "$id" >/dev/null 2>&1 || continue
      pct stop "$id" >/dev/null 2>&1 || true; pct destroy "$id" --purge >/dev/null; echo "destroyed: $n"; done ;;
  sh) n=$1; shift; in_ct "$n" "$*" ;;
  agent)   # ./virgin.sh agent '<install command copied from the console>' <name>... : what the user does on each server, nothing more
    c=$1; shift; [ -n "$c" ] || die "agent '<command from the console>' all | <name>..."
    for n in $(expand "$@"); do echo "== $n"; in_ct "$n" "$c" || echo "   FAILED on $n"; done ;;
  *) sed -n '2,25p' "$0"; exit 1 ;;
esac
