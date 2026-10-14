#!/bin/bash
# Lab: run a command as root on a node of the console, whatever it is: a Docker container on this VM, or a Proxmox container (by hostname, via the host).
#   tools/lab/ui/node.sh <node name> '<command>'      (stdin is passed through)
set -euo pipefail
node=$1; cmd=$2; PVE=${PVE:-root@192.168.1.5}
if docker inspect "$node" >/dev/null 2>&1; then exec docker exec -i "$node" bash -c "$cmd"; fi
id=$(ssh -o BatchMode=yes "$PVE" "pct list | awk -v n='$node' '\$NF==n{print \$1}'")
[ -n "$id" ] || { echo "node $node: not a container on this VM nor on the Proxmox host" >&2; exit 2; }
exec ssh -o BatchMode=yes "$PVE" "pct exec $id -- bash -c $(printf %q "$cmd")"
