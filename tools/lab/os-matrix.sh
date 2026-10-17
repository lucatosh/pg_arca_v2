#!/bin/bash
# Multi-OS / multi-Python matrix for the agent (the PostgreSQL-version matrix is matrix.sh):
#   1. the agent's unit tests under every Python it supports - 3.6 (RHEL/Rocky 8 platform-python) up to 3.13;
#   2. the REAL-PostgreSQL restore suites on other Unix userlands: Alpine (musl, busybox, PostgreSQL built from source in /usr/local),
#      Rocky Linux 8 (python 3.6 + PGDG RPMs in /usr/pgsql-N), Rocky Linux 9 (python 3.9 + PGDG), Ubuntu 24.04 (distribution packages, python 3.12).
#   usage: sg docker -c "tools/lab/os-matrix.sh [py] [os]"      (no argument = both parts)
#   results: /tmp/os-matrix-summary.txt, full logs /tmp/os-*.log
# One container at a time (label arca-matrix: matrix.sh and this script never run two side by side on the 6.8 GB VM).
cd "$(dirname "$0")/../.."; ROOT=$(pwd)
PARTS=${*:-py os}
SUITES=${OS_SUITES:-"tests.test_engine_pg tests.test_restore_faults_pg tests.test_late_created_pg tests.test_reincarnation_pg tests.test_rows_fk_pg tests.test_rows_scenarios_pg tests.test_objects_v2 tests.test_objects_views_pg tests.test_objects_deps_pg tests.test_orphans_pg tests.test_encodings_pg tests.test_renamed_db_pg tests.test_dropped_then_backup_pg tests.test_offsite_restore_pg tests.test_db_swap_pg tests.test_replace_pg tests.test_timeline_branch_pg tests.test_cancel_restore_pg tests.test_restore_point_pg tests.test_wal_rescue_pg"}
OUT=/tmp/os-matrix-summary.txt; : > $OUT
for c in $(docker ps -aq --filter label=arca-matrix); do docker rm -f "$c" >/dev/null 2>&1; done
trap 'for c in $(docker ps -aq --filter label=arca-matrix); do docker rm -f "$c" >/dev/null 2>&1; done' EXIT INT TERM

pull() { for t in 1 2 3; do timeout 900 docker pull -q "$1" >/dev/null 2>&1 && return 0; sleep 10; done; return 1; }

if [[ " $PARTS " == *" py "* ]]; then
  for py in 3.6 3.8 3.10 3.12 3.13; do
    img=python:$py-slim; [ $py = 3.6 ] && img=python:3.6-slim-buster
    pull $img || { echo "python $py: NOT-RUN (image)" | tee -a $OUT; continue; }
    timeout 1800 docker run --rm --label arca-matrix -v "$ROOT":/work:ro,z $img bash -c \
      'pip install -q cryptography >/dev/null 2>&1 || echo "NOTE: cryptography not installable here: encryption tests skipped";
       cp -r /work/unix-agent /tmp/a && cp -r /work/tools /tmp/tools && cd /tmp/a && python -W ignore -m unittest discover -s tests -p "test_*.py" 2>&1 | tail -60' > /tmp/os-py$py.log 2>&1
    echo "python $py: $(grep -E '^(OK|FAILED)' /tmp/os-py$py.log | tail -1) $(grep -E '^Ran ' /tmp/os-py$py.log | tail -1)" | tee -a $OUT
  done
fi

