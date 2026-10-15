#!/usr/bin/env bash
# ==============================================================================
# pg_arca node agent installer — RHEL/Rocky/Alma 8-10, Debian, Ubuntu
#
#   curl -fsSL https://<console>/agent/install.sh | sudo \
#        PG_ARCA_URL=https://<console> PG_ARCA_ENROLL_TOKEN=arca_enr_... bash
#
# Idempotent: re-running upgrades the code and keeps config + credentials.
# Env:  PG_ARCA_URL (required on first install)   PG_ARCA_ENROLL_TOKEN (optional: without it the server announces itself and waits for approval in the web console)
#       PG_ARCA_NODE_NAME   PG_ARCA_TLS_CA=/path/ca.pem   PG_ARCA_BUNDLE_SHA256=<hex>
#       PG_ARCA_REPO=/var/lib/pgarca/repo   PG_ARCA_WAL=/var/lib/pgarca/wal   PG_ARCA_SCRATCH=/var/tmp/pg_arca_scratch
#       PG_ARCA_USER=<OS user that owns PostgreSQL; default: detected from the running server, else postgres>   PG_ARCA_PG_ROLE=<superuser role, only if unrelated to the OS user>
#       PG_ARCA_INSTANCE=<name> PG_ARCA_PGDATA=<data dir>   one more agent for ANOTHER PostgreSQL instance on the same server (several clusters on one host):
#                             own config /etc/pg-arca/<name>, state /var/lib/pgarca/<name>, service pg-arca-agent-<name>, node name <host>-<name>
#       PG_ARCA_ALLOW_PG_RESTART=0   do not let the agent restart PostgreSQL's systemd unit (default: allowed through a polkit rule limited to postgresql units)
#       PG_ARCA_NO_PKG=1     never install distribution packages (python3-zstandard, zstd, polkit): set by the .deb/.rpm, which declare them as dependencies
#       PG_ARCA_UNINSTALL=1  remove the agent (keeps backups/WAL; PG_ARCA_PURGE=1 deletes them too; refused while PostgreSQL archives through pg_arca)
#       PG_ARCA_ROLE=worker   operational machine (backup server, host for the recovery instances): no database is searched; runs as postgres if present, else as a
#                             dedicated system user "pgarca" created here
# ==============================================================================
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root (sudo)"

# The agent must run as the OS user that OWNS the PostgreSQL server (postgres on Debian/RHEL, but also pgsql, enterprisedb, an application account...). Explicit PG_ARCA_USER wins;
# otherwise the owner of the running postmaster (oldest postgres/postmaster process), then "postgres".
detect_pg_user() {
  local u=""
  command -v ps >/dev/null && u="$(ps -eo user:32=,etimes=,comm= 2>/dev/null | awk '$3=="postgres"||$3=="postmaster"{print $2, $1}' | sort -rn | head -1 | awk '{print $2}')"
  [[ -n "$u" && "$u" != "root" ]] && id "$u" &>/dev/null && { echo "$u"; return; }
  echo postgres
}
# Re-run (upgrade, package upgrade, uninstall) on a host where the agent is already set up: the existing service user and role are the defaults,
# so a worker host running as "pgarca" (no postgres account) is not mistaken for a database server.
EXIST_UNIT=/etc/systemd/system/pg-arca-agent${PG_ARCA_INSTANCE:+-$PG_ARCA_INSTANCE}.service
EXIST_CONF=/etc/pg-arca${PG_ARCA_INSTANCE:+/$PG_ARCA_INSTANCE}/agent.conf
EXIST_ROLE=""; [[ -f "$EXIST_CONF" ]] && EXIST_ROLE="$(sed -n 's/.*"node_role": *"\([a-z]*\)".*/\1/p' "$EXIST_CONF" | head -1)"
EXIST_USER=""; [[ -f "$EXIST_UNIT" ]] && EXIST_USER="$(sed -n 's/^User=//p' "$EXIST_UNIT" | head -1)"
ROLE="${PG_ARCA_ROLE:-${EXIST_ROLE:-auto}}"
[[ "$ROLE" =~ ^(auto|database|worker)$ ]] || die "PG_ARCA_ROLE must be auto, database or worker"
if [[ -n "${PG_ARCA_USER:-}" ]]; then PGUSER_OS="$PG_ARCA_USER"
elif [[ -n "$EXIST_USER" ]] && id "$EXIST_USER" &>/dev/null; then PGUSER_OS="$EXIST_USER"; PG_ARCA_USER="$EXIST_USER"
else PGUSER_OS="$(detect_pg_user)"; fi
if [[ "$ROLE" == worker && -z "${PG_ARCA_USER:-}" ]] && ! id "$PGUSER_OS" &>/dev/null; then
  # a backup server / recovery host usually has no postgres account: a dedicated unprivileged system user
  PGUSER_OS=pgarca
  id pgarca &>/dev/null || useradd --system --create-home --home-dir /var/lib/pgarca --shell /bin/bash pgarca || die "cannot create the system user pgarca (set PG_ARCA_USER=...)"
