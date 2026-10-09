#!/usr/bin/env bash
# root entrypoint: render config, install the agent from the mounted repo, run it beside Patroni (which is the main process).
set -euo pipefail
: "${NODE:?}" "${PG_SUPER_PASSWORD:?}" "${PG_REPL_PASSWORD:?}"
export NODE PG_SUPER_PASSWORD PG_REPL_PASSWORD
install -d -m 0700 -o postgres -g postgres /var/lib/postgresql/data
install -d -o postgres -g postgres /var/log/pgarca
envsubst '${NODE} ${PG_SUPER_PASSWORD} ${PG_REPL_PASSWORD}' < /etc/patroni.yml.tpl > /etc/patroni.yml
chown postgres:postgres /etc/patroni.yml; chmod 600 /etc/patroni.yml
export PGPASSWORD="$PG_SUPER_PASSWORD"

if [[ -n "${ARCA_URL:-}" && -f /work/unix-agent/install-agent.sh ]]; then
  echo "[lab] installing pg_arca agent from /work/unix-agent -> console ${ARCA_URL}"
  PG_ARCA_URL="$ARCA_URL" PG_ARCA_NODE_NAME="$NODE" PG_ARCA_ENROLL_TOKEN="${ARCA_ENROLL_TOKEN:-}" PG_ARCA_NO_SERVICE=1 \
    bash /work/unix-agent/install-agent.sh || echo "[lab] agent install FAILED (Patroni still starts)"
  if [[ -f /opt/pg-arca/pg-arca-agent.py ]]; then
    gosu postgres bash -c '
      export PYTHONPATH=/opt/pg-arca PG_ARCA_CONF_FILE=/etc/pg-arca/agent.conf PATRONI_URL=http://localhost:8008
      while true; do
        [ -f /etc/pg-arca/enroll.env ] && set -a && . /etc/pg-arca/enroll.env && set +a
        python3 /opt/pg-arca/pg-arca-agent.py >>/var/log/pgarca/agent.out 2>&1
        sleep 5
      done' &
  fi
else
  echo "[lab] ARCA_URL empty or repo not mounted: running Patroni without the agent"
fi
exec gosu postgres patroni /etc/patroni.yml
