#!/bin/bash
# Lab helper: failed operations of the last 24 h grouped by type + error code (what the "N operazioni fallite" of the briefing is made of)
cd "$(dirname "$0")"
./api.sh GET "/api/operations?limit=1000" | jq -r --arg since "$(date -u -d '24 hours ago' +%FT%T)" '(.operations // .) | map(select(.status=="failed" and .updatedAt > $since))
  | map({t: .type, by: (.createdBy // "?"), c: ((.error // "" | tostring) | capture("(?<c>PGA-[A-Z]+-[0-9]+)")?.c // ((.error // "" | tostring)[0:70]))})
  | group_by([.t, .c, .by]) | map("\(length)\t\(.[0].t)\t\(.[0].by)\t\(.[0].c)") | .[]' | sort -rn
