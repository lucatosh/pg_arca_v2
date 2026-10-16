#!/usr/bin/env bash
# ==============================================================================
# pg_arca console installer — Linux x86_64 with systemd (RHEL/Rocky/Alma 8-10, Debian 11-13, Ubuntu 20.04-24.04)
#
# Run it from the extracted release package (pg-arca-console-<version>-linux-x64/):
#   sudo ./install-console.sh                         first install, or upgrade in place (same command)
#   sudo ./install-console.sh --port 8443 --tls-cert /path/console.crt --tls-key /path/console.key
#   sudo ./install-console.sh --tls-self-signed       trial: generates a self-signed certificate (kept on re-runs: the agents pin it)
#   sudo ./install-console.sh --tls-regenerate        a NEW self-signed certificate: every agent must then get the new one (PG_ARCA_TLS_CA)
#   sudo ./install-console.sh --status
#   sudo ./install-console.sh --backup-state [DIR]    copy of the console state (users, clusters, policies, history, secret key)
#   sudo ./install-console.sh --restore-state FILE --yes   load a state backup (same or another host: install the console first, then restore)
#   sudo ./install-console.sh --rollback --yes        back to the previous release AND its pre-upgrade state
#   sudo ./install-console.sh --uninstall [--purge]   remove the service and code; --purge also deletes the state
#
# Layout:  /opt/pg-arca-console/releases/<version>   code (read-only, root), /opt/pg-arca-console/current -> the release in service
#          /etc/pg-arca-console/console.env           settings (never overwritten by an upgrade)
#          /var/lib/pg-arca-console                   state (service user only, 0700); backups/ holds the pre-upgrade copies
#          pg-arca-console.service                    hardened systemd unit, runs as the system user pgarca-console
# Every option can also be given as an environment variable: PORT, PG_ARCA_LISTEN, PG_ARCA_TLS_CERT, PG_ARCA_TLS_KEY (first install only).
# ==============================================================================
set -euo pipefail

PREFIX=/opt/pg-arca-console; CONF_DIR=/etc/pg-arca-console; DATA_DIR=/var/lib/pg-arca-console; SVC_USER=pgarca-console; UNIT=pg-arca-console
ENV_FILE=$CONF_DIR/console.env; UNIT_FILE=/etc/systemd/system/$UNIT.service; KEEP_RELEASES=3

die() { echo "ERROR: $*" >&2; exit 1; }
note() { echo "-- $*"; }

ACTION=install; PURGE=0; YES=0; NO_START=0; SELF_SIGNED=0; BACKUP_DEST=""; RESTORE_FILE=""
OPT_PORT="${PORT:-}"; OPT_LISTEN="${PG_ARCA_LISTEN:-}"; OPT_CERT="${PG_ARCA_TLS_CERT:-}"; OPT_KEY="${PG_ARCA_TLS_KEY:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) OPT_PORT="${2:?--port needs a value}"; shift ;;
    --listen) OPT_LISTEN="${2:?--listen needs an address}"; shift ;;
    --tls-cert) OPT_CERT="${2:?--tls-cert needs a file}"; shift ;;
    --tls-key) OPT_KEY="${2:?--tls-key needs a file}"; shift ;;
    --tls-self-signed) SELF_SIGNED=1 ;;
    --tls-regenerate) SELF_SIGNED=1; REGEN=1 ;;
    --no-start) NO_START=1 ;;
    --status) ACTION=status ;;
    --backup-state) ACTION=backup; if [[ -n "${2:-}" && "${2:0:2}" != -- ]]; then BACKUP_DEST="$2"; shift; fi ;;
    --restore-state) ACTION=restore; RESTORE_FILE="${2:?--restore-state needs the backup file}"; shift ;;
    --rollback) ACTION=rollback ;;
    --uninstall) ACTION=uninstall ;;
    --purge) PURGE=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