fi
[[ -n "${PG_ARCA_USER:-}" ]] || echo "agent OS user: $PGUSER_OS (override with PG_ARCA_USER=...)"
id "$PGUSER_OS" &>/dev/null || die "OS user '$PGUSER_OS' not found. The agent must run as the PostgreSQL OS user (set PG_ARCA_USER=...)."
INSTALL_DIR=/opt/pg-arca; CONF_DIR=/etc/pg-arca; STATE_ROOT=/var/lib/pgarca; UNIT=pg-arca-agent
INST="${PG_ARCA_INSTANCE:-}"
if [[ -n "$INST" ]]; then
  [[ "$INST" =~ ^[a-z0-9][a-z0-9_-]{0,30}$ ]] || die "PG_ARCA_INSTANCE: lowercase letters, digits, - and _ (max 31)"
  [[ -n "${PG_ARCA_PGDATA:-}" ]] || die "PG_ARCA_INSTANCE needs PG_ARCA_PGDATA (the data directory of that instance)"
  CONF_DIR=/etc/pg-arca/$INST; STATE_ROOT=/var/lib/pgarca/$INST; UNIT=pg-arca-agent-$INST
  : "${PG_ARCA_NODE_NAME:=$(hostname -s)-$INST}"; export PG_ARCA_NODE_NAME
fi
REPO_DIR="${PG_ARCA_REPO:-$STATE_ROOT/repo}"; WAL_DIR="${PG_ARCA_WAL:-$STATE_ROOT/wal}"; LOG_DIR=/var/log/pgarca; SCRATCH="${PG_ARCA_SCRATCH:-/var/tmp/pg_arca_scratch}"

