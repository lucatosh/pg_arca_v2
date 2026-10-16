#!/bin/sh
# pg-arca-agent package, before removal ($1 = "remove"; upgrades pass anything else and keep the agent).
# Removes every agent of this host (the further instances first, the main one last: the shared parts go with the last) and KEEPS backups and WAL
# archives. Refused (the package stays installed) while a PostgreSQL instance archives WAL through pg_arca, or when that cannot be checked:
# removing it would make every archive attempt fail and fill pg_wal. Switch archiving off first (or PG_ARCA_FORCE=1).
[ "$1" = remove ] || [ "$1" = 0 ] || exit 0
for c in /etc/pg-arca/*/agent.conf; do
  [ -f "$c" ] || continue
  PG_ARCA_UNINSTALL=1 PG_ARCA_INSTANCE="$(basename "$(dirname "$c")")" /usr/share/pg-arca-agent/install-agent.sh || exit 1
done
if [ -f /etc/pg-arca/agent.conf ]; then PG_ARCA_UNINSTALL=1 /usr/share/pg-arca-agent/install-agent.sh || exit 1; fi
exit 0
