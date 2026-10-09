# pg_arca lab node: PostgreSQL 16 + Patroni + the tools needed to poke at it. The agent is NOT baked in: it is installed
# at start from the mounted repo (/work/unix-agent) with the real install-agent.sh, so every `lab.sh up` tests the installer too.
FROM postgres:16
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-psycopg2 python3-cryptography gettext-base ca-certificates \
      pgbackrest zstd git curl jq procps iproute2 iputils-ping netcat-openbsd dnsutils tcpdump strace htop \
      vim-tiny less sudo bc rsync lsof \
 && pip3 install --no-cache-dir --break-system-packages 'patroni[etcd3]' \
 && rm -rf /var/lib/apt/lists/*
COPY patroni.yml.tpl /etc/patroni.yml.tpl
COPY entrypoint.sh /entrypoint.sh
COPY lab-profile.sh /etc/profile.d/lab.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
