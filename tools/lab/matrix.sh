#!/bin/bash
# Compatibility matrix: run the agent's REAL-PostgreSQL test suites against several PostgreSQL major versions (official docker images).
#   usage: sg docker -c "tools/lab/matrix.sh 14 15 16 17 18"   (default: the supported 14..18; older majors are accepted, 10/11 use bullseye images)
#   results: FULL log in /tmp/matrix-<v>.log, one line per version on stdout and in /tmp/matrix-summary.txt
# A major version may be added to VERIFIED in unix-agent/pg_arca/pgcompat.py ONLY when its line here says PASS (that is what "verified" means in the product).
cd "$(dirname "$0")/../.."; ROOT=$(pwd)
VERS=${*:-14 15 16 17 18}
SUITES="tests.test_pgcompat tests.test_engine_pg tests.test_objects_v2 tests.test_objects_exotic_pg tests.test_objects_deps_pg tests.test_objects_ext_pg tests.test_late_created_pg tests.test_forensics_dml_pg tests.test_cancel_restore_pg tests.test_tablespace_later_pg tests.test_logical_copy_pg tests.test_wal_flush_pg tests.test_destcheck_pg tests.test_destination_switch_pg tests.test_destination_apply_pg tests.test_destination_migrate_pg tests.test_backup_crash_pg tests.test_restore_fuzz_pg tests.test_restore_fuzz_rel_pg tests.test_restore_faults_pg tests.test_weird_names_pg tests.test_money_locale_pg tests.test_restore_database_props_pg tests.test_into_other_server_pg tests.test_dest_standby_pg tests.test_restorecheck tests.test_walscan tests.test_walprefetch tests.test_worker tests.test_engine_standby_pg tests.test_engine_failover_pg tests.test_engine_targets_pg tests.test_wal_rescue_pg tests.test_engine_layout_pg tests.test_discovery_layouts_pg tests.test_archive_enable_pg tests.test_hba_pg tests.test_wal tests.test_restore_safety tests.test_crypto tests.test_live_pg tests.test_params_pg tests.test_engine_enospc_pg tests.test_patroni_dcs_only tests.test_snapshot_busy tests.test_hba tests.test_pgrestart tests.test_destcheck"
: > /tmp/matrix-summary.txt
for v in $VERS; do
  case $v in 10|11) tag="$v-bullseye";; *) tag="$v-bookworm";; esac
  echo "=== PostgreSQL $v ($tag)"
  # pull first, with a time limit and retries: a stalled pull (slow VM disk) must not block the whole matrix silently
  for try in 1 2 3; do timeout 900 docker pull -q "postgres:$tag" >/dev/null 2>&1 && break; echo "   pull of postgres:$tag failed/stalled (try $try)"; sleep 10; done
  timeout ${MATRIX_TIMEOUT:-5400} docker run --rm -v "$ROOT":/work:ro,z -e LC_ALL=C.UTF-8 "postgres:$tag" bash -c '
    export DEBIAN_FRONTEND=noninteractive
    # a VM whose clock is behind (suspended VirtualBox, no NTP) makes apt refuse the repositories ("Release file ... is not valid yet"): never let
    # the host clock decide whether the matrix runs; and if python3 is still missing, say so instead of reporting every version as failed tests
    APTO="-o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false"
    for t in 1 2 3; do apt-get $APTO update -qq >/dev/null 2>&1 && apt-get $APTO install -y -qq --no-install-recommends python3 python3-cryptography procps >/dev/null 2>&1 && break; sleep 5; done
    command -v python3 >/dev/null || { echo "MATRIX-ENV: python3 could not be installed in the container (apt failed: network or clock)"; exit 3; }
    mkdir -p /tmp/tools/lab && cp -r /work/unix-agent /tmp/agent && cp /work/tools/lab/*.sql /tmp/tools/lab/ && chown -R postgres:postgres /tmp/agent /tmp/tools
    su postgres -s /bin/bash -c "cd /tmp/agent && python3 -W ignore -m unittest '"$SUITES"' 2>&1"' > /tmp/matrix-$v.log 2>&1
  res=$(grep -E "^(Ran|OK|FAILED)" /tmp/matrix-$v.log | tr '\n' ' ')
  if grep -q "^OK" /tmp/matrix-$v.log; then st=PASS; elif grep -q "^MATRIX-ENV" /tmp/matrix-$v.log || ! grep -q "^Ran" /tmp/matrix-$v.log; then st=NOT-RUN; else st=FAIL; fi
  echo "PG $v $st  $res" | tee -a /tmp/matrix-summary.txt
  [ $st = FAIL ] && grep -E "^(ERROR|FAIL):" /tmp/matrix-$v.log | head -20
done