installed_version() { [[ -f "$PREFIX/current/VERSION" ]] && tr -d '[:space:]' < "$PREFIX/current/VERSION" || true; }
read_env() { [[ -f "$ENV_FILE" ]] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 || true; }
health_url() {
  local port listen cert scheme host
  port="$(read_env PORT)"; port="${port:-3000}"; listen="$(read_env PG_ARCA_LISTEN)"; cert="$(read_env PG_ARCA_TLS_CERT)"
  scheme=http; [[ -n "$cert" ]] && scheme=https
  case "$listen" in ""|0.0.0.0) host=127.0.0.1 ;; ::) host='[::1]' ;; *:*) host="[$listen]" ;; *) host="$listen" ;; esac
  echo "$scheme://$host:$port/api/health"
}
# the version the running console reports (empty if it does not answer)
running_version() {
  local url; url="$(health_url)"
  if command -v curl >/dev/null; then curl -fsSk --max-time 3 "$url" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
  else "$(node_bin "$PREFIX/current")" -e 'const u=process.argv[1];(u.startsWith("https")?require("https"):require("http")).get(u,{rejectUnauthorized:false,timeout:3000},r=>{let b="";r.on("data",d=>b+=d);r.on("end",()=>{try{console.log(JSON.parse(b).version||"")}catch{}})}).on("error",()=>{})' "$url" 2>/dev/null; fi
}
node_bin() {   # the runtime shipped in the release, else the system's Node.js >= 20
  if [[ -x "$1/node/bin/node" ]]; then echo "$1/node/bin/node"; return; fi
  local n; n="$(command -v node || true)"; [[ -n "$n" ]] || return 1
  "$n" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || return 1
  echo "$n"
}
wait_healthy() {   # $1 = expected version; up to ~60 s
  local v=""
  for _ in $(seq 1 60); do
    v="$(running_version || true)"; [[ "$v" == "$1" ]] && return 0
    systemctl is-active --quiet "$UNIT" || { sleep 1; systemctl is-active --quiet "$UNIT" || return 1; }
    sleep 1
  done
  return 1
}
backup_state() {   # $1 = destination directory, $2 = label; prints the archive path
  local dest="$1" label="$2" f
  [[ -d "$dest" ]] || install -d -m 0700 "$dest"
  f="$dest/console-state-$label-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  # the store writes each generation to a temp file and renames it (state.json + state.json.bak): a live copy is consistent
  tar czf "$f" -C "$DATA_DIR" --exclude=./backups . || die "state backup failed ($f)"
  chmod 0600 "$f"
  echo "$f"
}

case "$ACTION" in
# ------------------------------------------------------------------------------
status)
  iv="$(installed_version)"; [[ -n "$iv" ]] || { echo "pg_arca console: not installed"; exit 1; }
  echo "installed release: $iv ($(readlink -f "$PREFIX/current"))"
  [[ -f "$PREFIX/previous" ]] && echo "previous release:  $(cat "$PREFIX/previous") (--rollback)"
  echo "service:           $(systemctl is-active "$UNIT" 2>/dev/null || true) ($UNIT)"
  rv="$(running_version || true)"; echo "answering:         ${rv:-no answer on $(health_url)}"
  echo "settings:          $ENV_FILE"; echo "state:             $DATA_DIR ($(du -sh "$DATA_DIR" 2>/dev/null | cut -f1))"
  exit 0 ;;
# ------------------------------------------------------------------------------
backup)
  [[ -d "$DATA_DIR" ]] || die "no console state in $DATA_DIR"
  id "$SVC_USER" &>/dev/null || die "the service user $SVC_USER does not exist: is the console installed?"
  f="$(backup_state "${BACKUP_DEST:-$DATA_DIR/backups}" "v$(installed_version)")"
  echo "console state saved: $f"
  echo "It contains the secret key that encrypts stored credentials: keep it as safe as the console itself."
  exit 0 ;;
