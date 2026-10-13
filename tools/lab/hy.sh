#!/bin/bash
# Lab "hy": geo-redundant pair across Docker (this VM: site hy-mi, PRIMARY) and the Proxmox host (site hy-rm, STANDBY), Rocky Linux 9, shared NFS archive.
# Built the way a customer's DBAs would build it; pg_arca is then attached ONLY from the console (agents, archiving, destination, geo).
#   hy.sh up            NFS export on Proxmox, Docker site (build, PostgreSQL+Patroni, seed), Proxmox site (3 containers, standby cluster), NFS mounts
#   hy.sh status        both sites (patronictl), replication between them
#   hy.sh agent-a '<install command>' / agent-b '<install command>'   run the console's install command on the nodes of a site
#   hy.sh kill-a | start-a      the whole primary site goes down (disaster) / comes back
#   hy.sh wan-cut | wan-restore the standby site loses / gets back the link to the primary site (no disaster: must NOT fail over)
#   hy.sh sql-a|sql-b '<sql>'   SQL on the site's leader (database shop)
#   hy.sh destroy       everything of this lab (Docker and Proxmox)
set -euo pipefail
cd "$(dirname "$0")"
PVE=${PVE:-root@192.168.1.5}; GW=192.168.1.1; IPB=(192.168.1.230 192.168.1.231 192.168.1.232); CT=(420 421 422); NM=(hyb1 hyb2 hybx)
VMIP=${VMIP:-192.168.1.179}; NFS="192.168.1.5:/srv/arca-hy"
DC="docker compose -f hy/docker-compose.hy.yml"
pve() { ssh -o BatchMode=yes "$PVE" "$@"; }
inct() { local id=$1; shift; pve "pct exec $id -- bash -c $(printf %q "$*")"; }
pushct() { scp -q -o BatchMode=yes "$2" "$PVE:/tmp/$(basename "$2")" && pve "pct push $1 /tmp/$(basename "$2") /root/$(basename "$2") --perms 0755"; }
leader() { case $1 in a) for n in hy1 hy2; do [ "$(docker exec $n curl -s -o /dev/null -w '%{http_code}' localhost:8008/leader 2>/dev/null)" = 200 ] && { echo $n; return; }; done ;;
                     b) for i in 0 1; do [ "$(inct ${CT[$i]} "curl -s -o /dev/null -w '%{http_code}' localhost:8008/leader" 2>/dev/null)" = 200 ] && { echo ${CT[$i]}; return; }; done ;; esac; return 1; }
