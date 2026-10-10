#!/bin/bash
# Lab helper: one-shot report of every background job and the cluster state.
cd "$(dirname "$0")/../.."
echo "## stby"; grep -E '^(===|PASS|FAIL|SUMMARY)' /tmp/stby.log 2>/dev/null | tail -14
echo "## matrix"; cat /tmp/matrix.out 2>/dev/null; for f in /tmp/matrix-*.log; do [ -f "$f" ] && { echo "[$f]"; grep -E '^(Ran|OK|FAILED|FAIL:|ERROR:)' "$f" | head -8; }; done
echo "## solo"; tail -2 /tmp/solo-up.log | cut -c1-140; docker ps --format '{{.Names}} {{.Status}}' | grep -E 'solo|pg[123]'
echo "## clusters"; MAXC=200000 python3 tools/lab/op.py - /api/clusters 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);[print(c['id'],c['name'],c.get('source'),c.get('status')) for c in d['clusters']]"
echo "## joins"; python3 tools/lab/op.py - /api/join-requests 2>/dev/null | head -c 600
echo "## ops"; python3 tools/lab/opstat.py | tail -6
