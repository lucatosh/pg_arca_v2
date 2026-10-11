#!/bin/bash
# Lab helper: stop a running matrix (its script and its container) and start it again in the background.   matrix-restart.sh [versions]
# (patterns anchored on the process' own command line, so the calling ssh/bash is never matched)
cd "$(dirname "$0")"
pkill -f '^/bin/bash ./matrix.sh' ; pkill -f '^/bin/bash ./big-resume.sh'
for c in $(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /^postgres:[0-9]+-/ {print $1}'); do docker rm -f "$c" >/dev/null && echo "removed $c"; done
git -C ../.. pull -q --ff-only; git -C ../.. log --oneline -1 | cut -c1-70
./bg.sh /tmp/matrix-run.log ./matrix.sh ${*:-14 15 16 17 18}
