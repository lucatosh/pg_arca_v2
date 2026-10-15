# pg_arca

Console and agent for **backup, point-in-time recovery (PITR) and management of PostgreSQL clusters**.

- **Web console** (Node/Express + React): cluster inventory, nodes, high availability (Patroni), parameters, backup, restore, audit log.
- **Unix agent** (Python 3.6+, standard library only): runs on the database server, opens the connection to the console (no inbound port), executes operations and contains the backup/restore engine.

The console and every message it shows are in English (the agent's checks, warnings and errors included).

> This document describes **what exists and has been run**. The parts that are not real yet are listed explicitly in [Status](#real-status-of-the-features).

## Real status of the features

| Area | Status | How it was verified |
| --- | --- | --- |
| Connecting a cluster with the agent (single-use token, enrollment, heartbeat, long-poll) | Works | End-to-end agent↔console tests over HTTP with the real routes |
| Connecting a cluster **without** the agent (PostgreSQL connection, optional Patroni REST) | Written, **never run against a real PostgreSQL** (the `pg` package cannot be installed in the development environment) | Stub tests only: try it before relying on it |
| Operations (idempotency key, lease, redelivery, TTL, cancellation, control/data lanes) | Works | `tests/server/ops.test.ts`, `api.test.ts` |
| Page-level full / differential / incremental backup, deduplication, every chunk verified on read | Works | 15 tests on **real PostgreSQL 16** (`unix-agent/tests/test_engine_pg.py`) |
| Instance restore with PITR (time / LSN / xid / name), WAL coverage checked before starting | Works | same |
| Restore of **one database** (only its files are extracted) and of **one table** (into a quarantine database) | Works | same |
| **The restore finishes in the original** ("When done" choice): table put back, rows brought back, database swapped in for the original (the current one kept), **production server put back in place as it was** (rebuilt next to the data, stop/swap/start, automatic rollback, also with production down without losing unarchived WAL; not on Patroni) | Tested on real PG16; UI with a simulated agent; lab: every restore scenario, server replacement included, on fresh Debian/Ubuntu/Rocky servers | `test_replace_pg.py`, `test_db_swap_pg.py`, `test_engine_pg.py`, `tests/ui/e2e.cjs`, `tools/lab/ui/restore-ui.cjs` |
| Test restore (actually recovers the latest backup into a temporary instance) | Works | same |
| Cleanup (retention, chunk garbage collection, WAL) | Works | same |
| DROP/TRUNCATE search in the WAL (`pg_waldump`) | Works | same |
| Backup scheduling (idempotent, back-off, retention, periodic verification) | Works | `tests/server/scheduler.test.ts` |
| High availability: switchover, failover, member restart, maintenance mode (Patroni) | Preconditions and verification of the effect; switchovers run from the console on the real Patroni lab (3 nodes and a geo pair) | Tests with simulated Patroni, `tools/lab/scenario-geo.py`, `scenario-ha.sh` |
| Parameters (`ALTER SYSTEM` + reload; Patroni: DCS only) | Written; tested with simulated psql | `unix-agent/tests` |
| Web interface | Works in the browser (Chromium) with a simulated agent | `tests/ui/e2e.cjs` |
| Guided restore by situation (table dropped or truncated, wrong rows, database as it was, whole server), point in time proposed from the WAL, plain-language check | Works in the browser with a simulated agent | `tests/ui/e2e.cjs` |
| Fluidity: what is typed or chosen survives switching tabs, opening a setting from inside a form or going Back (drafts in memory and in the browser session, never for passwords, tokens or webhook URLs; cleared on save, cancel and sign-out); dialogs with entered data protected from stray clicks; scroll position restored on Back | Works in the browser with a simulated agent | `tests/ui/fluidity.cjs` |
| Desktop and phone layout (no page wider than the screen, no clipped text) | Checked on every page and tab | `tests/ui/sweep.cjs` |
| No Italian left in the interface | Guarded on every string and JSX text of `src/` | `tests/ui/i18n.test.ts` |
| Cluster access matrix (every node → every node, replication + superuser, one-click rules) | Done | tests: `hbalogic.test.ts`, e2e |
| Prometheus metrics (`/metrics`, bearer token, off by default) | Done | tests: `metrics.test.ts` |
| Console state snapshots (daily, 14 kept, `/api/health.stateSnapshot`) | Done | tests: `store.test.ts` |
| API tokens for automation (bearer, per-token role and expiry, revocable, audited as `token:<label>`) | Done | tests: `apitokens.test.ts`, e2e |
| Read rate limit per policy (scheduled backups never saturate production storage; `read_limit_mb_s` on the operation, token bucket shared by the worker threads) | Done; checked on a real full backup (15 MB/s honoured) | `scheduler.test.ts`, `test_walsummary.py::Limiter` |
| Backup policies per folder / environment / cluster (suggested and custom templates, inheritance) | Works: resolved on every scheduler tick, no copies | `tests/server/policies.test.ts`, `tests/ui/e2e.cjs` |
| pg_hba management (Patroni: DCS ONLY, the file is never read or written; otherwise the file; lock-out simulation, verification with `pg_hba_file_rules`, previous versions / rollback) | Agent tested on real PostgreSQL 16 (simulated Patroni that rewrites and reloads); DCS on the Patroni lab tested on 11/10 (9/9) before the latest changes, to be rerun with `tools/lab/hba-all.sh` | `unix-agent/tests/test_hba*.py`, `tests/server/hba.test.ts`, `tests/ui/hbalogic.test.ts` |
| HBA assistant in the UI (duplicates, shadowed rules, ordering, descriptions, templates) | Works in the browser with a simulated agent | `tests/ui/e2e.cjs` |
| Discovery: agent advice and differences between nodes | Works | `tests/server/discovery.test.ts`, `unix-agent/tests/test_discovery_advisor.py` |
| Bring a restored table back into the database (`as_new` / `replace`, non-destructive) | Agent tested on PG16 | `test_engine_pg.py` |
| Restore of objects with dependencies and of whole schemas (FKs, views, sequences, types, ACLs; atomic `replace` / `missing_only` / `as_new`; preview before anything is touched) | Tested on real PG16; Patroni lab to be rerun | `test_objects_v2.py` |
| Configurable recovery instance (global/environment/folder/cluster; on the node or central; binaries per version; private or system PostgreSQL installation) | Configuration and pre-flight tested; installation and central placement **not tested on a real network** | `test_ephcfg.py`, `scoped.test.ts` |
| Backup destination per cluster/environment/folder/global: local directory or mounted NFS/SMB share (S3/Azure/GCS/SFTP: preview). Check on every node with **both users that write** (agent and PostgreSQL server via `COPY … TO PROGRAM`, like archive_command), permissions, share user mapping, inodes, `soft`/`ro`, another cluster's WAL archive, fix commands. Apply with verification of the first WAL segment (otherwise automatic return to the previous directory) and four-eyes approval in protected environments. The previous location stays **readable by restores** (PITR across the change included); verified, resumable **background migration** with bandwidth limit, space and estimated duration before starting; deletion of the old location only on explicit request | Real PG16: change, PITR across it, migration interrupted and resumed, encrypted, WAL rollback; different users tested with `runuser`. Real NFS/SMB mounts **not tested** (lab) | `test_destcheck.py`, `test_destcheck_pg.py`, `test_destination_switch_pg.py`, `test_destination_apply_pg.py`, `test_destination_migrate_pg.py`, `destinations.test.ts`, UI e2e |
| Guided tuning (agent RAM/cores + workload → parameters, applied with `pg_set_param`) | Works; general sizing rules, not measurements | `tests/ui/tuning.test.ts` |
| Users and roles (administrator / operator / read-only), sessions revoked on role change | Works; deny by default on every route that changes something | `tests/server/rbac.test.ts` |
| Repository encryption (AES-256-GCM on chunks, manifests, catalogs and WAL archive; keyed chunk identifiers; key outside the repository) | Works; tested with the whole suite on PG16 with an encrypted repository (`PG_ARCA_TEST_ENCRYPT=1`). An existing repository is not encrypted in place: a new one is needed. Requires the Python `cryptography` package. WAL `.history` files and labels stay in clear text | `unix-agent/tests/test_crypto.py`, `test_engine_pg.py` |
| Worker hosts (backup server, recovery host): agent without database discovery, inventory, dedicated page, use as the restore node | Server and agent with tests; UI with a simulated agent; lab not yet | `tests/server/workers.test.ts`, `test_worker.py`, `tests/ui/e2e.cjs` |
| Several DBAs on the same cluster: conflicts refused with who/what/since when, running activity visible | Server with tests; UI with a simulated agent | `tests/server/conflicts.test.ts` |
| Disk space per volume before restores and promotions (scratch + cluster data added up) | Agent tested on PG16; UI with a simulated agent | `test_restorecheck.py`, `test_objects_v2.py` |
| WAL scan to find DROP/TRUNCATE (parallel, cached) and DROPPED in red in the database choice | Agent tested on PG16 (2.1 s cold, 0.02 s cached on the local test); UI with a simulated agent | `test_walscan.py`, `tests/ui/e2e.cjs` |
| Checks before the restore (chunk chain, space, name taken) and WAL read-ahead | Agent tested on PG16 (recovery −38 % measured); UI with a simulated agent | `test_restorecheck.py`, `test_walprefetch.py`, `tests/ui/e2e.cjs` |
| Recovery of single rows (primary-key comparison between restored and current table, safety copy, a single transaction) | Agent tested on PG16; UI tested with a simulated agent | `test_engine_pg.py::test_06b0`, `tests/ui/e2e.cjs` |
| Disaster recovery drill (restores the whole cluster into scratch, starts it, checks every database, measures the time) | Tested on PG16 (small test cluster): the measured time applies to that server and data volume | `test_engine_pg.py::test_06x` |
| "Today" page: problems with cause and next step (missing/old backups, WAL gaps, failing archiving, inactive slots, lagging replicas, disks, connections, overdue verification/drill) | Works on telemetry; general thresholds, not tuned | `tests/server/health.test.ts` |
| Webhook notifications (JSON or Slack/Teams text): new problem, reminder, resolved; retries after an error; the URL never goes back to the browser | Works (tested against a local HTTP server); **not tested against real Slack/Teams; no email** | `tests/server/health.test.ts` |
| Geo-redundancy: primary/standby sites (Patroni standby_cluster or physical standby), detected or declared relationships, tree in the fleet, planned switchover and DR promotion through each site's DCS, automatic failover and rejoin, same-timeline divergence detected and rebuilt | Console with simulated agents (`tests/server/geo.test.ts`, e2e); hy lab: switchover both ways, automatic failover with no rows lost | `tests/server/geo.test.ts`, `tools/lab/geo.sh`, `tools/lab/scenario-hy.py` |
| Two-person approval per environment (pg_hba, parameters, HA, table replacement, row recovery) | Works; requires at least two active administrators | `tests/server/approvals.test.ts` |
| HBA: adoption of existing rules into the managed block (evaluation order unchanged) and temporary rules with expiry | Agent tested on PG16; expiry driven by the scheduler; on Patroni too (in the DCS, a single member applies it) | `test_hba_pg.py::test_5`, `tests/server/hba.test.ts` |
| New servers that announce themselves (agent installed without a token → pending request → approval in the UI choosing environment/cluster) | Works, tested with the real agent against the real console; the agent generates the secret and only its hash reaches the console. Unauthenticated endpoint, therefore limited (100 pending, 10 per address, 48 h expiry) and can be turned off in Settings | `tests/server/join.test.ts`, `unix-agent/tests/test_e2e_console.py`, `tests/ui/e2e.cjs` |
| LDAP / Active Directory sign-in to the console (simple bind, StartTLS/LDAPS, user search or DN template, groups → roles, no dependency) | Done; tested against a simulated directory, not yet against a real AD | tests: `ldap.test.ts`, e2e |
| LDAP sync of PostgreSQL roles | **Preview**: visible and marked, no function behind it | — |
| Speed compared with pgBackRest | **Never measured**: no claims | — |
| Restore: objects with unusual names (spaces, unicode, dots, 63 characters), RLS, exclusion, inheritance, **single partition** (re-attached to the live table), extended statistics, shared sequences, domains with functions, stand-alone views/sequences, objects and databases **created after the last backup**, database owners/privileges/settings, delivery to another server without its tablespaces/roles, publications/rules/policies/defaults of other tables re-attached, a 1500-table schema (lock limit stated beforehand) | Tested on real PostgreSQL 16; the 14-18 matrix to be rerun with these tests | `test_objects_exotic_pg.py`, `test_objects_deps_pg.py`, `test_late_created_pg.py`, `test_restore_database_props_pg.py`, `test_into_other_server_pg.py`, `test_scale_schema_pg.py` (opt-in) |
| Restart of a stand-alone PostgreSQL from the console (the server's systemd unit through a restricted polkit rule, or pg_ctl without systemd) | `pg_ctl` tested on real PG16; systemd/polkit used by the lab restore runs | `test_pgrestart.py`, `test_archive_enable_pg.py` |
| Enrollment: token for several servers (Patroni nodes), enrollment outcome printed by the installer, expired/used token → announcement for approval | Real agent against the real console | `tests/server/api.test.ts`, `test_e2e_console.py` |

Typed confirmations use English words (REPLACE, DELETE, RESTART, PROMOTE, DEMOTE, ORPHANS, SWITCHOVER, INSTALL); the server and the agent still accept the Italian words of earlier versions.

Known limits: backups from a standby require `archive_mode=always`; incrementals require `data_checksums` or `wal_log_hints`; backup and restore require the agent on the server; a materialized view restored on its own is refreshed on the current data; row-by-row recovery requires a primary key or a unique index on NOT NULL columns; a table created after the last backup and dropped before the next one has no name in the WAL scan (restore the whole database to a point before the drop).

## Architecture

```
Browser ──HTTPS──> Console (server.ts) <──HTTPS (outbound only)── Agent (on every node) ── psql / pg_ctl / Patroni REST
                      │  store.json (atomic)                            │  repository: cas/ + stanza/<cluster>/backup/<set>/
                      └─ operations, audit, scheduler                   └─ shared WAL archive (write-once, fsync)
```

- **Repository**: *content-addressed* store — 64 KiB chunks, blake2b-256 hash verified on every read, zstd/zlib compression. Every backup is a manifest of `[offset, length, hash]`; identical chunks are stored once.
- **Incrementals**: page LSNs are compared (main forks only; FSM/VM and other forks whole). The chain is validated before starting, otherwise the backup becomes a full one.
- **Backup safety**: chunks written around an interrupted run are re-verified before deduplication; a single `sync` before the backup commit; garbage collection has a 48 h grace period.
- **Restore**: never writes into the data directory in use (protected paths, symlink checks, never as root). A restore always works on a copy first (new name, quarantine, directory next to the data) and only at the end, if chosen and confirmed, swaps it in for the original, which is kept (`<db>_before_<ts>`, `_old_<date>` tables, `<pgdata>.pgarca-before-<ts>`); on error whatever was created is removed and the original is not touched. The temporary instance used for recovery is isolated (no network, archiving off, read-only).
- **PITR**: `target_time` requires a time zone; the base backup is the most recent one finished before the chosen point; WAL coverage is checked *before* starting.
- **Operations**: every action has an Idempotency-Key; backup and restore are never repeated automatically after a crash; the *control* lane (HA, parameters) is separate from the *data* lane (backup, restore), so an hours-long backup never blocks a switchover.

## Installation

Packaged releases (console tarball with its own Node.js runtime and installer, container image, agent tarball/.deb/.rpm): see [INSTALL.md](INSTALL.md) for installation and administration and [RELEASE.md](RELEASE.md) for the artifacts, the versioning and the release gate. Current version: `1.0.0-rc.1` (release candidate).

## Quick start (development)

Console (needs Node 20+):

```bash
npm install
npm test                 # TypeScript suite + the agent's Python tests
npm run dev              # http://localhost:3000 — the first sign-in creates the administrator
# production: npm run build && NODE_ENV=production tsx server.ts
```

> How backup and restore work (format, algorithms, limits, an honest comparison with pgBackRest): see [ARCHITETTURA-BACKUP-RESTORE.md](ARCHITETTURA-BACKUP-RESTORE.md) — updated with every engine change.

Variables: `PORT`, `PG_ARCA_DATA_DIR` (persistent state, default `./data`), `PG_ARCA_ADMIN_USER` / `PG_ARCA_ADMIN_PASSWORD` (non-interactive creation of the administrator). TLS: `PG_ARCA_TLS_CERT` + `PG_ARCA_TLS_KEY` (native), or a TLS reverse proxy; all settings in [INSTALL.md](INSTALL.md).

Agent: in the console, **Clusters → Connect cluster → With agent**, copy the command and run it as root on the server. The installer detects PostgreSQL/Patroni and creates the user, directories and systemd service. Then enable WAL archiving from the Backup tab (“Enable WAL archiving”; on Patroni it goes through the DCS), or by hand on the primary:

```ini
wal_level = replica
archive_mode = on
archive_command = '/usr/local/bin/pg-arca-wal archive %p %f'
```

The first backup must be a full backup; then enable scheduling from the Backup tab.

## Command line (on the node)

```bash
pg-arca-cli status                    # local telemetry
pg-arca-cli discover                  # real discovery of PostgreSQL, Patroni, etcd, pgbouncer, pgBackRest
pg-arca-cli wal-check                 # WAL archive continuity (exit 3 when there are gaps)
pg-arca-cli backup --type full        # full | diff | incr
pg-arca-cli info                      # backups, WAL range, deduplication
pg-arca-cli verify [--deep] [--restore-test]
pg-arca-cli expire [--dry-run]
pg-arca-cli forensics                 # DROP/TRUNCATE in the WAL
pg-arca-cli restore database --db billing --target-time '2026-10-08 11:42:00+02' --rename billing_pitr
pg-arca-cli restore object --object billing.public.invoices --target-time '2026-10-08 11:42:00+02'
pg-arca-cli restore instance --destination /var/lib/postgresql/restore --target-time '2026-10-08 11:42:00+02' [--dry-run]
```

## Development and tests

| What | Command |
| --- | --- |
| Server (ops, view, API, scheduler) | `tsx tests/server/<name>.test.ts` |
| Agent (WAL, executor, e2e with the console) | `cd unix-agent && python3 -m unittest discover -s tests -t .` |
| Engine with real PostgreSQL 16 | as a **non-root** user (PostgreSQL refuses root): `su postgres -c 'cd unix-agent && python3 -m unittest tests.test_engine_pg'` — skips by itself when PostgreSQL is missing or you are root |
| Interface in the browser | `esbuild src/main.tsx --bundle --outfile=<dir>/app.js --loader:.css=css --jsx=automatic`, then `tsx tests/ui/devserver.ts 5188 <dir>` and `node tests/ui/e2e.cjs` (Playwright; the test server uses the real routes with a simulated agent — tests only) |
| No Italian left in the interface | `tsx tests/ui/i18n.test.ts` |

## Guide: a 3-node Patroni test cluster

> Lab procedure inherited from the first version of the project: **it has not been rerun** during the rewrite. Check versions and paths before using it.

This guide builds a real cluster with **3 Ubuntu 22.04 LTS virtual machines on a KVM hypervisor** for a high-availability topology with a distributed etcd quorum.

### Network and IP addresses

| Virtual machine | Host name | IP address | Components |
| :--- | :--- | :--- | :--- |
| **VM 1** | `pg-node-01` | `192.168.100.11` | etcd member 1 + Patroni + PostgreSQL 16 + pg_arca agent |
| **VM 2** | `pg-node-02` | `192.168.100.12` | etcd member 2 + Patroni + PostgreSQL 16 + pg_arca agent |
| **VM 3** | `pg-node-03` | `192.168.100.13` | etcd member 3 + Patroni + PostgreSQL 16 + pg_arca agent |

---

### Step 1: base setup on all 3 VMs

Run on **all three nodes**:
```bash
# Update the packages
sudo apt update && sudo apt upgrade -y

# Official PostgreSQL repository
sudo apt install -y curl ca-certificates gnupg lsb-release
sudo install -d /etc/apt/keyrings
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg
echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list

# PostgreSQL 16, etcd, Patroni and support tools
sudo apt update
sudo apt install -y postgresql-16 postgresql-client-16 patroni etcd-server etcd-client python3-psycopg2 jq zstd lz4

# Stop the default postgres instance (Patroni will manage it)
sudo systemctl stop postgresql
sudo systemctl disable postgresql
sudo rm -rf /var/lib/postgresql/16/main/*
```

---

### Step 2: the etcd3 quorum

#### On `pg-node-01` (`192.168.100.11`):
Edit `/etc/default/etcd`:
```bash
ETCD_NAME="etcd-01"
ETCD_DATA_DIR="/var/lib/etcd/default.etcd"
ETCD_LISTEN_PEER_URLS="http://192.168.100.11:2380"
ETCD_LISTEN_CLIENT_URLS="http://192.168.100.11:2379,http://127.0.0.1:2379"
ETCD_INITIAL_ADVERTISE_PEER_URLS="http://192.168.100.11:2380"
ETCD_INITIAL_CLUSTER="etcd-01=http://192.168.100.11:2380,etcd-02=http://192.168.100.12:2380,etcd-03=http://192.168.100.13:2380"
ETCD_INITIAL_CLUSTER_STATE="new"
ETCD_INITIAL_CLUSTER_TOKEN="etcd-patroni-cluster"
ETCD_ADVERTISE_CLIENT_URLS="http://192.168.100.11:2379"
```

#### On `pg-node-02` (`192.168.100.12`):
```bash
ETCD_NAME="etcd-02"
ETCD_DATA_DIR="/var/lib/etcd/default.etcd"
ETCD_LISTEN_PEER_URLS="http://192.168.100.12:2380"
ETCD_LISTEN_CLIENT_URLS="http://192.168.100.12:2379,http://127.0.0.1:2379"
ETCD_INITIAL_ADVERTISE_PEER_URLS="http://192.168.100.12:2380"
ETCD_INITIAL_CLUSTER="etcd-01=http://192.168.100.11:2380,etcd-02=http://192.168.100.12:2380,etcd-03=http://192.168.100.13:2380"
ETCD_INITIAL_CLUSTER_STATE="new"
ETCD_INITIAL_CLUSTER_TOKEN="etcd-patroni-cluster"
ETCD_ADVERTISE_CLIENT_URLS="http://192.168.100.12:2379"
```

#### On `pg-node-03` (`192.168.100.13`):
```bash
ETCD_NAME="etcd-03"
ETCD_DATA_DIR="/var/lib/etcd/default.etcd"
ETCD_LISTEN_PEER_URLS="http://192.168.100.13:2380"
ETCD_LISTEN_CLIENT_URLS="http://192.168.100.13:2379,http://127.0.0.1:2379"
ETCD_INITIAL_ADVERTISE_PEER_URLS="http://192.168.100.13:2380"
ETCD_INITIAL_CLUSTER="etcd-01=http://192.168.100.11:2380,etcd-02=http://192.168.100.12:2380,etcd-03=http://192.168.100.13:2380"
ETCD_INITIAL_CLUSTER_STATE="new"
ETCD_INITIAL_CLUSTER_TOKEN="etcd-patroni-cluster"
ETCD_ADVERTISE_CLIENT_URLS="http://192.168.100.13:2379"
```

Start etcd on all 3 nodes and check the quorum:
```bash
sudo systemctl restart etcd
sudo systemctl enable etcd
# Cluster health
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.100.11:2379,http://192.168.100.12:2379,http://192.168.100.13:2379 endpoint health
```

---

### Step 3: Patroni on every node

Create `/etc/patroni/patroni.yml` on each node (adapting `name` and the `192.168.100.X` addresses):

```yaml
scope: pg-cluster-prod
namespace: /service
name: pg-node-01  # pg-node-02 / pg-node-03 on the other nodes

etcd3:
  hosts:
    - 192.168.100.11:2379
    - 192.168.100.12:2379
    - 192.168.100.13:2379

restapi:
  listen: 0.0.0.0:8008
  connect_address: 192.168.100.11:8008

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    synchronous_mode: 'on'
    synchronous_mode_strict: false
    synchronous_node_count: 1
    postgresql:
      use_pg_rewind: true
      use_slots: true
      parameters:
        max_connections: 200
        shared_buffers: 4GB
        effective_cache_size: 12GB
        maintenance_work_mem: 1GB
        work_mem: 32MB
        wal_level: replica
        archive_mode: 'on'
        archive_command: '/usr/local/bin/pg-arca-wal archive %p %f'
        archive_timeout: 60
        hot_standby: 'on'
        hot_standby_feedback: 'on'
      pg_hba:
        - hostssl replication replicator 192.168.100.0/24 scram-sha-256
        - hostssl all all 192.168.100.0/24 scram-sha-256
        - local all postgres peer

  initdb:
    - encoding: UTF8
    - data-checksums

  pg_hba:
    - hostssl replication replicator 192.168.100.0/24 scram-sha-256
    - hostssl all all 192.168.100.0/24 scram-sha-256
    - local all postgres peer

  users:
    admin:
      password: StrongAdminPassword2026!
      options:
        - superuser
        - createdb

postgresql:
  listen: 0.0.0.0:5432
  connect_address: 192.168.100.11:5432
  data_dir: /var/lib/postgresql/16/main
  bin_dir: /usr/lib/postgresql/16/bin
  pgpass: /var/lib/postgresql/.pgpass
  authentication:
    replication:
      username: replicator
      password: StrongReplPassword2026!
    superuser:
      username: postgres
      password: StrongPostgresPassword2026!

tags:
  nofailover: false
  noloadbalance: false
  clonefrom: false
  nosync: false
```

Set the permissions and start the cluster:
```bash
sudo chown postgres:postgres /etc/patroni/patroni.yml
sudo chmod 0600 /etc/patroni/patroni.yml

# Start Patroni (node 1 first, then node 2 and node 3)
sudo systemctl enable --now patroni
```

Check the topology on any node with `patronictl`:
```bash
sudo patronictl -c /etc/patroni/patroni.yml topology pg-cluster-prod
sudo patronictl -c /etc/patroni/patroni.yml list
```

---

## Related documents
- [INSTALL.md](./INSTALL.md): installation, upgrades, backup of the console, operations.
- [RELEASE.md](./RELEASE.md): release artifacts, versioning, release gate, release notes.
- [HANDOFF.md](./HANDOFF.md): work status and how to pick it up (internal, Italian).
- [PROJECT_TRACKER.md](./PROJECT_TRACKER.md): register of components, tests and decisions (internal, Italian).
- [COMPAT.md](./COMPAT.md): PostgreSQL / OS compatibility.