# ------------------------------------------------------------------------------
uninstall)
  systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"; systemctl daemon-reload 2>/dev/null || true
  rm -rf "$PREFIX"
  if [[ $PURGE == 1 ]]; then
    [[ $YES == 1 ]] || die "--purge deletes users, clusters, policies, history and the secret key in $DATA_DIR: add --yes to confirm"
    rm -rf "$DATA_DIR" "$CONF_DIR"; userdel "$SVC_USER" 2>/dev/null || true
    echo "pg_arca console removed, state and settings DELETED."
  else
    echo "pg_arca console removed. State kept in $DATA_DIR and settings in $CONF_DIR (reinstalling picks them up; --uninstall --purge --yes deletes them)."
  fi
  echo "The agents on the database servers keep running and keep archiving WAL; remove them there with PG_ARCA_UNINSTALL=1 if needed."
  exit 0 ;;
# ------------------------------------------------------------------------------
restore)
  [[ -f "$RESTORE_FILE" ]] || die "backup file not found: $RESTORE_FILE"
  id "$SVC_USER" &>/dev/null && [[ -f "$UNIT_FILE" ]] || die "install the console first (same release as the one that made the backup, or newer), then restore its state"
  tar tzf "$RESTORE_FILE" 2>/dev/null | grep -qx './state.json' || die "$RESTORE_FILE is not a console state backup (no state.json inside; expected a file made by --backup-state)"
  cur="$(installed_version)"
  if [[ $YES != 1 ]]; then
    echo "Restoring $RESTORE_FILE replaces the whole state of this console (users, clusters, policies, history, secret key) with the one in the backup;"
    echo "the current state is saved in $DATA_DIR/backups first. Agents enrolled with the old console keep working only if its secret key is the same one."
    die "add --yes to confirm"
  fi
  systemctl stop "$UNIT"
  keep="$(backup_state "$DATA_DIR/backups" "before-restore")"
  find "$DATA_DIR" -mindepth 1 -maxdepth 1 ! -name backups -exec rm -rf {} +
  tar xzf "$RESTORE_FILE" -C "$DATA_DIR" --exclude=./backups; chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"; chmod 0700 "$DATA_DIR"
  systemctl reset-failed "$UNIT" 2>/dev/null || true; systemctl start "$UNIT"
  wait_healthy "$cur" && echo "state restored from $RESTORE_FILE (previous state kept in $keep)" || { journalctl -u "$UNIT" -n 30 --no-pager; die "the console does not answer after the restore (previous state: $keep)"; }
  echo "If the console moved to another host: agents still point at the old address; on each node set \"web_server_url\" in /etc/pg-arca/agent.conf to the new address and restart pg-arca-agent (the enrollment stays valid: same secret key)."
  exit 0 ;;
# ------------------------------------------------------------------------------
rollback)
  [[ -f "$PREFIX/previous" ]] || die "no previous release recorded: nothing to roll back to"
  prev="$(cat "$PREFIX/previous")"; cur="$(installed_version)"
  [[ -d "$PREFIX/releases/$prev" ]] || die "release $prev is no longer in $PREFIX/releases"
  snap="$(ls -1t "$DATA_DIR"/backups/console-state-pre-upgrade-to-v"$cur"-*.tar.gz 2>/dev/null | head -1 || true)"
  [[ -n "$snap" ]] || die "no pre-upgrade state backup for $cur in $DATA_DIR/backups: roll back by hand"
  if [[ $YES != 1 ]]; then
    echo "Rollback $cur -> $prev restores the state saved before the upgrade ($snap):"
    echo "every change made in the console since then (users, policies, history) is lost; backups on the servers are not touched."
    die "add --yes to confirm"
  fi
  systemctl stop "$UNIT"
  keep="$(backup_state "$DATA_DIR/backups" "before-rollback-from-v$cur")"
  find "$DATA_DIR" -mindepth 1 -maxdepth 1 ! -name backups -exec rm -rf {} +
  tar xzf "$snap" -C "$DATA_DIR"; chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
  ln -sfn "releases/$prev" "$PREFIX/current"; rm -f "$PREFIX/previous"
  NB="$(node_bin "$PREFIX/current")" || die "no usable Node.js runtime for release $prev"
  sed -i "s#^ExecStart=.*#ExecStart=$NB $PREFIX/current/server.mjs#" "$UNIT_FILE"; systemctl daemon-reload; systemctl reset-failed "$UNIT" 2>/dev/null || true
  systemctl start "$UNIT"
  wait_healthy "$prev" && echo "rolled back to $prev (state of $cur kept in $keep)" || { journalctl -u "$UNIT" -n 30 --no-pager; die "release $prev does not answer after the rollback"; }
  exit 0 ;;
