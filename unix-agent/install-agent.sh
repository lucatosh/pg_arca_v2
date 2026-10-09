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
#       PG_ARCA_REPO=/var/lib/pgarca/repo   PG_ARCA_USER=postgres
# ==============================================================================
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root (sudo)"

PGUSER_OS="${PG_ARCA_USER:-postgres}"
id "$PGUSER_OS" &>/dev/null || die "OS user '$PGUSER_OS' not found. The agent must run as the PostgreSQL OS user (set PG_ARCA_USER=...)."
INSTALL_DIR=/opt/pg-arca; CONF_DIR=/etc/pg-arca; STATE_ROOT=/var/lib/pgarca
REPO_DIR="${PG_ARCA_REPO:-$STATE_ROOT/repo}"; WAL_DIR="$STATE_ROOT/wal"; LOG_DIR=/var/log/pgarca; SCRATCH=/var/tmp/pg_arca_scratch

# --- python + tools ------------------------------------------------------------
if ! command -v python3 >/dev/null; then
  if command -v dnf >/dev/null; then dnf install -y -q python3; elif command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq python3; else die "python3 missing"; fi
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,6) else 1)' || die "Python >= 3.6 required"
if ! command -v zstd >/dev/null; then
  { command -v dnf >/dev/null && dnf install -y -q zstd; } || { command -v apt-get >/dev/null && apt-get install -y -qq zstd; } || echo "WARN: zstd not installed; WAL/chunks will be stored uncompressed"
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
  mkdir "$TMP/b" && tar xzf "$TMP/agent.tgz" -C "$TMP/b"; BUNDLE="$TMP/b"
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

# --- config (never overwritten) -------------------------------------------------------
if [[ ! -f "$CONF_DIR/agent.conf" ]]; then
  [[ -n "${PG_ARCA_URL:-}" ]] || die "PG_ARCA_URL is required on first install"
  python3 - "$CONF_DIR/agent.conf" <<PY
import json, os, sys
c = {"connection_mode": "push", "web_server_url": os.environ["PG_ARCA_URL"].rstrip("/"),
     "repo_path": "$REPO_DIR", "wal_archive_dir": "$WAL_DIR", "scratch_dir": "$SCRATCH", "state_dir": "$STATE_ROOT/state",
     "credentials_file": "$CONF_DIR/credentials.json", "pg_user": "$PGUSER_OS"}
if os.environ.get("PG_ARCA_NODE_NAME"): c["node_name"] = os.environ["PG_ARCA_NODE_NAME"]
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
  echo "pg_arca agent installed WITHOUT a systemd service (no systemd here, or PG_ARCA_NO_SERVICE set). Start it yourself, see the comment in install-agent.sh."
  exit 0
fi
cat > /etc/systemd/system/pg-arca-agent.service <<UNIT
[Unit]
Description=pg_arca node agent
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
ProtectHome=yes
PrivateTmp=yes
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
systemctl enable --now pg-arca-agent.service >/dev/null
sleep 2
systemctl is-active --quiet pg-arca-agent.service && echo "pg_arca agent is running." || { echo "agent failed to start:"; journalctl -u pg-arca-agent -n 20 --no-pager; exit 1; }
echo "Check the console: this node appears under Clusters within seconds. Logs: journalctl -u pg-arca-agent -f"
echo "WAL archiving (PITR) - set on the primary (or in Patroni postgresql.parameters):"
echo "   archive_mode = on"
echo "   archive_command = '/usr/local/bin/pg-arca-wal archive %p %f'   # see: pg-arca-cli archive-setup"
