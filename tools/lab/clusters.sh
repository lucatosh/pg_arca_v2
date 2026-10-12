#!/usr/bin/env bash
# Lab helper: what the console shows for each cluster (name, environment, nodes with role/version/data dir, archiving, top warnings).   clusters.sh [name filter]
cd "$(dirname "$0")"
./api.sh GET /api/clusters | python3 -c '
import json, sys
f = sys.argv[1] if len(sys.argv) > 1 else ""
d = json.load(sys.stdin)
for c in (d.get("clusters") if isinstance(d, dict) else d) or []:
    if f and f not in (c.get("name") or ""):
        continue
    print("== %s [%s] env=%s source=%s ha=%s" % (c.get("name"), c.get("id"), c.get("environment"), c.get("source"), (c.get("haState") or {}).get("managedByPatroni")))
    for n in (c.get("haState") or {}).get("nodes") or c.get("nodes") or []:
        print("   %-8s role=%-8s pg=%s state=%s" % (n.get("name"), n.get("role"), n.get("version") or n.get("pgVersion"), n.get("state")))
    for k in ("pgVersion", "archiveMode", "health", "warnings"):
        if c.get(k) not in (None, [], {}):
            print("   %s: %s" % (k, json.dumps(c.get(k))[:300]))
' "${1:-}"