esac

# ------------------------------------------------------------------------------
# install / upgrade
# ------------------------------------------------------------------------------
[[ -f "$PKG/VERSION" && -f "$PKG/server.mjs" && -d "$PKG/dist" && -d "$PKG/unix-agent" ]] || die "run this script from the extracted release package (VERSION, server.mjs, dist/, unix-agent/ next to it)"
NEW="$(tr -d '[:space:]' < "$PKG/VERSION")"
[[ -d /run/systemd/system ]] || die "systemd is not running here. For containers use the image (packaging/console/Dockerfile); by hand: NODE_ENV=production PG_ARCA_DATA_DIR=<dir> node server.mjs"
[[ "$(uname -m)" == x86_64 || ! -x "$PKG/node/bin/node" ]] || die "this package ships an x86_64 Node.js runtime; this machine is $(uname -m)"
node_bin "$PKG" >/dev/null || die "Node.js >= 20 is needed: this package has no runtime of its own and none was found in PATH"
command -v tar >/dev/null || die "tar is needed (the console serves the agent bundle with it)"
OLD="$(installed_version)"
if [[ -n "$OLD" ]]; then
  if [[ "$OLD" == "$NEW" ]]; then note "release $NEW is already installed: refreshing the files and the unit"; else note "upgrade $OLD -> $NEW"; fi
else
  note "installing pg_arca console $NEW"
fi
[[ -z "$OPT_PORT" || "$OPT_PORT" =~ ^[0-9]+$ && "$OPT_PORT" -ge 1 && "$OPT_PORT" -le 65535 ]] || die "--port must be 1-65535"
[[ -z "$OPT_CERT$OPT_KEY" || ( -n "$OPT_CERT" && -n "$OPT_KEY" ) ]] || die "--tls-cert and --tls-key go together"
[[ $SELF_SIGNED == 0 || -z "$OPT_CERT" ]] || die "--tls-self-signed or --tls-cert/--tls-key, not both"

# --- user and directories -------------------------------------------------------
if ! id "$SVC_USER" &>/dev/null; then
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER" 2>/dev/null \
    || useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /sbin/nologin "$SVC_USER" || die "cannot create the system user $SVC_USER"
fi
install -d -m 0755 "$PREFIX" "$PREFIX/releases"
install -d -m 0750 -o root -g "$SVC_USER" "$CONF_DIR"
install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR" "$DATA_DIR/backups"

# --- TLS material (copied under /etc: the hardened unit cannot read /home, and renewal = replace the files + systemctl reload) --------
if [[ $SELF_SIGNED == 1 && -z "${REGEN:-}" && -s "$CONF_DIR/tls/console.crt" && -s "$CONF_DIR/tls/console.key" ]]; then
  # a re-run (the upgrade is "the same command as the first install"): the agents pinned THIS certificate (console-ca.pem); a new one would cut them all off
  OPT_CERT="$CONF_DIR/tls/console.crt"; OPT_KEY="$CONF_DIR/tls/console.key"
  note "self-signed certificate kept ($CONF_DIR/tls/console.crt, valid until $(openssl x509 -enddate -noout -in "$OPT_CERT" 2>/dev/null | cut -d= -f2)); --tls-regenerate makes a new one"
