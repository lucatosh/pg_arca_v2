#!/bin/bash
# Lab: what runs on the Proxmox host, one line per container / VM:  id|name|ip|os|status|sshd|postgres
# Run ON the Proxmox host (from the VM: ssh root@192.168.1.5 bash -s < tools/lab/proxmox/inventory.sh). Feeds LAB-ACCESS.md.
set -u
echo "host|$(hostname)|$(hostname -I | awk '{print $1}')|$(pveversion | head -1)"
for id in $(pct list | awk 'NR>1{print $1}'); do
  cfg=$(pct config "$id")
  name=$(awk -F': ' '/^hostname/{print $2}' <<<"$cfg")
  ip=$(grep -o 'ip=[0-9./]*' <<<"$cfg" | head -1 | sed 's/ip=//; s#/.*##')
  st=$(pct status "$id" | awk '{print $2}')
  os=""; ssh=""; pg=""
  if [ "$st" = running ]; then
    os=$(pct exec "$id" -- sh -c '. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"' 2>/dev/null)
    ssh=$(pct exec "$id" -- sh -c 'command -v sshd >/dev/null && echo yes || echo no' 2>/dev/null)
    pg=$(pct exec "$id" -- sh -c 'ps -eo args | grep -E "^/[^ ]*/(postgres|postmaster) " | sed -E "s#.*/([0-9]+)/bin/(postgres|postmaster).*-D ([^ ]+).*#PG\1 \3#" | head -2 | tr "\n" " "' 2>/dev/null)
    [ -z "$ip" ] && ip=$(pct exec "$id" -- sh -c "hostname -I | awk '{print \$1}'" 2>/dev/null)
  fi
  echo "ct|$id|$name|$ip|$os|$st|$ssh|$pg"
done
qm list 2>/dev/null | awk 'NR>1{print "vm|"$1"|"$2"||"$3}'
