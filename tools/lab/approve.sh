#!/bin/bash
# Lab helper: approve the pending join request of a node as a NEW cluster.  approve.sh <nodeName> <clusterName> [env]
cd "$(dirname "$0")/../.."
id=$(MAXC=200000 python3 tools/lab/op.py - /api/join-requests | python3 -c "
import sys,json
d=json.load(sys.stdin)
print([r['id'] for r in d['requests'] if r['nodeName']=='$1'][0])")
tools/lab/api.sh POST /api/join-requests/$id/approve "{\"name\":\"$2\",\"environment\":\"${3:-prod}\"}"
