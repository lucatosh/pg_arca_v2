#!/bin/bash
# Lab helper: check origin/main in a throw-away copy (does NOT touch /opt/pg_arca_v2 nor running scenarios):
# typecheck, UI build, server test suite. Usage: tools/lab/ci.sh [ref]   (log in /tmp/arca-ci.log)
set -o pipefail; SRC="${ARCA_SRC:-$(cd "$(dirname "$0")/../.." && pwd)}"; W=/tmp/arca-ci; REF=${1:-origin/main}
{
  git -C "$SRC" fetch -q origin
  rm -rf "$W"; git clone -q "$SRC" "$W" && git -C "$W" checkout -q "$(git -C "$SRC" rev-parse "$REF")" || exit 1
  ln -s "$SRC/node_modules" "$W/node_modules"; cd "$W"; git log --oneline -1
  echo "== tsc"; npx tsc --noEmit && echo "tsc OK"
  echo "== build"; npx vite build --outDir /tmp/arca-ci-dist 2>&1 | grep -E "error|built" 
  echo "== server tests"; for t in $(grep -o 'tests/[a-z/]*\.test\.ts' package.json); do timeout 300 npx tsx "$t" >/tmp/arca-ci-t.log 2>&1 && echo "PASS $t" || { echo "FAIL $t"; tail -15 /tmp/arca-ci-t.log; }; done
  echo "== done"
} 2>&1 | tee /tmp/arca-ci.log
