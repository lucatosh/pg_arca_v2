#!/bin/bash
# Compatibility matrix: run the agent's REAL-PostgreSQL test suites against several PostgreSQL major versions (official docker images).
#   usage: sg docker -c "tools/lab/matrix.sh 12 13 14 15 16 17 18"   (default: 12..18; 10 and 11 are accepted and use bullseye images)
#   results: FULL log in /tmp/matrix-<v>.log, one line per version on stdout and in /tmp/matrix-summary.txt
# A major version may be added to VERIFIED in unix-agent/pg_arca/pgcompat.py ONLY when its line here says PASS (that is what "verified" means in the product).
cd "$(dirname "$0")/../.."; ROOT=$(pwd)
VERS=${*:-12 13 14 15 16 17 18}
SUITES="tests.test_pgcompat tests.test_engine_pg tests.test_engine_standby_pg tests.test_engine_failover_pg tests.test_engine_targets_pg tests.test_wal_rescue_pg tests.test_engine_layout_pg tests.test_discovery_layouts_pg tests.test_archive_enable_pg tests.test_hba_pg tests.test_wal tests.test_restore_safety tests.test_crypto"
: > /tmp/matrix-summary.txt
for v in $VERS; do
  case $v in 10|11) tag="$v-bullseye";; *) tag="$v-bookworm";; esac
  echo "=== PostgreSQL $v ($tag)"
  docker run --rm -v "$ROOT":/work:ro,z -e LC_ALL=C.UTF-8 "postgres:$tag" bash -c '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends python3 python3-cryptography procps >/dev/null 2>&1
    cp -r /work/unix-agent /tmp/agent && chown -R postgres:postgres /tmp/agent
    su postgres -s /bin/bash -c "cd /tmp/agent && python3 -W ignore -m unittest '"$SUITES"' 2>&1"' > /tmp/matrix-$v.log 2>&1
  res=$(grep -E "^(Ran|OK|FAILED)" /tmp/matrix-$v.log | tr '\n' ' ')
  if grep -q "^OK" /tmp/matrix-$v.log; then st=PASS; else st=FAIL; fi
  echo "PG $v $st  $res" | tee -a /tmp/matrix-summary.txt
  [ $st = FAIL ] && grep -E "^(ERROR|FAIL):" /tmp/matrix-$v.log | head -20
done
