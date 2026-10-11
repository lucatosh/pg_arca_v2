#!/usr/bin/env bash
# geo lab node: render the site's Patroni config, install the agent (repository + WAL archive on the shared backup volume), run it beside Patroni.
set -euo pipefail
: "${NODE:?}" "${SITE:?}" "${PG_SUPER_PASSWORD:?}" "${PG_REPL_PASSWORD:?}"
export SCOPE="geo-${SITE}" ETCD="etcd-${SITE}" STANDBY="" SLOTS="{geo_dc2: {type: physical}}"
if [[ $SITE == dc2 ]]; then
  STANDBY='    standby_cluster: {host: dc1-haproxy, port: 5000, primary_slot_name: geo_dc2, create_replica_methods: [basebackup]}'
  SLOTS='{}'
fi
export NODE PG_SUPER_PASSWORD PG_REPL_PASSWORD
install -d -m 0700 -o postgres -g postgres /var/lib/postgresql/data
install -d -o postgres -g postgres /var/log/pgarca /var/log/patroni /backup/repo /backup/wal
envsubst '${NODE} ${SCOPE} ${ETCD} ${STANDBY} ${SLOTS} ${PG_SUPER_PASSWORD} ${PG_REPL_PASSWORD}' < /geo/patroni.yml.tpl > /etc/patroni.yml
chown postgres:postgres /etc/patroni.yml; chmod 600 /etc/patroni.yml
# the standby site connects to DC1 as replicator: libpq password file for the basebackup / streaming (never PGPASSWORD: it would win for every role)
if [[ -n "${ARCA_URL:-}" && -f /work/unix-agent/install-agent.sh ]]; then
  PG_ARCA_URL="$ARCA_URL" PG_ARCA_NODE_NAME="$NODE" PG_ARCA_ENROLL_TOKEN="${ARCA_ENROLL_TOKEN:-}" PG_ARCA_NO_SERVICE=1 PG_ARCA_REPO=/backup/repo PG_ARCA_WAL=/backup/wal \
    bash /work/unix-agent/install-agent.sh || echo "[geo] agent install FAILED (Patroni still starts)"
  gosu postgres bash -c '
    export PYTHONPATH=/opt/pg-arca PG_ARCA_CONF_FILE=/etc/pg-arca/agent.conf PATRONI_URL=http://localhost:8008
    while true; do [ -f /etc/pg-arca/enroll.env ] && set -a && . /etc/pg-arca/enroll.env && set +a; python3 /opt/pg-arca/pg-arca-agent.py >>/var/log/pgarca/agent.out 2>&1; sleep 5; done' &
fi
exec gosu postgres patroni /etc/patroni.yml
