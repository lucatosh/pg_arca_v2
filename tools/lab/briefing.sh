#!/bin/bash
# Lab helper: the console briefing ("Oggi") as plain lines: severity cluster code title.   bash briefing.sh [code-filter]
cd "$(dirname "$0")"
./api.sh GET /api/briefing | jq -r '(.items // .issues // [])[] | "\(.severity)\t\(.clusterName)\t\(.code)\t\(.title)"' | grep -E "${1:-.}" | sort