# --- uninstall ------------------------------------------------------------------
# PG_ARCA_UNINSTALL=1: removes the agent (service, code, commands, polkit rule, configuration and console credentials) and KEEPS the backups and the WAL
# archive ($STATE_ROOT) unless PG_ARCA_PURGE=1. Refused while PostgreSQL still archives through pg-arca-wal: removing the command would make every
# archive attempt fail and pg_wal would grow until the disk is full. Switch archiving off (or to another tool) first, or PG_ARCA_FORCE=1.
if [[ "${PG_ARCA_UNINSTALL:-}" == 1 ]]; then
  ac=""
  if command -v psql >/dev/null || ls /usr/lib/postgresql/*/bin/psql /usr/pgsql-*/bin/psql >/dev/null 2>&1; then
    PSQL=$(command -v psql || ls /usr/lib/postgresql/*/bin/psql /usr/pgsql-*/bin/psql 2>/dev/null | tail -1)
    ac=$(su - "$PGUSER_OS" -c "$PSQL -XAtc 'SHOW archive_command' 2>/dev/null" 2>/dev/null || true)
  fi
  if [[ "$ac" == *pg-arca-wal* && "${PG_ARCA_FORCE:-}" != 1 ]]; then
    die "PostgreSQL still archives WAL through pg_arca (archive_command = $ac). Switch archiving off or to another tool first (then reload), or set PG_ARCA_FORCE=1."
  fi
  systemctl disable --now "$UNIT.service" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$UNIT.service"; systemctl daemon-reload 2>/dev/null || true
  rm -rf "$CONF_DIR"
  if [[ -z "$INST" ]]; then            # the shared parts go only with the main agent (other instances may still use them)
    ls /etc/systemd/system/pg-arca-agent-*.service >/dev/null 2>&1 && echo "NOTE: other pg_arca agents on this server (pg-arca-agent-*) are left in place, and so is the shared code"
    if ! ls /etc/systemd/system/pg-arca-agent-*.service >/dev/null 2>&1; then
      rm -rf "$INSTALL_DIR" /usr/local/bin/pg-arca-cli /usr/local/bin/pg-arca-wal /etc/polkit-1/rules.d/50-pg-arca-restart.rules
    fi
  fi
  if [[ "${PG_ARCA_PURGE:-}" == 1 ]]; then rm -rf "$STATE_ROOT"; echo "pg_arca removed, backups and WAL archive in $STATE_ROOT DELETED."
  else echo "pg_arca agent removed. Backups and WAL archive are kept in $STATE_ROOT (PG_ARCA_PURGE=1 to delete them too). Remove the node from the console as well."; fi
  exit 0
fi

# --- python + tools ------------------------------------------------------------
NOPKG="${PG_ARCA_NO_PKG:-}"
if ! command -v python3 >/dev/null; then
  [[ -z "$NOPKG" ]] || die "python3 missing"
  if command -v dnf >/dev/null; then dnf install -y -q python3; elif command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq python3; else die "python3 missing"; fi
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,6) else 1)' || die "Python >= 3.6 required"
# python zstandard: the chunk compressor of the backups. Without it the agent falls back to zlib, measured 5-10x slower per core on database pages
# (the lab: zlib ~16-80 MB/s per core). Debian/Ubuntu: python3-zstandard; RHEL/Rocky/Alma: python3-zstandard from EPEL (or AppStream on newer releases).
if [[ -z "$NOPKG" ]] && ! python3 -c 'import zstandard' 2>/dev/null && ! python3 -c 'from compression import zstd' 2>/dev/null; then
  { command -v apt-get >/dev/null && { apt-get install -y -qq python3-zstandard >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq python3-zstandard >/dev/null 2>&1; }; }; } || { command -v dnf >/dev/null && dnf install -y -q python3-zstandard >/dev/null 2>&1; } \
    || echo "WARN: python3-zstandard not available: backups will use zlib (much slower). Install python3-zstandard (EPEL on RHEL) or 'pip3 install zstandard' for the agent's python."
fi
if [[ -z "$NOPKG" ]] && ! command -v zstd >/dev/null; then
  { command -v dnf >/dev/null && dnf install -y -q zstd; } || { command -v apt-get >/dev/null && { apt-get install -y -qq zstd >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq zstd >/dev/null 2>&1; }; }; } || echo "WARN: zstd not installed; without python3-zstandard too, WAL segments are archived with gzip (slower)"
fi

# --- obtain the bundle ------------------------------------------------------------
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [[ -n "$SRC" && -d "$SRC/pg_arca" && -f "$SRC/pg-arca-agent.py" ]]; then
  BUNDLE="$SRC"
