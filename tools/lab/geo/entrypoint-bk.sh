#!/usr/bin/env bash
# geo lab backup server: no database; the agent runs as an operational machine (worker) and sees the shared backup volume at /backup.
set -euo pipefail
install -d -o postgres -g postgres /backup/repo /backup/wal /var/log/pgarca
# recovered data is delivered to the sites' leaders through their HAProxy: password file for the agent's OS user (libpq, never PGPASSWORD)
if [[ -n "${PG_SUPER_PASSWORD:-}" ]]; then h=$(getent passwd postgres | cut -d: -f6); install -d -o postgres -g postgres "$h"
  printf 'dc1-haproxy:5000:*:postgres:%s\ndc2-haproxy:5000:*:postgres:%s\n' "$PG_SUPER_PASSWORD" "$PG_SUPER_PASSWORD" > "$h/.pgpass"; chown postgres:postgres "$h/.pgpass"; chmod 600 "$h/.pgpass"; fi
if [[ -n "${ARCA_URL:-}" && -f /work/unix-agent/install-agent.sh ]]; then
  PG_ARCA_URL="$ARCA_URL" PG_ARCA_NODE_NAME="$NODE" PG_ARCA_ENROLL_TOKEN="${ARCA_ENROLL_TOKEN:-}" PG_ARCA_NO_SERVICE=1 PG_ARCA_ROLE=worker PG_ARCA_REPO=/backup/repo PG_ARCA_WAL=/backup/wal \
    bash /work/unix-agent/install-agent.sh || echo "[geo] agent install FAILED"
  exec gosu postgres bash -c '
    export PYTHONPATH=/opt/pg-arca PG_ARCA_CONF_FILE=/etc/pg-arca/agent.conf
    while true; do [ -f /etc/pg-arca/enroll.env ] && set -a && . /etc/pg-arca/enroll.env && set +a; python3 /opt/pg-arca/pg-arca-agent.py >>/var/log/pgarca/agent.out 2>&1; sleep 5; done'
fi
exec sleep infinity
