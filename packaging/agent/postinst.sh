#!/bin/sh
# pg-arca-agent package (.deb/.rpm), after install or upgrade. The package carries the agent bundle in /usr/share/pg-arca-agent;
# install-agent.sh puts it in service (/opt/pg-arca, systemd units, restart permission), exactly like the console's curl | bash install.
B=/usr/share/pg-arca-agent
# every agent already registered on this host: the main one (/etc/pg-arca/agent.conf) and one per further instance (/etc/pg-arca/<name>/agent.conf).
# One run of the installer upgrades the shared code and restarts all of them; it is run for the main agent, or for the first instance when there is none.
FIRST=""
if [ -f /etc/pg-arca/agent.conf ]; then FIRST=main
else for c in /etc/pg-arca/*/agent.conf; do [ -f "$c" ] && { FIRST=$(basename "$(dirname "$c")"); break; }; done; fi
if [ -n "$FIRST" ]; then
  echo "pg-arca-agent: upgrading the agent(s) in service"
  if [ "$FIRST" = main ]; then PG_ARCA_NO_PKG=1 "$B/install-agent.sh"; else PG_ARCA_NO_PKG=1 PG_ARCA_INSTANCE="$FIRST" "$B/install-agent.sh"; fi \
    || echo "pg-arca-agent: the agent in service was NOT upgraded; run $B/install-agent.sh as root to see why" >&2
else
  echo "pg-arca-agent installed. Register this server with the console (as root):"
  echo "  PG_ARCA_URL=https://<console> PG_ARCA_ENROLL_TOKEN=<token from the console> $B/install-agent.sh"
  echo "  (without a token the server announces itself and waits for approval in the console; worker host: add PG_ARCA_ROLE=worker)"
fi
exit 0