# run_os <name> <image> <setup, as root: install python3 + PostgreSQL, leave initdb findable (PATH or PG_ARCA_TEST_BIN)>
run_os() {
  local name=$1 img=$2 setup=$3
  pull $img || { echo "os $name: NOT-RUN (image)" | tee -a $OUT; return; }
  timeout ${OS_TIMEOUT:-10800} docker run --rm --label arca-matrix -v "$ROOT":/work:ro,z -e LC_ALL=C.UTF-8 -e SUITES="$SUITES" $img sh -c "
    $setup
    command -v python3 >/dev/null || { echo 'OS-ENV: python3 missing'; exit 3; }
    id postgres >/dev/null 2>&1 || { echo 'OS-ENV: no postgres user'; exit 3; }
    cp -r /work/unix-agent /tmp/agent && mkdir -p /tmp/tools/lab && cp /work/tools/lab/*.sql /tmp/tools/lab/ && chown -R postgres /tmp/agent /tmp/tools
    echo \"ENV \$(uname -sr) \$(python3 -V 2>&1) \$(ls /usr/local/bin/initdb /usr/pgsql-*/bin/initdb /usr/lib/postgresql/*/bin/initdb 2>/dev/null | head -1)\"
    for s in \$SUITES; do
      su postgres -s /bin/sh -c \"cd /tmp/agent && PATH=\$PATH PG_ARCA_TEST_BIN=\$PG_ARCA_TEST_BIN timeout ${SUITE_TIMEOUT:-1800} python3 -W ignore -m unittest \$s\" > /tmp/suite.log 2>&1; rc=\$?
      echo \"SUITE \$s rc=\$rc \$(grep -E '^(Ran|OK|FAILED)' /tmp/suite.log | tr '\n' ' ')\"
      [ \$rc = 0 ] || grep -E -A30 '^(ERROR|FAIL):' /tmp/suite.log | head -60
    done" > /tmp/os-$name.log 2>&1
  local total=$(grep -c "^SUITE " /tmp/os-$name.log) bad=$(grep "^SUITE " /tmp/os-$name.log | grep -vc " rc=0 ")
  local st=FAIL; { grep -q "^OS-ENV" /tmp/os-$name.log || [ "$total" = 0 ]; } && st=NOT-RUN; [ "$total" -gt 0 ] && [ "$bad" = 0 ] && st=PASS
  echo "os $name $st  suites $total/$(echo $SUITES | wc -w), failed $bad  $(grep -m1 '^ENV ' /tmp/os-$name.log)" | tee -a $OUT
  grep "^SUITE " /tmp/os-$name.log | grep -v " rc=0 " | head -20 | tee -a $OUT
}

if [[ " $PARTS " == *" os "* ]]; then
  # Alpine: musl, busybox userland, PostgreSQL built from source in /usr/local/bin (the official image)
  run_os alpine-pg17 postgres:17-alpine 'apk add --no-cache bash python3 py3-cryptography procps coreutils >/dev/null 2>&1'
  # Rocky 8: python 3.6 (what RHEL 8 ships), PGDG packages in /usr/pgsql-16
  run_os rocky8-pg16 rockylinux:8 'dnf -y -q install https://download.postgresql.org/pub/repos/yum/reporpms/EL-8-x86_64/pgdg-redhat-repo-latest.noarch.rpm >/dev/null 2>&1;
    dnf -y -q module disable postgresql >/dev/null 2>&1; dnf -y -q install postgresql16-server postgresql16-contrib python3 procps-ng findutils >/dev/null 2>&1; export PG_ARCA_TEST_BIN=/usr/pgsql-16/bin'
  # Rocky 9: python 3.9, PGDG 15
  # (the distribution's own postgresql module hides the PGDG packages on EL9 too: disable it first, as on EL8)
  run_os rocky9-pg15 rockylinux:9 'dnf -y -q install https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm >/dev/null 2>&1;
    dnf -y -q module disable postgresql >/dev/null 2>&1; dnf -y -q install postgresql15-server postgresql15-contrib python3 python3-cryptography procps-ng findutils >/dev/null 2>&1; export PG_ARCA_TEST_BIN=/usr/pgsql-15/bin'
  # Ubuntu 24.04: the distribution packages (PostgreSQL 16, python 3.12)
  run_os ubuntu2404-pg16 ubuntu:24.04 'export DEBIAN_FRONTEND=noninteractive; APTO="-o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false";
    apt-get $APTO update -qq >/dev/null 2>&1; apt-get $APTO install -y -qq --no-install-recommends postgresql-16 postgresql-contrib python3 python3-cryptography procps >/dev/null 2>&1'
fi
echo "=== done"; cat $OUT
