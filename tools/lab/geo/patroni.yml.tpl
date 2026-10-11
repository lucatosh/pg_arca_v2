# rendered by entrypoint-geo.sh: ${SCOPE} geo-dc1|geo-dc2, ${ETCD} the site's own etcd, ${STANDBY} the standby_cluster block on DC2 (empty on DC1)
scope: ${SCOPE}
log: {level: INFO, dir: /var/log/patroni, file_num: 3, file_size: 10485760}
name: ${NODE}
restapi: {listen: 0.0.0.0:8008, connect_address: "${NODE}:8008"}
etcd3: {hosts: "${ETCD}:2379"}
bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    slots: ${SLOTS}            # DC1: permanent slot for the remote site (the primary keeps the WAL DC2 has not received yet); DC2: none
${STANDBY}
    postgresql:
      use_pg_rewind: true
      use_slots: true
      parameters:
        wal_level: replica
        hot_standby: "on"
        max_wal_senders: 10
        max_replication_slots: 10
        wal_log_hints: "on"
        archive_mode: "on"
        archive_command: "/usr/local/bin/pg-arca-wal archive %p %f"
        archive_timeout: 60
        wal_keep_size: 512MB
  initdb: [encoding: UTF8, data-checksums]
  pg_hba:
    - host replication replicator 172.30.0.0/16 scram-sha-256
    - host all all 172.30.0.0/16 scram-sha-256
    - local all all trust
    - host all all 127.0.0.1/32 trust
postgresql:
  listen: 0.0.0.0:5432
  connect_address: "${NODE}:5432"
  data_dir: /var/lib/postgresql/data/pgdata
  bin_dir: /usr/lib/postgresql/16/bin
  parameters: {logging_collector: "on", log_directory: log, log_filename: postgresql.log, log_line_prefix: "%m [%p] %q%u@%d "}
  authentication:
    superuser: {username: postgres, password: "${PG_SUPER_PASSWORD}"}
    replication: {username: replicator, password: "${PG_REPL_PASSWORD}"}
tags: {nofailover: false, noloadbalance: false, clonefrom: false, nosync: false}
