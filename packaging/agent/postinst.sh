#!/bin/sh
# pg-arca-agent package (.deb/.rpm), after install or upgrade. The package carries the agent bundle in /usr/share/pg-arca-agent;
# install-agent.sh puts it in service (/opt/pg-arca, systemd unit, polkit rule), exactly like the console's curl | bash install.
B=/usr/share/pg-arca-agent
if [ -f /etc/pg-arca/agent.conf ]; then
  # this server is already registered: upgrade the running agent(s) in place, configuration and credentials are kept
  echo "pg-arca-agent: upgrading the agent in service"
  PG_ARCA_NO_PKG=1 "$B/install-agent.sh" || echo "pg-arca-agent: the agent in service was NOT upgraded; run $B/install-agent.sh as root to see why" >&2
else
  echo "pg-arca-agent installed. Register this server with the console (as root):"
  echo "  PG_ARCA_URL=https://<console> PG_ARCA_ENROLL_TOKEN=<token from the console> $B/install-agent.sh"
  echo "  (without a token the server announces itself and waits for approval in the console; worker host: add PG_ARCA_ROLE=worker)"
fi
exit 0
