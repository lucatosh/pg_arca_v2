#!/usr/bin/env bash
# pg_arca lab benchmark — run as the postgres user on a node with the agent configured. NOT yet run anywhere: check the output makes sense.
# Usage: bench.sh <scale> [workdir]      (pgbench scale 100 ≈ 1.5 GB, 1000 ≈ 15 GB, 7000 ≈ 100 GB)
# Measures: full backup, incremental after ~1% change, instance restore, one-database restore, repo size. Same steps with pgBackRest if `pgbackrest` + stanza `bench` exist.
set -euo pipefail
SCALE=${1:?scale}; OUT=${2:-/tmp/pgarca-bench}; mkdir -p "$OUT"; CSV="$OUT/results-$(date +%Y%m%d-%H%M%S).csv"
CLI=${PG_ARCA_CLI:-pg-arca-cli}; DB=benchdb
t() { local s=$(date +%s.%N); "$@" >"$OUT/last.log" 2>&1 || { echo "FAILED: $*"; tail -5 "$OUT/last.log"; return 1; }; echo "$(echo "$(date +%s.%N) - $s" | bc)"; }
row() { echo "$1,$2,$3,$4" | tee -a "$CSV"; }
echo "tool,step,seconds,repo_bytes" >"$CSV"
repo_arca() { du -sb "${PG_ARCA_REPO:-/var/lib/pgarca/repo}" 2>/dev/null | cut -f1; }
repo_brest() { du -sb "${PGBR_REPO:-/var/lib/pgbackrest}" 2>/dev/null | cut -f1; }
echo "== loading pgbench scale $SCALE"; createdb "$DB" 2>/dev/null || true; pgbench -i -s "$SCALE" "$DB" >/dev/null
echo "== pg_arca"
row pg_arca full "$(t $CLI backup --type full)" "$(repo_arca)"
psql -qd "$DB" -c "UPDATE pgbench_accounts SET abalance = abalance + 1 WHERE aid % 100 = 0;" ; psql -qc "CHECKPOINT;"
row pg_arca incr_1pct "$(t $CLI backup --type incr)" "$(repo_arca)"
rm -rf "$OUT/restore-arca"; mkdir -p "$OUT/restore-arca"
row pg_arca restore_instance "$(t $CLI restore instance --destination "$OUT/restore-arca")" "$(repo_arca)"
row pg_arca restore_one_db "$(t $CLI restore database --db "$DB" --rename "${DB}_bench")" "$(repo_arca)"
if command -v pgbackrest >/dev/null && pgbackrest info --stanza=bench >/dev/null 2>&1; then
  echo "== pgBackRest (stanza bench; set process-max / compress-type yourself and note them in the report)"
  row pgbackrest full "$(t pgbackrest --stanza=bench --type=full backup)" "$(repo_brest)"
  psql -qd "$DB" -c "UPDATE pgbench_accounts SET abalance = abalance + 1 WHERE aid % 100 = 1;" ; psql -qc "CHECKPOINT;"
  row pgbackrest incr_1pct "$(t pgbackrest --stanza=bench --type=incr backup)" "$(repo_brest)"
  rm -rf "$OUT/restore-brest"; mkdir -p "$OUT/restore-brest"
  row pgbackrest restore_instance "$(t pgbackrest --stanza=bench --pg1-path="$OUT/restore-brest" restore)" "$(repo_brest)"
  row pgbackrest restore_one_db "$(t pgbackrest --stanza=bench --pg1-path="$OUT/restore-brest-db" --db-include="$DB" restore)" "$(repo_brest)"
fi
echo "== done: $CSV  (repeat 3 times and report the median; note CPU count, disk type, compression settings)"
