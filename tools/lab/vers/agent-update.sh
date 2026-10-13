#!/bin/bash
# inside a lab container: upgrade the agent the way a customer does - re-run the installer served by the console it is enrolled with
u=$(python3 -c 'import json; print(json.load(open("/etc/pg-arca/agent.conf"))["web_server_url"])')
curl -fsSL "$u/agent/install.sh" | PG_ARCA_URL="$u" bash 2>&1 | tail -2
