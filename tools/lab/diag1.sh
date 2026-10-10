#!/bin/bash
# Lab helper: failures of the PG12 matrix run + the failed drill
cd "$(dirname "$0")/../.."
echo "## matrix-12"; grep -E '^(FAIL|ERROR):' /tmp/matrix-12.log | head -12
grep -B2 -A12 -E '^ERROR: ' /tmp/matrix-12.log | grep -vE "^--$" | head -60 | cut -c1-200
echo "## drill"; python3 tools/lab/opstat.py restore_drill | tail -6
python3 tools/lab/op.py show 8045ac | grep -E '"error"' | cut -c1-600
