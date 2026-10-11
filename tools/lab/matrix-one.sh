#!/bin/bash
# Lab helper: run ONE agent test (or suite) on one PostgreSQL major, verbose (V=1: engine log on stderr).   matrix-one.sh 14 tests.test_engine_pg.EngineTests.test_05c_a_dropped_database_comes_back
cd "$(dirname "$0")/../.."; ROOT=$(pwd); v=$1; shift
docker run --rm -v "$ROOT":/work:ro,z -e LC_ALL=C.UTF-8 "postgres:$v-bookworm" bash -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends python3 python3-cryptography procps >/dev/null 2>&1
  mkdir -p /tmp/tools/lab && cp -r /work/unix-agent /tmp/agent && cp /work/tools/lab/*.sql /tmp/tools/lab/ && chown -R postgres:postgres /tmp/agent /tmp/tools
  su postgres -s /bin/bash -c "cd /tmp/agent && V=1 python3 -W ignore -m unittest -v '"$*"' 2>&1"' 2>&1 | tail -${TAIL:-80} | cut -c1-260
