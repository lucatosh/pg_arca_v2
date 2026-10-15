# Compatibility: what is guaranteed, what is still to verify

Principle: **no assumptions about the layout**. The agent reads what is running (processes, `SHOW data_directory`, Patroni REST), not what "should" be there.

| Environment | Status | Notes |
|---|---|---|
| VM / bare metal, RHEL family (PGDG `/usr/pgsql-NN`, `/var/lib/pgsql`) | Tested on the lab (Rocky) | discovery and binary lookup cover the PGDG layout |
| VM Debian/Ubuntu (`/usr/lib/postgresql/NN`, `/etc/postgresql`) | Tested on the lab (Debian, Ubuntu) | same |
| Custom layout (`/data/pg`, tablespaces elsewhere, several instances) | Expected | the running instance is the authority; overrides: `PG_ARCA_PGDATA`, `pg_port`, `pg_bin_dir`, `pg_user` |
| Docker containers (no systemd) | Partly tested (lab) | installer without a service (`PG_ARCA_NO_SERVICE`) |
| Patroni (etcd/consul/k8s DCS) | Partial | Docker+etcd lab; other DCS types not tested |
| Kubernetes with operators (CloudNativePG, Zalando, Crunchy, StackGres) | **Not supported** | the agent must live on the same host/pod as PGDATA (sidecar with a shared volume): this needs a dedicated design |
| Managed databases (RDS, Cloud SQL, Azure) | **Not supported** | no filesystem access: SQL-only features |

Known remaining assumptions (to remove or verify): the agent runs on the same host as PostgreSQL; local access (socket/peer) as the `pg_user` user; `archive_command` points to `pg-arca-wal`; systemd unit with `ProtectSystem=full`.

## PostgreSQL versions (detection + compatibility)
A single module knows the differences between versions: `unix-agent/pg_arca/pgcompat.py` (mirrored for the console in `server/pgcompat.ts`). It detects the version from the server (`server_version_num`), from `PG_VERSION` (even with the server stopped) or from a binary (`--version`), including vendor suffixes (Debian/Ubuntu, EDB, Percona) and pre-releases (`17beta1`, `18devel`).

| Tier | Versions | What the product does |
|---|---|---|
| unsupported | < 10 (9.6 and earlier) | backup/restore/telemetry **refuse** (`PGA-VER-001`) with an explanation; critical warning in the console |
| legacy | 10, 11 | handled (`pg_start_backup` backup API, `recovery.conf` instead of `recovery.signal`, no `restore_command` GUC), **not part of the test matrix**; warning |
| supported | 12 … 18 | normal path; `pg_start_backup` backup API up to 14, `pg_backup_start` from 15; replay pause state from 14 |
| newer | > 18 | the path of the newest known version is used (everything is gated with ">="), flagged as "to verify": run a test restore |