elif [[ $SELF_SIGNED == 1 ]]; then
  [[ -n "${REGEN:-}" && -s "$CONF_DIR/tls/console.crt" ]] && note "NEW certificate: every agent must get it (reinstall with PG_ARCA_TLS_CA=<copy of the new console.crt>), they cannot connect until then"
  command -v openssl >/dev/null || die "--tls-self-signed needs openssl"
  install -d -m 0750 -o root -g "$SVC_USER" "$CONF_DIR/tls"
  h="$(hostname -f 2>/dev/null || hostname)"
  # names AND addresses of this host: agents that reach the console by IP must find it in the certificate too
  san="DNS:$h,DNS:$(hostname -s),DNS:localhost,IP:127.0.0.1"
  for ip in $(hostname -I 2>/dev/null); do [[ "$ip" == *:* || "$ip" == 127.* ]] || san="$san,IP:$ip"; done
  openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes -subj "/CN=$h" -addext "subjectAltName=$san" \
    -keyout "$CONF_DIR/tls/console.key" -out "$CONF_DIR/tls/console.crt" 2>/dev/null || die "openssl could not create the certificate"
  OPT_CERT="$CONF_DIR/tls/console.crt"; OPT_KEY="$CONF_DIR/tls/console.key"
  note "self-signed certificate for $h in $CONF_DIR/tls (agents: PG_ARCA_TLS_CA=<copy of console.crt>)"
elif [[ -n "$OPT_CERT" ]]; then
  [[ -r "$OPT_CERT" && -r "$OPT_KEY" ]] || die "cannot read $OPT_CERT / $OPT_KEY"
  install -d -m 0750 -o root -g "$SVC_USER" "$CONF_DIR/tls"
  if [[ "$(readlink -f "$OPT_CERT")" != "$CONF_DIR/tls/console.crt" ]]; then install -m 0640 -o root -g "$SVC_USER" "$OPT_CERT" "$CONF_DIR/tls/console.crt"; fi
  if [[ "$(readlink -f "$OPT_KEY")" != "$CONF_DIR/tls/console.key" ]]; then install -m 0640 -o root -g "$SVC_USER" "$OPT_KEY" "$CONF_DIR/tls/console.key"; fi
  OPT_CERT="$CONF_DIR/tls/console.crt"; OPT_KEY="$CONF_DIR/tls/console.key"
fi
[[ -z "$OPT_CERT" ]] || { chown root:"$SVC_USER" "$OPT_CERT" "$OPT_KEY"; chmod 0640 "$OPT_CERT" "$OPT_KEY"; }

# --- settings: written once; options given on later runs update only their own line ------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  umask 027
  if [[ -n "$OPT_CERT" ]]; then TLS_LINES="PG_ARCA_TLS_CERT=$OPT_CERT"$'\n'"PG_ARCA_TLS_KEY=$OPT_KEY"
  else TLS_LINES="#PG_ARCA_TLS_CERT=$CONF_DIR/tls/console.crt"$'\n'"#PG_ARCA_TLS_KEY=$CONF_DIR/tls/console.key"; fi
  cat > "$ENV_FILE" <<ENV
# pg_arca console settings. Apply a change with: systemctl restart $UNIT (certificate files only: systemctl reload $UNIT)
PORT=${OPT_PORT:-3000}
PG_ARCA_LISTEN=${OPT_LISTEN:-0.0.0.0}
# Native TLS (PEM files readable by $SVC_USER). Without it, put a reverse proxy that terminates TLS in front and set the two lines below.
$TLS_LINES
#PG_ARCA_TRUST_PROXY=1
#PG_ARCA_COOKIE_SECURE=1
# Extra browser origins allowed on the live-log websocket (comma separated), when the console is reached through another name.
#PG_ARCA_ALLOWED_ORIGINS=
# Key that encrypts stored credentials. Default: generated once in $DATA_DIR/secret.key (it is part of --backup-state).
#PG_ARCA_SECRET_KEY=
# Prometheus: set a token to enable GET /metrics (scrapers send Authorization: Bearer <token>). Unset = metrics off.
#PG_ARCA_METRICS_TOKEN=
ENV
  chown root:"$SVC_USER" "$ENV_FILE"; chmod 0640 "$ENV_FILE"; umask 022
