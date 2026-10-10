#!/usr/bin/env python3
"""Lab helper: summarise data/state.json operations (run in /opt/pg_arca_v2)."""
import json, collections
s = json.load(open("data/state.json")); ops = s["operations"]
print("total", len(ops)); print(collections.Counter(o["status"] for o in ops))
for o in ops[-12:]: print(o["id"][-6:], o["type"], o["status"], o["createdAt"][5:19], (o.get("progress") or {}).get("phase", ""), "cancelReq" if o.get("cancelRequested") else "")
act = [o for o in ops if o["status"] in ("queued", "leased", "running")]
print("ACTIVE", [(o["id"][-6:], o["type"], o["status"]) for o in act])