else
  [[ -n "${PG_ARCA_URL:-}" ]] || die "PG_ARCA_URL is required"
  CURL=(curl -fsSL --retry 3); [[ -n "${PG_ARCA_TLS_CA:-}" ]] && CURL+=(--cacert "$PG_ARCA_TLS_CA")
  "${CURL[@]}" "${PG_ARCA_URL%/}/agent/pg-arca-agent.tar.gz" -o "$TMP/agent.tgz" || die "cannot download the agent bundle from $PG_ARCA_URL"
  if [[ -n "${PG_ARCA_BUNDLE_SHA256:-}" ]]; then echo "${PG_ARCA_BUNDLE_SHA256}  $TMP/agent.tgz" | sha256sum -c - >/dev/null || die "bundle checksum mismatch"; fi
  mkdir "$TMP/b"
  if command -v tar >/dev/null; then tar xzf "$TMP/agent.tgz" -C "$TMP/b"
  else python3 -W ignore -c 'import sys, tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2])' "$TMP/agent.tgz" "$TMP/b"; fi      # minimal images (Rocky/RHEL containers) have no tar
  BUNDLE="$TMP/b"
fi

# --- layout ----------------------------------------------------------------------
install -d -m 0755 "$INSTALL_DIR"
install -d -m 0750 -o "$PGUSER_OS" "$CONF_DIR" "$STATE_ROOT" "$REPO_DIR" "$WAL_DIR" "$STATE_ROOT/state" "$LOG_DIR" "$SCRATCH"
rm -rf "$INSTALL_DIR/pg_arca.new"; cp -r "$BUNDLE/pg_arca" "$INSTALL_DIR/pg_arca.new"
rm -rf "$INSTALL_DIR/pg_arca.old"; [[ -d "$INSTALL_DIR/pg_arca" ]] && mv "$INSTALL_DIR/pg_arca" "$INSTALL_DIR/pg_arca.old"
mv "$INSTALL_DIR/pg_arca.new" "$INSTALL_DIR/pg_arca"; rm -rf "$INSTALL_DIR/pg_arca.old"
install -m 0755 "$BUNDLE/pg-arca-agent.py" "$INSTALL_DIR/pg-arca-agent.py"
install -m 0755 "$BUNDLE/pg-arca-cli" /usr/local/bin/pg-arca-cli
install -m 0755 "$BUNDLE/pg-arca-wal" /usr/local/bin/pg-arca-wal
chown -R root:root "$INSTALL_DIR"

# --- CA of the console certificate: copied next to the config, readable by the agent's user. The path given (/root/console.crt, the console's own
# tls/ directory, ...) is usually readable by root only, and the agent does not run as root (found by the release test: PermissionError at start).
if [[ -n "${PG_ARCA_TLS_CA:-}" ]]; then
  [[ -r "$PG_ARCA_TLS_CA" ]] || die "PG_ARCA_TLS_CA=$PG_ARCA_TLS_CA is not readable"
  if [[ "$(readlink -f "$PG_ARCA_TLS_CA")" != "$(readlink -f "$CONF_DIR/console-ca.pem" 2>/dev/null)" ]]; then install -m 0644 "$PG_ARCA_TLS_CA" "$CONF_DIR/console-ca.pem"; fi
  PG_ARCA_TLS_CA="$CONF_DIR/console-ca.pem"; export PG_ARCA_TLS_CA
  if [[ -f "$CONF_DIR/agent.conf" ]]; then                                   # upgrade or re-run with a CA: point an existing config at the copy
    python3 - "$CONF_DIR/agent.conf" "$PG_ARCA_TLS_CA" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
if c.get("tls_ca_file") != sys.argv[2]:
    c["tls_ca_file"] = sys.argv[2]; json.dump(c, open(sys.argv[1], "w"), indent=2)
PY
  fi
fi

# --- config (never overwritten) -------------------------------------------------------
if [[ ! -f "$CONF_DIR/agent.conf" ]]; then
  [[ -n "${PG_ARCA_URL:-}" ]] || die "PG_ARCA_URL is required on first install"
  python3 - "$CONF_DIR/agent.conf" <<PY
