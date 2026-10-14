#!/bin/sh
# pg-arca-agent package, before removal ($1 = "remove"; upgrades pass anything else and keep the agent).
# Removes the agent in service but KEEPS backups and the WAL archive. Refused (the package stays installed) while PostgreSQL archives
# WAL through pg_arca: removing it would make every archive attempt fail and fill pg_wal. Switch archiving off first.
[ "$1" = remove ] || exit 0
[ -f /etc/pg-arca/agent.conf ] || exit 0
PG_ARCA_UNINSTALL=1 /usr/share/pg-arca-agent/install-agent.sh
