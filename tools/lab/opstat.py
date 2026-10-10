#!/usr/bin/env python3
"""Lab helper: summarise data/state.json operations (run in /opt/pg_arca_v2)."""
import json, collections
s = json.load(open("data/state.json")); ops = s["operations"]
print("total", len(ops)); print(collections.Counter(o["status"] for o in ops))
for o in ops[-12:]: print(o["id"][-6:], o["type"], o["status"], o["createdAt"][5:19], (o.get("progress") or {}).get("phase", ""), "cancelReq" if o.get("cancelRequested") else "")
act = [o for o in ops if o["status"] in ("queued", "leased", "running")]
print("ACTIVE", [(o["id"][-6:], o["type"], o["status"]) for o in act])
import sys
if len(sys.argv) > 1:
    for o in ops:
        if o["type"] == sys.argv[1] and o["createdAt"] > "2026-10-10T12":
            print("--", o["id"], o["status"], o["createdAt"][11:19], json.dumps(o.get("params")), "cancelReq" if o.get("cancelRequested") else "", "| err:", str(o.get("error"))[:300])
            for h in o.get("history", [])[-6:]: print("     ", h["at"][11:19], h["status"], h.get("note", "")[:160])