import json, os, sys
c = {"connection_mode": "push", "web_server_url": os.environ["PG_ARCA_URL"].rstrip("/"),
     "repo_path": "$REPO_DIR", "wal_archive_dir": "$WAL_DIR", "scratch_dir": "$SCRATCH", "state_dir": "$STATE_ROOT/state",
     "credentials_file": "$CONF_DIR/credentials.json"}
# no "pg_user": the agent finds the role that connects (owner of PGDATA, its own OS user, postgres). Set PG_ARCA_PG_ROLE only for a superuser with an unrelated name.
if os.environ.get("PG_ARCA_PG_ROLE"): c["pg_user"] = os.environ["PG_ARCA_PG_ROLE"]
if os.environ.get("PG_ARCA_NODE_NAME"): c["node_name"] = os.environ["PG_ARCA_NODE_NAME"]
if "$ROLE" != "auto": c["node_role"] = "$ROLE"
if os.environ.get("PG_ARCA_PGDATA"): c["pg_data"] = os.environ["PG_ARCA_PGDATA"]      # this agent manages THIS instance (several on one host: one agent each)
if os.environ.get("PG_ARCA_TLS_CA"): c["tls_ca_file"] = os.environ["PG_ARCA_TLS_CA"]
json.dump(c, open(sys.argv[1], "w"), indent=2)
PY
  chown "$PGUSER_OS" "$CONF_DIR/agent.conf"; chmod 0640 "$CONF_DIR/agent.conf"
fi
if [[ -n "${PG_ARCA_ENROLL_TOKEN:-}" && ! -f "$CONF_DIR/credentials.json" ]]; then
  umask 077; printf 'PG_ARCA_ENROLL_TOKEN=%s\n' "$PG_ARCA_ENROLL_TOKEN" > "$CONF_DIR/enroll.env"; chown "$PGUSER_OS" "$CONF_DIR/enroll.env"; chmod 0600 "$CONF_DIR/enroll.env"
fi
if [[ ! -f "$CONF_DIR/credentials.json" && ! -f "$CONF_DIR/enroll.env" ]]; then
  echo "No enrollment token given: this server will announce itself to ${PG_ARCA_URL:-the console} and wait for an administrator to approve it in the web console (Cluster page)."
fi

# --- service -------------------------------------------------------------------------
# No systemd (container) or PG_ARCA_NO_SERVICE=1: files are installed, the caller starts the agent:
#   su postgres -c 'PYTHONPATH=/opt/pg-arca PG_ARCA_CONF_FILE=/etc/pg-arca/agent.conf python3 /opt/pg-arca/pg-arca-agent.py'
if [[ -n "${PG_ARCA_NO_SERVICE:-}" || ! -d /run/systemd/system ]]; then
  echo "pg_arca agent installed WITHOUT a systemd service (no systemd here, or PG_ARCA_NO_SERVICE set). Start it with (keeps running, restarts if it exits):"
  echo "  su $PGUSER_OS -c 'set -a; [ -f $CONF_DIR/enroll.env ] && . $CONF_DIR/enroll.env; set +a; export PYTHONPATH=$INSTALL_DIR PG_ARCA_CONF_FILE=$CONF_DIR/agent.conf; nohup sh -c \"while true; do python3 $INSTALL_DIR/pg-arca-agent.py >>$LOG_DIR/agent.out 2>&1; sleep 5; done\" >/dev/null 2>&1 &'"
  echo "  logs: tail -f $LOG_DIR/agent.out"
  exit 0
