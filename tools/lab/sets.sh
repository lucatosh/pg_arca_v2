#!/bin/bash
# Lab helper: last backup sets' LSN range / status as stored in the repo.  sets.sh [N]
docker exec -i pg2 python3 - "${1:-4}" <<'PY'
import glob, json, sys
fs = sorted(glob.glob("/var/lib/pgarca/repo/*/*/backup/*/meta.json"))[-int(sys.argv[1]):]
for f in fs:
    m = json.load(open(f)); print(m["id"], m.get("status"), m.get("type"), "standby" if m.get("from_standby") else "primary", m.get("start_lsn"), m.get("stop_lsn"), (m.get("reason") or "")[:90])
PY