- **End of life (EOL)** is computed with the community rule (second Thursday of November, five years after the first release) and shown as a warning: 12 and 13 are EOL today, 14 becomes EOL on 2026-11-12.
- **"Verified"** only means: the full suite passed on that major version in a real run. `VERIFIED` list in `pgcompat.py`: today **16 only**. The full engine suite on a real server ran on PostgreSQL 16; the 10/11/14/15 differences are covered by unit tests of the module (generated SQL, recovery files), not by a server of that version. Versions are added only after `tools/lab/matrix.sh` reports PASS (never before).
- **Binaries**: the agent checks that `postgres`, `pg_waldump`, `pg_controldata`, `pg_ctl` have the server's major version (`PGA-VER-002` / `tool_major` warning: a `pg_waldump` of another major version cannot read the WAL) and that `psql`/`pg_basebackup` are not older. "Check PostgreSQL compatibility" operation (`compat_check`) in the node panel.
- **Restore**: a backup is recovered only with the SAME major version (`PGA-VER-002` with the remedy when the binaries are of another version); the backup's version is in the set metadata.
- **Product target: 14, 15, 16, 17, 18** (default matrix in `tools/lab/matrix.sh`, with the real suites: backup/PITR/objects, standby, failover, layout, archive, HBA, live under load, parameters, full disk, Patroni DCS). Differences found by the matrix and handled: the `postgres` database has OID 5 only from 15 (up to 14 the OID is assigned by initdb: a partial restore reads it from the backup catalog); the "invalid" mark of DROP DATABASE (from 15 and in the 2023 minors of 12-14) may fall into the WAL segment before the DROP; **PostgreSQL 18** enables checksums by default in initdb (then `wal_log_hints` is not needed: enabling archiving knows it) and VACUUM truncation writes a record with an xid (the WAL scan no longer reports "TRUNCATE … to N", which never means data loss); `CREATE DATABASE` with the FILE_COPY strategy (the only one up to 14) replays the copy of the template's files: a database created after the last backup from `template0` or from a user database used as a template is recovered (the template is extracted: a user template is found in the WAL `copy dir` records).
- Matrix results on 12/10 morning: 15, 16, 17 **PASS** (172 tests); 14 and 18 with failures already fixed (a test's timing; default checksums and forensics) → **to be rerun** with the new suites. `VERIFIED` in `pgcompat.py` stays unchanged until the matrix is green.

## Custom paths and variables (`Nodes` → "Paths and discovery")
- For every setting the agent shows the detected value, the configured value and the source (detected / agent.conf / set here / environment).
- Editable only by an administrator, only the listed settings (PGDATA, binaries, port, socket/host, user, repository, WAL archive, scratch directory, Patroni URL).
- The agent checks every value on the server before saving it (PGDATA must contain PG_VERSION and global/pg_control; write paths cannot be system directories; no `..`; URLs without credentials). All-or-nothing save to `agent.local.json` (0640, so that `pg-arca-wal` can read it when PostgreSQL runs as another user) plus `agent.secrets.json` (0600, owner only: the offsite access and secret keys never go into the group-readable file), applied at once.
- Precedence: defaults < agent.conf < agent.local.json < the service's environment variables.
- Tested: validation, saving, precedence, agent handlers (unit tests), console-side operations. **Not tested in the browser** with a real agent.
- Object restore v2, configurable recovery instance and backup destination: tested only on real PostgreSQL 16; installing the binaries of other major versions (`ephemeral_install`) uses apt/dnf and has never run on a real system.

## Layout independence (audit 11/10) — no assumed paths, roles or PATH
Every item below was an assumption found in the code; it is now detected or configurable. Tests: `unix-agent/tests/test_universal.py` (21, without PostgreSQL), `test_params_pg.py` (5, real PostgreSQL 16 with superuser `dba_root`), lab scenarios `scenario-solo.py` (PG15 with unusual PGDATA/conf/socket/tablespace), `scenario-params.py`, `scenario-hba-dcs.py`.

| Item | Before | Now |
|---|---|---|
| `psql` and client tools | always `psql` from the PATH (on RHEL `/usr/pgsql-N/bin` is not in the service's PATH: no telemetry) | `pgaccess.find_tool`: configured `pg_bin_dir` → directory of the RUNNING postmaster (`/proc/<pid>/exe`) → PATH → vendor directories (Debian, PGDG, `/opt/...`, EDB), highest version first. `pg_amcheck` is looked up next to the chosen `psql` |
| Connection role | `postgres`, fixed | empty `pg_user` = automatic: PGDATA owner → the agent's OS user → `postgres`, the first that really connects. A superuser whose name differs from the OS user (`initdb -U dba`): set `pg_user` |
| The instance's binaries directory | never detected (`bin_dir` read but never written) | written by discovery (postmaster executable, command line, or the vendor directory of the same major version) |
| `archive_command` | `/usr/local/bin/pg-arca-wal` even if missing | VERIFIED path (wal_bin, `PG_ARCA_WAL_BIN`, PATH, next to the package, `/usr/local/bin`); refused if missing; with a non-standard config/home it is prefixed with `env PG_ARCA_CONF=… PG_ARCA_HOME=…` |
| **Archiver and `agent.local.json`** | `pg-arca-wal` read only `agent.conf`: a WAL directory changed from the console (or by applying a destination) did NOT reach `archive_command` | reads `agent.conf` → `agent.local.json` → environment, like the agent |
| `pg-arca-wal` and where the package lives | `/opt/pg-arca`, fixed | `PG_ARCA_HOME`, or the script's directory (symlinks too), or `/opt/pg-arca` |
| Patroni REST API | always `http://127.0.0.1:port` | `restapi.listen` address (wildcard → loopback; specific IP → that one), `https` when a certificate is set, configuration from environment variables only (`PATRONI_RESTAPI_LISTEN`) or unreadable `patroni.yml` → the port the process listens on |
| CPU and RAM for tuning advice and pre-flight | `os.cpu_count()` and `/proc/meminfo` (in a container: the host's) | `sysres`: CPU affinity + cgroup quota (v1/v2), RAM limited by the cgroup |
| Parameters under Patroni | written to the DCS unchecked: a wrong name or an out-of-range value reaches ALL members | validated against the node's `pg_settings` (exists in that version, type, enum, unit, min/max) BEFORE the DCS is touched; `listen_addresses`/`port` refused (they come from Patroni's local configuration) |
| pg_hba in a non-writable directory | raw `OSError` | message with the remedy (permissions, `ReadWritePaths`); the lock-out probe user is the real role |
| Unix socket of the ephemeral instance | `<scratch>/<name>/.s` (beyond ~107 bytes PostgreSQL does not start) | short directory in `/run/user`, `/tmp` or `/var/tmp` when the path does not fit |
| Symbolic links in PGDATA | silently ignored (like `pg_basebackup`) | ignored like `pg_basebackup` but listed in the backup warning and in `meta.skipped_links` |
| Installer | OS user `postgres`, fixed; `pg_user` written to `agent.conf` | OS user detected from the running postmaster (`PG_ARCA_USER` forces it), no fixed `pg_user`; `PG_ARCA_WAL`, `PG_ARCA_SCRATCH` |

Known limits (not solved): `unix_socket_directories` with several entries uses the first existing one; 16/32 kB blocks in the tuning UI (units are assumed to be 8 kB); systemd services with `ProtectSystem=full` cannot write a `pg_hba.conf` under `/etc` outside the directories reopened by the installer; automatic binary installation does not cover SUSE.

## Parallelism — 15/10
- `process_max` (worker threads of the backup copy and the restore extraction): default = half the cores, between 2 and 8 (`default_process_max()`); set per node from the console (Status → Nodes → Paths and discovery) between 1 and 64. Every worker compresses on its own core: raise it on big servers with fast destinations, lower it when backups slow production down. Database restores dump with as many `pg_dump` workers as the `jobs` parameter (default 2).

## Repository format — 15/10
- Format 2 (every repository written by 1.0.0-rc.1 and later): chunks in pack files `cas/packs/<id>.pack` with an index `<id>.idx`; see `ARCHITETTURA-BACKUP-RESTORE.md` §7g. Format 1 (one file per chunk under `cas/aa/bb/`) is read, deduplicated against and garbage-collected by the same engine; a format-1 repository is marked `format: 2` in `repo.json` the first time this engine opens it and new chunks go to packs. There is no conversion step and nothing to run.
- One way: an agent older than format 2 does not read packs. Never point a development build older than 15/10 at a repository written by rc.1 (it reports `PGA-REPO-014 chunk missing`). Agents of the same release on every node is the supported setup; the console shows outdated agents.
- Memory: the chunk index costs 44 bytes per chunk in the agent while a backup, restore or verify runs (≈ 70 MB for a 100 GB database, ≈ 700 MB for 1 TB); it is cached on disk (`cas/packs/index.cache`) so that loading it does not re-read every pack index. Packs are limited to 256 MB (`PG_ARCA_PACK_MAX_MB`); the garbage collection rewrites a pack when at least 25 % of it is dead and never touches packs younger than 48 hours.
- Tests: `unix-agent/tests/test_packs.py`; the real-PostgreSQL suites (`test_engine_pg`, `test_engine_standby_pg`, `test_engine_failover_pg`, `test_backup_crash_pg`, `test_destination_migrate_pg`, …) run on format 2.

## Locks on shared storage — 15/10
Backups, expire/garbage collection and migrations coordinate through `flock` files in the repository (`stanza` lock per stanza, `cas/gc.lock` for the whole repository: backups and migrations shared, the collector exclusive). On NFS this needs working locks: **do not mount the repository with `nolock`** (NFSv4 or NFSv3 with lockd/statd). Without them two writers could run at once and a collector could delete a pack a backup is deduplicating against; the agent's destination check does not detect this yet.

## Worker hosts (backup server, recovery host) — 11/10
- Agent role `node_role`: `auto` (default: the console decides), `database`, `worker`. At installation `PG_ARCA_ROLE=worker`; without a `postgres` user the installer creates the system user `pgarca`.
- In `worker` mode the agent **does not look for PostgreSQL** (no instance discovery, no cluster created) and reports: PostgreSQL installations per version (system, pg_arca private, configured), real filesystems with their type (local, NFS, SMB, Ceph, …) and space, pg_arca directories (scratch, repository, WAL archive), CPU/RAM and privileges (root / passwordless sudo).
- A role set locally always wins over the console's. Tests: `unix-agent/tests/test_worker.py`, `tests/server/workers.test.ts`.

## Authentication to PostgreSQL without peer
The agent inherits its environment: when `pg_hba` forbids `peer` on the socket, a `~/.pgpass` (or `PGPASSFILE`) of the agent's user and, if needed, `PGSSLMODE` are used by psql/pg_dump/pg_restore. The same applies to delivery to the primary from the central node (`centralInto`): the password goes into the central node's `.pgpass`. Not verified on the lab.
