# Second lab target, deliberately UNLIKE the Patroni lab: PostgreSQL 15, no Patroni, no systemd, non-standard paths, config outside PGDATA, port 5433,
# a tablespace, logging collector into /var/log/pg15, archiving OFF, wal_level minimal, no checksums. The agent must discover all of that on its own.
FROM postgres:15-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-psycopg2 python3-cryptography ca-certificates zstd curl jq procps iproute2 sudo rsync lsof less vim-tiny \
 && rm -rf /var/lib/apt/lists/*
COPY entrypoint-solo.sh /entrypoint-solo.sh
RUN chmod +x /entrypoint-solo.sh
ENTRYPOINT ["/entrypoint-solo.sh"]
