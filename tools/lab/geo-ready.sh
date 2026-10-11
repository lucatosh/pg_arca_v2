#!/bin/bash
# Lab helper: the DR readiness of every geo pair as the console computes it.   bash geo-ready.sh
cd "$(dirname "$0")"
./api.sh GET /api/geo | jq -r '.groups[] | "== \([.sites[].name] | join(" <-> ")): \(.readiness.status) (perdita stimata \(.readiness.rpoSec) s, obiettivo \(.readiness.rpoTargetSec) s)", (.readiness.checks[] | "  \(.level)\t\(.text)")'