case "${1:-help}" in
  up)
    echo "== NFS export on the Proxmox host (shared archive / backups of the pair)"
    pve "dpkg -s nfs-kernel-server >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nfs-kernel-server >/dev/null; install -d -o 26 -g 26 /srv/arca-hy;
         grep -q '^/srv/arca-hy ' /etc/exports || echo '/srv/arca-hy 192.168.1.0/24(rw,sync,no_subtree_check)' >> /etc/exports; exportfs -ra; exportfs -v | grep arca-hy"
    echo "== site hy-mi (Docker)"
    $DC up -d --build
    for n in hy1 hy2; do docker cp hy/prep-rocky.sh $n:/root/prep-rocky.sh; done
    docker exec hy1 bash /root/prep-rocky.sh pg hy-mi hy-etcd:2379 | tail -3
    docker exec hy2 bash /root/prep-rocky.sh pg hy-mi hy-etcd:2379 | tail -3
    l=$(leader a); docker exec "$l" bash /root/prep-rocky.sh seed
    for n in hy1 hy2; do docker exec $n bash /root/prep-rocky.sh nfs "$NFS"; done
    "$0" prep-b
    for i in 0 1; do inct ${CT[$i]} "/root/prep-rocky.sh pg hy-rm ${IPB[2]}:2379 $VMIP 15432 geo_hy_rm" | tail -3; done
    "$0" status ;;
  prep-b)   # the standby site's machines, ready but without Patroni started (can run while the Docker site is still being built)
    echo "== site hy-rm (Proxmox): containers, packages, etcd + HAProxy, NFS"
    t=$(pve "pveam list local | awk '{print \$1}' | grep rockylinux-9 | sort | tail -1"); [ -n "$t" ] || { echo "no Rocky 9 template on Proxmox"; exit 1; }
    for i in 0 1 2; do
      if ! pve "pct status ${CT[$i]}" >/dev/null 2>&1; then
        pve "ping -c1 -W1 ${IPB[$i]} >/dev/null 2>&1" && { echo "${IPB[$i]} in use"; exit 1; }
        mem=$([ $i = 2 ] && echo 512 || echo 1536)
        pve "pct create ${CT[$i]} $t --hostname ${NM[$i]} --memory $mem --swap 512 --cores 2 --rootfs local-lvm:10 --net0 name=eth0,bridge=vmbr0,ip=${IPB[$i]}/24,gw=$GW --nameserver '$GW 1.1.1.1' --unprivileged 0 --features nesting=1,mount=nfs --onboot 1 >/dev/null && pct start ${CT[$i]}"
        sleep 8
        inct ${CT[$i]} "dnf -y -q upgrade --refresh >/dev/null; dnf -y -q install sudo procps-ng iproute nfs-utils python3 tar curl which >/dev/null"
      fi
    done
    pushct ${CT[2]} hy/hybx.sh; inct ${CT[2]} "/root/hybx.sh ${IPB[0]} ${IPB[1]}"
    for i in 0 1; do pushct ${CT[$i]} hy/prep-rocky.sh; inct ${CT[$i]} "/root/prep-rocky.sh nfs $NFS; /root/prep-rocky.sh pkgs"; done ;;
  status)
    echo "== hy-mi (Docker)"; l=$(leader a || echo hy1); docker exec "$l" patronictl -c /etc/patroni/patroni.yml list 2>&1 | tail -n +1
    echo "== hy-rm (Proxmox)"; l=$(leader b || echo ${CT[0]}); inct "$l" "patronictl -c /etc/patroni/patroni.yml list" 2>&1
    l=$(leader a || true); [ -n "$l" ] && docker exec "$l" sudo -u postgres psql -XAtc "select slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) from pg_replication_slots" 2>/dev/null || true ;;
  agent-a) for n in hy1 hy2; do echo "== $n"; docker exec $n bash -c "$2" 2>&1 | tail -3; done ;;
  agent-b) for i in 0 1; do echo "== ${NM[$i]}"; inct ${CT[$i]} "$2" 2>&1 | tail -3; done ;;
  kill-a)  docker stop -t 2 hy1 hy2 hy-haproxy hy-etcd >/dev/null && echo "site hy-mi DOWN (containers stopped at $(date +%T))" ;;
  start-a) docker start hy-etcd hy1 hy2 hy-haproxy >/dev/null && echo "site hy-mi started at $(date +%T)" ;;
  wan-cut) for ip in ${IPB[@]}; do sudo -n iptables -I DOCKER-USER -s $ip -j DROP; done; echo "WAN cut at $(date +%T): hy-rm no longer reaches hy-mi (agents still reach the console)" ;;
  wan-restore) for ip in ${IPB[@]}; do while sudo -n iptables -D DOCKER-USER -s $ip -j DROP 2>/dev/null; do :; done; done; echo "WAN restored at $(date +%T)" ;;
  sql-a) l=$(leader a); docker exec "$l" sudo -u postgres psql -XAt -d shop -c "$2" ;;
  sql-b) l=$(leader b); inct "$l" "sudo -u postgres psql -XAt -d shop -c $(printf %q "$2")" ;;
  destroy) $DC down -v || true; for i in 0 1 2; do pve "pct stop ${CT[$i]} 2>/dev/null; pct destroy ${CT[$i]} --purge 2>/dev/null" || true; done ;;
  *) sed -n 2,13p "$0" ;;
esac
