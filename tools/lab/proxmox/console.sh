#!/bin/bash
# The pg_arca CONSOLE for the lab, in its own container on the Proxmox host, next to the virgin PostgreSQL servers (virgin.sh).
# It replaces the old laptop VM as the place where the console runs and where the browser tests (playwright) drive the web UI:
# the agents need a console address that does not change, and a VM bridged on a laptop's Wi-Fi loses it at every reboot.
#
# Run ON THE PROXMOX HOST as root:
#   ./console.sh create        container + Node 22 + chromium + playwright-core + console from GitHub main, as a systemd service (port 3000)
#   ./console.sh update        git pull (main) + npm install + restart        (what to run after every push)
#   ./console.sh status        service, address, version
#   ./console.sh key           the container's read-only GitHub deploy key (to register once)
#   ./console.sh sh '<cmd>'    run a command inside (as root, in the checkout /opt/pg_arca)
#   ./console.sh ui <script> [args]   run a browser test of tools/lab/ui (or tests/ui) against the console, inside the container
#   ./console.sh destroy
#
# Settings (environment):
#   CTID=420  NAME=arca-console  IP=192.168.1.220  GW=192.168.1.1  BRIDGE=vmbr0  STORAGE=local-lvm  TSTORE=local
#   REPO=git@github.com:lucatosh/pg_arca_v2.git  BRANCH=main
# GitHub access: ONLY this container fetches the code, with a read-only deploy key it generates (/root/.ssh/arca_deploy, printed by `create` and
# `key`): add it once in GitHub -> repository -> Settings -> Deploy keys (write access OFF). The database servers never need GitHub: they get the
# agent from the console ("Genera comando"). While the key is not registered and the repository is public, the anonymous HTTPS URL is used.
#   ADMIN_USER=claude-test  ADMIN_PASS=claude-lab-test-pass-1        (lab only: the first administrator, created at the first start)
set -euo pipefail
CTID=${CTID:-420}; NAME=${NAME:-arca-console}; IP=${IP:-192.168.1.220}; GW=${GW:-192.168.1.1}; BRIDGE=${BRIDGE:-vmbr0}
STORAGE=${STORAGE:-local-lvm}; TSTORE=${TSTORE:-local}; REPO=${REPO:-git@github.com:lucatosh/pg_arca_v2.git}; HTTPS_REPO=https://github.com/${REPO#git@github.com:}; BRANCH=${BRANCH:-main}
ADMIN_USER=${ADMIN_USER:-claude-test}; ADMIN_PASS=${ADMIN_PASS:-claude-lab-test-pass-1}
die() { echo "ERROR: $*" >&2; exit 1; }
in_ct() { pct exec "$CTID" -- bash -c "$*"; }
GITSSH='GIT_SSH_COMMAND="ssh -i /root/.ssh/arca_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"'
key() { in_ct 'test -f /root/.ssh/arca_deploy || ssh-keygen -q -t ed25519 -N "" -C arca-console-lab-readonly -f /root/.ssh/arca_deploy; cat /root/.ssh/arca_deploy.pub'; }
# the deploy key when GitHub accepts it, else anonymous HTTPS (public repository); says which
remote() { if in_ct "$GITSSH git ls-remote -q $REPO HEAD >/dev/null 2>&1"; then echo "$REPO"; else echo "deploy key not accepted by GitHub (register it: ./console.sh key): trying anonymous HTTPS" >&2; echo "$HTTPS_REPO"; fi; }

create() {
  pct status "$CTID" >/dev/null 2>&1 && { echo "container $CTID exists"; return 0; }
  ping -c1 -W1 "$IP" >/dev/null 2>&1 && die "$IP is already in use (IP=...)"
  local t; t=$(pveam list "$TSTORE" | awk '{print $1}' | grep '/debian-12-standard_' | sort | tail -1)
  [ -n "$t" ] || die "Debian 12 template missing (./virgin.sh create downloads it)"
  pct create "$CTID" "$t" --hostname "$NAME" --memory 3072 --swap 1024 --cores 2 --rootfs "$STORAGE:16" \
    --net0 "name=eth0,bridge=$BRIDGE,ip=$IP/24,gw=$GW" --nameserver "$GW 1.1.1.1" --unprivileged 1 --features nesting=1 --onboot 1 >/dev/null
  pct start "$CTID"; sleep 5
  in_ct 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl ca-certificates git python3 chromium fonts-dejavu-core postgresql-client >/dev/null
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null && apt-get install -y -qq nodejs >/dev/null
    node --version'
  echo "read-only deploy key of this container (GitHub -> Settings -> Deploy keys, write access OFF):"; key
  local r; r=$(remote)
  in_ct "$GITSSH git clone -q -b $BRANCH $r /opt/pg_arca && cd /opt/pg_arca && npm install --no-audit --no-fund --loglevel=error"
  in_ct "install -d -m 700 /var/lib/pg-arca-console; install -d /opt/uitest && cd /opt/uitest && npm init -y >/dev/null && npm install --no-audit --no-fund --loglevel=error playwright-core@1.49.1"
  in_ct "cat > /etc/systemd/system/pg-arca-console.service <<EOF
[Unit]
Description=pg_arca console (lab)
After=network-online.target
[Service]
WorkingDirectory=/opt/pg_arca
Environment=PORT=3000 PG_ARCA_DATA_DIR=/var/lib/pg-arca-console PG_ARCA_ADMIN_USER=$ADMIN_USER PG_ARCA_ADMIN_PASSWORD=$ADMIN_PASS
ExecStartPre=/usr/bin/npx vite build --logLevel error
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload; systemctl enable --now pg-arca-console"
  sleep 20; status
}
update() {
  local r; r=$(remote)
  in_ct "cd /opt/pg_arca && git remote set-url origin $r && $GITSSH git fetch -q origin $BRANCH && git reset -q --hard origin/$BRANCH && npm install --no-audit --no-fund --loglevel=error && npx tsc --noEmit -p . && systemctl restart pg-arca-console && git log --oneline -1"
  for i in $(seq 40); do in_ct "curl -sf -o /dev/null http://127.0.0.1:3000/api/auth/status" && { echo "console up: http://$IP:3000"; return 0; }; sleep 3; done
  die "console not answering after restart: journalctl -u pg-arca-console -n 50"
}
status() { in_ct "systemctl is-active pg-arca-console; cd /opt/pg_arca && git log --oneline -1; curl -s -o /dev/null -w 'http %{http_code}\n' http://127.0.0.1:3000/api/auth/status"; echo "console: http://$IP:3000"; }
ui() {
  local s=$1; shift
  in_ct "cd /opt/pg_arca && NODE_PATH=/opt/uitest/node_modules PW_CHROMIUM=/usr/bin/chromium PG_ARCA_URL=http://127.0.0.1:3000 node $s $*"
}
case "${1:-}" in
  create) create ;;
  update) update ;;
  key) key ;;
  status) status ;;
  sh) shift; in_ct "cd /opt/pg_arca && $*" ;;
  ui) shift; ui "$@" ;;
  destroy) pct stop "$CTID" 2>/dev/null || true; pct destroy "$CTID" ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