fi
# restart of a STANDALONE PostgreSQL from the console (after enabling WAL archiving or changing a restart-only parameter): the agent asks systemd to restart the
# server's own unit. polkit lets the agent's user restart/start ONLY postgresql units (postgresql.service, postgresql@14-main, postgresql-16), never stop
# them, nothing else. Opt out with PG_ARCA_ALLOW_PG_RESTART=0 (the console then shows the command to run by hand). Not for operational machines.
# Without polkit an unprivileged agent cannot ask systemd for anything: no restart after enabling archiving, no whole-server restore that puts production
# back (stop, swap, START of its unit). On a standalone server under systemd the installer adds polkit (small, from the distribution) unless told not to.
if [[ -z "$NOPKG" && "${PG_ARCA_ALLOW_PG_RESTART:-1}" != 0 && "$ROLE" != worker && ! -d /etc/polkit-1 && -d /run/systemd/system ]] \
   && ! pgrep -f "bin/patroni" >/dev/null 2>&1 && ! systemctl is-active --quiet patroni 2>/dev/null; then
  echo "installing polkit (lets the agent start/restart ONLY the PostgreSQL units; PG_ARCA_ALLOW_PG_RESTART=0 to skip)"
  { command -v apt-get >/dev/null && { apt-get install -y -qq polkitd >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && { apt-get install -y -qq polkitd >/dev/null 2>&1 || apt-get install -y -qq policykit-1 >/dev/null 2>&1; }; }; }; } \
    || { command -v dnf >/dev/null && dnf install -y -q polkit >/dev/null 2>&1; } || { command -v yum >/dev/null && yum install -y -q polkit >/dev/null 2>&1; } || true
  [ -d /etc/polkit-1 ] && { systemctl enable --now polkit >/dev/null 2>&1 || systemctl start polkit >/dev/null 2>&1 || true; }
fi
if [[ "${PG_ARCA_ALLOW_PG_RESTART:-1}" != 0 && "$ROLE" != worker && -d /etc/polkit-1 ]]; then
  install -d -m 0755 /etc/polkit-1/rules.d
  cat > /etc/polkit-1/rules.d/50-pg-arca-restart.rules <<RULE
// pg_arca: the agent (user $PGUSER_OS) may restart/start the PostgreSQL services of this server, nothing else (PG_ARCA_ALLOW_PG_RESTART=0 to disable)
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" && subject.user == "$PGUSER_OS" &&
      /^postgresql([@-][A-Za-z0-9_.@-]+)?\.service\$/.test(action.lookup("unit")) &&
      (action.lookup("verb") == "restart" || action.lookup("verb") == "start")) {
    return polkit.Result.YES;
  }
});
RULE
  chmod 0644 /etc/polkit-1/rules.d/50-pg-arca-restart.rules
  echo "restart from the console: allowed for the PostgreSQL units only (/etc/polkit-1/rules.d/50-pg-arca-restart.rules; PG_ARCA_ALLOW_PG_RESTART=0 to disable)"
elif [[ "${PG_ARCA_ALLOW_PG_RESTART:-1}" == 0 ]]; then
  rm -f /etc/polkit-1/rules.d/50-pg-arca-restart.rules
elif [[ "$ROLE" != worker ]] && ! pgrep -f "bin/patroni" >/dev/null 2>&1 && ! systemctl is-active --quiet patroni 2>/dev/null; then   # Patroni nodes restart through Patroni: no polkit needed
  echo "NOTE: polkit is not installed: restarting PostgreSQL from the console will not be possible (the console shows the command to run by hand)."
  echo "      To allow it: install polkit (apt-get install polkitd / dnf install polkit) and run this installer again."
