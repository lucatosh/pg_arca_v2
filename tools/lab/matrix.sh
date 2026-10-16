#!/bin/bash
# Compatibility matrix: run the agent's REAL-PostgreSQL test suites against several PostgreSQL major versions (official docker images).
#   usage: sg docker -c "tools/lab/matrix.sh 14 15 16 17 18"   (default: the supported 14..18; older majors are accepted, 10/11 use bullseye images)
#   results: FULL log in /tmp/matrix-<v>.log, one line per version on stdout and in /tmp/matrix-summary.txt
# A major version may be added to VERIFIED in unix-agent/pg_arca/pgcompat.py ONLY when its line here says PASS (that is what "verified" means in the product).
cd "$(dirname "$0")/../.."; ROOT=$(pwd)
VERS=${*:-14 15 16 17 18}
SUITES=${MATRIX_SUITES:-"tests.test_pgcompat tests.test_eph_crash_pg tests.test_engine_pg tests.test_objects_v2 tests.test_objects_exotic_pg tests.test_objects_deps_pg tests.test_objects_ext_pg tests.test_late_created_pg tests.test_forensics_dml_pg tests.test_cancel_restore_pg tests.test_tablespace_later_pg tests.test_logical_copy_pg tests.test_wal_flush_pg tests.test_destcheck_pg tests.test_destination_switch_pg tests.test_destination_apply_pg tests.test_destination_migrate_pg tests.test_backup_crash_pg tests.test_restore_fuzz_pg tests.test_restore_fuzz_rel_pg tests.test_orphans_pg tests.test_restore_fuzz_shapes_pg tests.test_resource_leaks_pg tests.test_timeline_branch_pg tests.test_target_after_last_commit_pg tests.test_restored_pg tests.test_db_swap_pg tests.test_replace_pg tests.test_replace_unit tests.test_choose_set tests.test_restore_faults_pg tests.test_weird_names_pg tests.test_money_locale_pg tests.test_restore_database_props_pg tests.test_into_other_server_pg tests.test_dest_standby_pg tests.test_restorecheck tests.test_walscan tests.test_walprefetch tests.test_worker tests.test_engine_standby_pg tests.test_engine_failover_pg tests.test_engine_targets_pg tests.test_wal_rescue_pg tests.test_engine_layout_pg tests.test_discovery_layouts_pg tests.test_archive_enable_pg tests.test_hba_pg tests.test_wal tests.test_restore_safety tests.test_crypto tests.test_live_pg tests.test_params_pg tests.test_engine_enospc_pg tests.test_patroni_dcs_only tests.test_snapshot_busy tests.test_hba tests.test_pgrestart tests.test_destcheck tests.test_packs tests.test_walsummary tests.test_wal_summary_pg tests.test_s3 tests.test_offsite tests.test_wal_spool tests.test_wal_spool_pg tests.test_reincarnation_pg tests.test_rows_scenarios_pg tests.test_restore_point_pg tests.test_restore_review tests.test_console_resilience tests.test_offsite_restore_pg tests.test_rows_fk_pg"}   # MATRIX_SUITES="tests.x tests.y" runs only those (re-checking failures)
: > /tmp/matrix-summary.txt
# one matrix at a time, and its containers named: killing this script (or a timeout) must not leave a test container running. Two matrices plus the
# lab clusters on the 6.8 GB VM made the guest hang on 15/10 (an earlier run killed with pkill had left its container behind).
for c in $(docker ps -aq --filter label=arca-matrix); do docker rm -f "$c" >/dev/null 2>&1; done
trap 'for c in $(docker ps -aq --filter label=arca-matrix); do docker rm -f "$c" >/dev/null 2>&1; done' EXIT INT TERM
for v in $VERS; do
  case $v in 10|11) tag="$v-bullseye";; *) tag="$v-bookworm";; esac
  echo "=== PostgreSQL $v ($tag)"
  # pull first, with a time limit and retries: a stalled pull (slow VM disk) must not block the whole matrix silently
  for try in 1 2 3; do timeout 900 docker pull -q "postgres:$tag" >/dev/null 2>&1 && break; echo "   pull of postgres:$tag failed/stalled (try $try)"; sleep 10; done
  for c in $(docker ps -aq --filter label=arca-matrix); do docker rm -f "$c" >/dev/null 2>&1; done     # a previous version that hit the timeout
  timeout ${MATRIX_TIMEOUT:-10800} docker run --rm --name "arca-matrix-$v" --label arca-matrix -v "$ROOT":/work:ro,z -e LC_ALL=C.UTF-8 "postgres:$tag" bash -c '
    export DEBIAN_FRONTEND=noninteractive
    # a VM whose clock is behind (suspended VirtualBox, no NTP) makes apt refuse the repositories ("Release file ... is not valid yet"): never let
    # the host clock decide whether the matrix runs; and if python3 is still missing, say so instead of reporting every version as failed tests
    APTO="-o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false"
    for t in 1 2 3; do apt-get $APTO update -qq >/dev/null 2>&1 && apt-get $APTO install -y -qq --no-install-recommends python3 python3-cryptography procps >/dev/null 2>&1 && break; sleep 5; done
    command -v python3 >/dev/null || { echo "MATRIX-ENV: python3 could not be installed in the container (apt failed: network or clock)"; exit 3; }
    mkdir -p /tmp/tools/lab && cp -r /work/unix-agent /tmp/agent && cp /work/tools/lab/*.sql /tmp/tools/lab/ && chown -R postgres:postgres /tmp/agent /tmp/tools
    # one suite at a time, each with its own result line ("SUITE <name> rc=<n> <Ran/OK/FAILED>"): a timeout or a crash no longer loses
    # every result of the version, and a failure is attributed to its suite at once (on 15/10 a PG17 run was killed at 90 min with no summary)
    for s in '"$SUITES"'; do
      su postgres -s /bin/bash -c "cd /tmp/agent && timeout '"${SUITE_TIMEOUT:-1800}"' python3 -W ignore -m unittest $s" > /tmp/suite.log 2>&1; rc=$?
      echo "SUITE $s rc=$rc $(grep -E "^(Ran|OK|FAILED)" /tmp/suite.log | tr "\n" " ")"
      [ $rc = 0 ] || grep -E -A30 "^(ERROR|FAIL):" /tmp/suite.log | head -60
    done' > /tmp/matrix-$v.log 2>&1
  total=$(grep -c "^SUITE " /tmp/matrix-$v.log); bad=$(grep "^SUITE " /tmp/matrix-$v.log | grep -vc " rc=0 ")
  if grep -q "^MATRIX-ENV" /tmp/matrix-$v.log || [ "$total" = 0 ]; then st=NOT-RUN
  elif [ "$bad" = 0 ] && [ "$total" -ge $(echo $SUITES | wc -w) ]; then st=PASS
  elif [ "$bad" = 0 ]; then st=INCOMPLETE; else st=FAIL; fi
  echo "PG $v $st  suites $total/$(echo $SUITES | wc -w), failed $bad" | tee -a /tmp/matrix-summary.txt
  grep "^SUITE " /tmp/matrix-$v.log | grep -v " rc=0 " | head -20
done
