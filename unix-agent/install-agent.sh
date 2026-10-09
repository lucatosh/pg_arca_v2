#!/usr/bin/env bash
# ==============================================================================
# pg_arca — Node Agent Automated Installer for Ubuntu / Debian
# ==============================================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
   echo "ERROR: This installer must be run as root (or with sudo)." >&2
   exit 1
fi

echo "=================================================================="
echo "  pg_arca Enterprise Node Agent Installer for Ubuntu / Debian"
echo "=================================================================="

# 1. Check Python 3
if ! command -v python3 &>/dev/null; then
    echo "[*] Installing Python 3 runtime..."
    apt-get update -qq && apt-get install -y -qq python3 python3-pip
fi

# Optional compression packages
echo "[*] Checking compression tools (lz4, zstd)..."
apt-get install -y -qq zstd lz4 curl >/dev/null 2>&1 || true

# 2. Directory Structure
INSTALL_DIR="/opt/pg-arca"
CONF_DIR="/etc/pg-arca"
REPO_DIR="/var/lib/pgarca/repo"
WAL_DIR="/var/lib/postgresql/wal_archive"
SCRATCH_DIR="/var/tmp/pg_arca_scratch"
LOG_DIR="/var/log/pgarca"
RUN_DIR="/var/run/pg-arca"

echo "[*] Creating secure directories..."
mkdir -p "$INSTALL_DIR" "$CONF_DIR" "$REPO_DIR" "$WAL_DIR" "$SCRATCH_DIR" "$LOG_DIR" "$RUN_DIR"

# 3. Copy Agent Files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -r "$SCRIPT_DIR/pg_arca" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/pg-arca-agent.py" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/pg-arca-wal-archive.sh" /usr/local/bin/pg-arca-wal-archive.sh
cp "$SCRIPT_DIR/pg-arca-cli" /usr/local/bin/pg-arca-cli

chmod +x /usr/local/bin/pg-arca-wal-archive.sh /usr/local/bin/pg-arca-cli "$INSTALL_DIR/pg-arca-agent.py"

# 4. Intelligent Cluster & Configuration Auto-Discovery
echo "[*] Running intelligent cluster & directory auto-discovery..."
AUTOCONFIG=$(python3 -c "
import sys, json
sys.path.insert(0, '$SCRIPT_DIR')
try:
    from pg_arca.discovery import ClusterDiscoveryEngine
    engine = ClusterDiscoveryEngine()
    scan = engine.scan_all()
    clusters = scan.get('patroni_clusters', [])
    c_name = clusters[0]['name'] if clusters else 'cluster-prod-01'
    data_dir = clusters[0].get('pg_data_dir') if clusters else '/var/lib/postgresql/16/main'
    rest_url = clusters[0].get('restapi_endpoint') if clusters else 'http://127.0.0.1:8008'
    print(json.dumps({'cluster_name': c_name, 'data_dir': data_dir, 'patroni_url': rest_url, 'found': bool(clusters)}))
except Exception as e:
    print(json.dumps({'cluster_name': 'cluster-prod-01', 'data_dir': '/var/lib/postgresql/16/main', 'patroni_url': 'http://127.0.0.1:8008', 'found': False}))
")

DETECTED_NAME=$(echo "$AUTOCONFIG" | python3 -c "import sys, json; print(json.load(sys.stdin).get('cluster_name', 'cluster-prod-01'))")
DETECTED_DATA=$(echo "$AUTOCONFIG" | python3 -c "import sys, json; print(json.load(sys.stdin).get('data_dir', '/var/lib/postgresql/16/main'))")
DETECTED_PATRONI=$(echo "$AUTOCONFIG" | python3 -c "import sys, json; print(json.load(sys.stdin).get('patroni_url', 'http://127.0.0.1:8008'))")

echo "  [+] Discovered Cluster: $DETECTED_NAME"
echo "  [+] Discovered Data Dir: $DETECTED_DATA"
echo "  [+] Discovered Patroni: $DETECTED_PATRONI"

# 5. Configuration Template
if [[ ! -f "$CONF_DIR/agent.conf" ]]; then
    echo "[*] Generating customized $CONF_DIR/agent.conf with discovered parameters..."
    cp "$SCRIPT_DIR/agent.conf.example" "$CONF_DIR/agent.conf"
    # Generate random unique auth token
    TOKEN=$(python3 -c "import secrets; print(secrets.token_hex(16))")
    sed -i "s/arca-secret-production-token-98f2b7a4/arca-token-$TOKEN/g" "$CONF_DIR/agent.conf"
    sed -i "s/cluster-prod-01/$DETECTED_NAME/g" "$CONF_DIR/agent.conf"
    sed -i "s|/var/lib/postgresql/data|$DETECTED_DATA|g" "$CONF_DIR/agent.conf"
    chmod 600 "$CONF_DIR/agent.conf"
fi

# 6. Set Permissions for postgres system user
if id "postgres" &>/dev/null; then
    chown -R postgres:postgres "$INSTALL_DIR" "$REPO_DIR" "$WAL_DIR" "$SCRATCH_DIR" "$LOG_DIR" "$RUN_DIR"
    chown postgres:postgres "$CONF_DIR/agent.conf"
fi

# 7. Install Systemd Service
echo "[*] Configuring systemd service..."
cat << 'EOF' > /etc/systemd/system/pg-arca-agent.service
[Unit]
Description=pg_arca Enterprise Node Agent Daemon
After=network.target patroni.service postgresql.service
Wants=patroni.service

[Service]
Type=simple
User=postgres
Group=postgres
WorkingDirectory=/opt/pg-arca
Environment=PYTHONPATH=/opt/pg-arca
ExecStart=/usr/bin/python3 /opt/pg-arca/pg-arca-agent.py
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pg-arca-agent.service >/dev/null 2>&1 || true

echo "=================================================================="
echo "  pg_arca Agent Installation Completed Successfully!"
echo "=================================================================="
echo "  Configuration file:   $CONF_DIR/agent.conf"
echo "  Repository Vault:     $REPO_DIR"
echo "  WAL Archive:          $WAL_DIR"
echo "  CLI Utility:          pg-arca-cli"
echo "  Systemd Service:      systemctl start pg-arca-agent"
echo "=================================================================="
