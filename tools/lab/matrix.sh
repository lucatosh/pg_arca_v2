#!/bin/bash
# Compatibility matrix: run the agent's REAL-PostgreSQL test suites against several PostgreSQL major versions (official Debian images, docker).
#   usage: sg docker -c "tools/lab/matrix.sh 12 13 14 15 16 17"   (default: all)   -> results in /tmp/matrix-<v>.log, summary on stdout
cd "$(dirname "$0")/../.."; ROOT=$(pwd)
VERS=${*:-12 13 14 15 16 17}
SUITES="tests.test_engine_pg tests.test_engine_layout_pg tests.test_discovery_layouts_pg tests.test_archive_enable_pg tests.test_hba_pg tests.test_wal tests.test_restore_safety tests.test_crypto"
for v in $VERS; do
  echo "=== PostgreSQL $v"
  docker run --rm -v "$ROOT":/work:ro,z -e LC_ALL=C.UTF-8 "postgres:$v-bookworm" bash -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends python3 python3-cryptography procps >/dev/null 2>&1
    cp -r /work/unix-agent /tmp/agent && chown -R postgres:postgres /tmp/agent
    su postgres -s /bin/bash -c "cd /tmp/agent && python3 -m unittest '"$SUITES"' 2>&1 | tail -25"' > /tmp/matrix-$v.log 2>&1
  grep -E "^(Ran|OK|FAILED)" /tmp/matrix-$v.log | tr '\n' ' '; echo
done
