#!/bin/bash
# Lab: ONE password for every lab machine and every PostgreSQL role the lab creates (root, postgres, replicator, rewinder), and ssh as root on every
# container. The password is never written in the repository: it comes from LAB_PW (on the VM: ~/.arca-lab-pw). Listed in LAB-ACCESS.md (private repo).
# (the inner script travels as base64 in the command: stdin does not reliably pass through pct exec)
# Run ON the Proxmox host:   LAB_PW=... ./standard-access.sh [ctid ...]      (default: every running container)
#   - sshd installed and enabled, root login with password allowed (lab only: /etc/ssh/sshd_config.d/10-arca-lab.conf)
#   - root password = LAB_PW
#   - PostgreSQL: on a PRIMARY, ALTER ROLE postgres / replicator / rewinder (those that exist) PASSWORD LAB_PW (every instance of the host);
#     Patroni nodes: the passwords in the Patroni configuration too (authentication.*), then a reload
set -u
PW=${LAB_PW:?set LAB_PW}
case "$PW" in *"'"*|*'"'*|*'\'*|*' '*) echo "LAB_PW must not contain quotes, backslashes or spaces"; exit 2;; esac
inner() {
cat <<'IN'
set -u
log() { printf '%s; ' "$*"; }
# ssh
if ! command -v sshd >/dev/null 2>&1; then
  if command -v apt-get >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null 2>&1; }
  else dnf -y -q install openssh-server >/dev/null 2>&1; fi
fi
if command -v sshd >/dev/null 2>&1; then
  install -d /etc/ssh/sshd_config.d
  grep -q '^Include /etc/ssh/sshd_config.d/' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
  printf 'PermitRootLogin yes\nPasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/10-arca-lab.conf
  ssh-keygen -A >/dev/null 2>&1
  { systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1; }; { systemctl restart ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1; }
  log "ssh ok"
else log "ssh NOT installed"; fi
echo "root:$PW" | chpasswd && log "root pw"
# PostgreSQL roles: every local instance, by its socket
for s in /var/run/postgresql/.s.PGSQL.* /run/postgresql/.s.PGSQL.* /tmp/.s.PGSQL.*; do
  [ -S "$s" ] || continue; port=${s##*.}; dir=${s%/.s.PGSQL.*}
  q() { su postgres -s /bin/sh -c "cd / && psql -XAtq -h $dir -p $port -d postgres -c \"$1\"" 2>/dev/null; }
  [ "$(q 'select pg_is_in_recovery()')" = f ] || { log "pg:$port standby (roles come from its primary)"; continue; }
  for r in postgres replicator rewinder; do
    [ "$(q "select 1 from pg_roles where rolname='$r'")" = 1 ] && q "ALTER ROLE $r PASSWORD '$PW'" >/dev/null && log "pg:$port $r"
  done
done
# Patroni: the passwords it uses to connect (superuser / replication / rewind), then reload
for f in /etc/patroni/config.yml /etc/patroni/patroni.yml /etc/patroni.yml; do
  [ -f "$f" ] || continue
  python3 - "$f" "$PW" <<'PY'
import re, sys
p, pw = sys.argv[1], sys.argv[2]
s = open(p).read(); i = s.find("authentication:")
if i >= 0:
    head, tail = s[:i], s[i:]
    tail = re.sub(r"(password:\s*)(['\"]?)[^'\"\s,}]*\2", lambda m: m.group(1) + "'" + pw + "'", tail)
    open(p, "w").write(head + tail)
PY
  systemctl reload patroni >/dev/null 2>&1 || systemctl restart patroni >/dev/null 2>&1; log "patroni $f"
done
IN
}
B64=$(inner | base64 -w0)
ids=${*:-$(pct list | awk 'NR>1 && $2=="running"{print $1}')}
for id in $ids; do
  name=$(pct config "$id" | awk -F': ' '/^hostname/{print $2}')
  out=$(pct exec "$id" -- bash -c "echo $B64 | base64 -d > /root/.arca-std.sh && PW='$PW' bash /root/.arca-std.sh </dev/null; rm -f /root/.arca-std.sh" 2>&1)
  echo "$id $name: $out"
done