fi
cat > /etc/systemd/system/$UNIT.service <<UNIT
[Unit]
Description=pg_arca node agent${INST:+ (instance $INST)}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$PGUSER_OS
Environment=PYTHONPATH=$INSTALL_DIR PG_ARCA_CONF=$CONF_DIR/agent.conf PG_ARCA_CONF_FILE=$CONF_DIR/agent.conf
EnvironmentFile=-$CONF_DIR/enroll.env
ExecStart=/usr/bin/env python3 $INSTALL_DIR/pg-arca-agent.py
Restart=always
RestartSec=5
# least privilege: read the system, write only agent state
NoNewPrivileges=yes
# 'full' (not 'strict'): restores, pg_hba/postgresql.conf edits and PGDATA/tablespaces live in arbitrary paths (/var/lib/pgsql, /data, /pgdata, /mnt/...). Only /usr, /boot and /etc stay read-only, with the usual PostgreSQL config dirs re-opened.
ProtectSystem=full
ReadWritePaths=-/etc/postgresql -/etc/postgresql-common -/etc/patroni -/etc/pgbouncer
# no ProtectHome/PrivateTmp: PGDATA, tablespaces or restore targets may live under /home, and a PostgreSQL unix socket in /tmp (source builds, some PGDG setups) must stay reachable
ReadWritePaths=$CONF_DIR $STATE_ROOT $REPO_DIR $LOG_DIR $SCRATCH
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
# be a good neighbour on a production database host
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
CPUWeight=20
IOWeight=20
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable $UNIT.service >/dev/null
systemctl restart $UNIT.service      # restart (not just start): re-running the installer is the upgrade path, the old code must not keep running
# the code in $INSTALL_DIR is shared by every agent of this host (one per PostgreSQL instance): they all restart on the new code
for u in $(systemctl list-units --plain --no-legend --type=service 'pg-arca-agent*' 2>/dev/null | awk '{print $1}'); do
  [[ "$u" == "$UNIT.service" ]] || systemctl restart "$u" || true
done
sleep 2
systemctl is-active --quiet $UNIT.service && echo "pg_arca agent is running ($UNIT)." || { echo "agent failed to start:"; journalctl -u $UNIT -n 20 --no-pager; exit 1; }
# wait (max ~40 s) for the agent to tell how its registration went, so the person at the terminal knows right away whether to look at the console or fix something here
ST="$STATE_ROOT/state/console_status.json"; state=""
for _ in $(seq 1 40); do
  [[ -f "$ST" ]] && state="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("state","")+"|"+str(d.get("detail") or "")+"|"+str(d.get("node_id") or ""))' "$ST" 2>/dev/null || true)"
  case "${state%%|*}" in enrolled|connected|waiting_approval) break ;; esac
  systemctl is-active --quiet $UNIT.service || break
  sleep 1
done
IFS='|' read -r st detail nid <<<"$state"
case "$st" in
  enrolled|connected) echo "OK: registered in the console as node $nid. Open ${PG_ARCA_URL:-the console}: the server is listed under Clusters." ;;
  waiting_approval)   [[ -n "$detail" ]] && echo "NOTE: the enrollment token was refused ($detail: expired, already used or unknown)."
                      echo "WAITING: this server announced itself; an administrator approves it in the console (Today / Clusters: 'New server detected')." ;;
  token_refused)      echo "NOTE: the enrollment token was refused ($detail); the agent is announcing the server for approval instead." ;;
  unreachable)        echo "PROBLEM: the agent cannot reach the console: $detail"; echo "  check the address (${PG_ARCA_URL:-?}), DNS, firewall/proxy from this server; the agent keeps retrying." ;;
  *)                  echo "The agent is starting; registration not confirmed yet. Follow it with: journalctl -u $UNIT -f" ;;
esac
echo "Logs: journalctl -u $UNIT -f"
# what is left to do, said only when it is really left (the default local server; a host with several instances gets the generic line)
arch=$(cd / && runuser -u "$PGUSER_OS" -- psql -XAtc "select current_setting('archive_mode')||'|'||current_setting('archive_command')" 2>/dev/null || true)
case "$arch" in
  on\|*pg-arca*|always\|*pg-arca*) echo "WAL archiving: already active through pg_arca." ;;
  on\|?*|always\|?*) echo "Next: WAL archiving is active with another command (${arch#*|}): switch it to pg_arca from the console, Backup tab -> 'Enable WAL archiving'." ;;
  *) echo "Next: WAL archiving (needed for point-in-time restore) is switched on from the console, Backup tab -> 'Enable WAL archiving' (on Patroni through the DCS)." ;;
esac