else
  set_env() { if grep -qE "^#?$1=" "$ENV_FILE"; then sed -i -E "s#^\#?$1=.*#$1=$2#" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi; }
  [[ -z "$OPT_PORT" ]] || set_env PORT "$OPT_PORT"
  [[ -z "$OPT_LISTEN" ]] || set_env PG_ARCA_LISTEN "$OPT_LISTEN"
  [[ -z "$OPT_CERT" ]] || { set_env PG_ARCA_TLS_CERT "$OPT_CERT"; set_env PG_ARCA_TLS_KEY "$OPT_KEY"; }
fi
PORT_NOW="$(read_env PORT)"; PORT_NOW="${PORT_NOW:-3000}"

# --- state backup before an upgrade (rollback restores it) ------------------------------------------------
SNAP=""
if [[ -n "$OLD" && "$OLD" != "$NEW" && -n "$(ls -A "$DATA_DIR" 2>/dev/null | grep -v '^backups$' || true)" ]]; then
  SNAP="$(backup_state "$DATA_DIR/backups" "pre-upgrade-to-v$NEW")"
  note "state saved before the upgrade: $SNAP"
fi

# --- code: a new release directory, switched in with one symlink ------------------------------------------------
REL="$PREFIX/releases/$NEW"; STAGE="$PREFIX/releases/.$NEW.new"
rm -rf "$STAGE"; mkdir -p "$STAGE"
# not cp -a: it would keep the SELinux label of where the package was unpacked (admin_home_t under /root), and systemd could not execute node
cp -r --preserve=mode,timestamps "$PKG/VERSION" "$PKG/server.mjs" "$PKG/dist" "$PKG/unix-agent" "$STAGE/"
for f in node install-console.sh LICENSE THIRD-PARTY-NOTICES.txt server.mjs.LEGAL.txt; do [[ -e "$PKG/$f" ]] && cp -r --preserve=mode,timestamps "$PKG/$f" "$STAGE/"; done
chown -R root:root "$STAGE"; chmod -R go-w "$STAGE"
command -v restorecon >/dev/null && restorecon -R "$STAGE" 2>/dev/null || true
NB="$(node_bin "$STAGE")" || die "no usable Node.js runtime"
NB="${NB/$STAGE/$REL}"

PREV_TARGET="$(readlink "$PREFIX/current" 2>/dev/null || true)"
was_active=0; systemctl is-active --quiet "$UNIT" 2>/dev/null && was_active=1
[[ $was_active == 0 ]] || systemctl stop "$UNIT"
if [[ -d "$REL" ]]; then rm -rf "$REL.old"; mv "$REL" "$REL.old"; fi
mv "$STAGE" "$REL"; rm -rf "$REL.old"
ln -sfn "releases/$NEW" "$PREFIX/current"
PREV_REC="$(cat "$PREFIX/previous" 2>/dev/null || true)"            # what --rollback pointed at before this upgrade (restored if this one is rolled back)
[[ -n "$OLD" && "$OLD" != "$NEW" ]] && echo "$OLD" > "$PREFIX/previous"

# --- systemd unit --------------------------------------------------------------------------------------------
CAPS="CapabilityBoundingSet="
if [[ "$PORT_NOW" -lt 1024 ]]; then CAPS=$'CapabilityBoundingSet=CAP_NET_BIND_SERVICE\nAmbientCapabilities=CAP_NET_BIND_SERVICE'; fi
cat > "$UNIT_FILE" <<UNITEOF
[Unit]
Description=pg_arca console
Documentation=file://$PREFIX/current/install-console.sh
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
Environment=NODE_ENV=production PG_ARCA_DATA_DIR=$DATA_DIR
EnvironmentFile=$ENV_FILE
WorkingDirectory=$DATA_DIR
ExecStart=$NB $PREFIX/current/server.mjs
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
UMask=0077
LimitNOFILE=65536
# hardening: the console only needs its state directory and the network
NoNewPrivileges=yes
$CAPS
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null 2>&1

