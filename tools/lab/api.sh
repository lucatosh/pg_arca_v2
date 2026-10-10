#!/usr/bin/env bash
# Lab helper: call the console API as a test user.  usage: api.sh GET /api/clusters | api.sh POST /api/clusters/<id>/operations '{"type":"..."}'
BASE=${PG_ARCA_URL:-http://localhost:3000}; JAR=${TMPDIR:-/tmp}/arca-api.jar
U=${ARCA_USER:-claude-test}; P=${ARCA_PASS:-claude-lab-test-pass-1}
if ! curl -fs -b "$JAR" "$BASE/api/auth/status" | grep -q '"authenticated":true'; then
  curl -fs -c "$JAR" -H 'content-type: application/json' -d "{\"username\":\"$U\",\"password\":\"$P\"}" "$BASE/api/auth/login" >/dev/null || { echo "login failed" >&2; exit 1; }
fi
m=$1; path=$2; body=${3:-}
if [[ -n $body ]]; then curl -s -b "$JAR" -X "$m" -H 'content-type: application/json' -d "$body" "$BASE$path"; else curl -s -b "$JAR" -X "$m" "$BASE$path"; fi; echo
