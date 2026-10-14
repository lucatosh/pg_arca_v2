#!/usr/bin/env bash
# Lab VM: copy a release directory to the Proxmox host and test it on fresh containers (tools/lab/proxmox/release-test.sh).
#   tools/lab/release-test.sh [release dir, default ~/release] [deb12 rocky9 ubu24]
set -euo pipefail
cd "$(dirname "$0")"
R=${1:-$HOME/release}; shift || true
PVE=${PVE:-root@192.168.1.5}
ssh -o BatchMode=yes "$PVE" 'rm -rf /root/pg-arca-release && mkdir -p /root/pg-arca-release/tools'
scp -q -o BatchMode=yes "$R"/* "$PVE:/root/pg-arca-release/"
scp -q -o BatchMode=yes proxmox/release-test.sh proxmox/release-test-ct.sh "$PVE:/root/pg-arca-release/tools/"
ssh -o BatchMode=yes "$PVE" "KEEP=${KEEP:-0} bash /root/pg-arca-release/tools/release-test.sh /root/pg-arca-release $*"