if [[ $NO_START == 1 ]]; then note "installed, not started (--no-start): systemctl start $UNIT"; exit 0; fi
systemctl start "$UNIT"
if ! wait_healthy "$NEW"; then
  journalctl -u "$UNIT" -n 40 --no-pager || true
  if [[ -n "$PREV_TARGET" && "$PREV_TARGET" != "releases/$NEW" && -d "$PREFIX/$PREV_TARGET" ]]; then
    echo "The new release does not answer: going back to $PREV_TARGET" >&2
    systemctl stop "$UNIT" || true
    if [[ -n "$SNAP" ]]; then find "$DATA_DIR" -mindepth 1 -maxdepth 1 ! -name backups -exec rm -rf {} +; tar xzf "$SNAP" -C "$DATA_DIR"; chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"; fi
    ln -sfn "$PREV_TARGET" "$PREFIX/current"
    if [[ -n "$PREV_REC" ]]; then echo "$PREV_REC" > "$PREFIX/previous"; else rm -f "$PREFIX/previous"; fi
    PNB="$(node_bin "$PREFIX/current")" && sed -i "s#^ExecStart=.*#ExecStart=$PNB $PREFIX/current/server.mjs#" "$UNIT_FILE"
    # the failed release may have crash-looped into systemd's start limit: clear it, or the start of the old release is refused
    systemctl daemon-reload; systemctl reset-failed "$UNIT" 2>/dev/null || true; systemctl start "$UNIT" || true
    if wait_healthy "${OLD:-}"; then die "upgrade to $NEW failed and was rolled back: release $OLD is running again (the failed release stays in $PREFIX/releases/$NEW for analysis)"; fi
    die "upgrade to $NEW failed and was rolled back to $OLD, but the console does not answer: journalctl -u $UNIT"
  fi
  die "the console does not answer on $(health_url): see the log above (journalctl -u $UNIT)"
fi

# --- housekeeping: keep the last releases and pre-upgrade backups ------------------------------------------------
# (ls of a pattern with no match fails: with pipefail that would abort a successful first install at its very last step)
(ls -1dt "$PREFIX"/releases/*/ 2>/dev/null || true) | tail -n +$((KEEP_RELEASES + 1)) | while read -r d; do [[ "$(readlink -f "$d")" == "$(readlink -f "$PREFIX/current")" ]] || rm -rf "$d"; done
(ls -1t "$DATA_DIR"/backups/console-state-pre-upgrade-*.tar.gz 2>/dev/null || true) | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -f

URL="$(health_url)"; URL="${URL%/api/health}"; URL="${URL/127.0.0.1/$(hostname -f 2>/dev/null || hostname)}"
echo
echo "pg_arca console $NEW is running: $URL"
if [[ -f "$DATA_DIR/setup-code" ]]; then
  echo "First start: open the address above and create the administrator account with the setup code $(tr -d '[:space:]' < "$DATA_DIR/setup-code")"
  echo "(also in $DATA_DIR/setup-code and in journalctl -u $UNIT)."
fi
[[ -n "$(read_env PG_ARCA_TLS_CERT)" ]] || echo "NOTE: plain http. For production use TLS: --tls-cert/--tls-key, or a reverse proxy (then PG_ARCA_TRUST_PROXY=1 and PG_ARCA_COOKIE_SECURE=1 in $ENV_FILE)."
echo "Status: $PREFIX/current/install-console.sh --status   Settings: $ENV_FILE   State backup: --backup-state"
