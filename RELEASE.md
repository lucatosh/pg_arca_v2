# Releases

pg_arca ships as two products with one version number:

| Artifact | For | Contents |
|---|---|---|
| `pg-arca-console-<v>-linux-x64.tar.gz` | the console host | bundled server (`server.mjs`), web UI (`dist/`), the agent bundle the console serves, Node.js runtime, `install-console.sh`, `Dockerfile` |
| `pg-arca-agent-<v>.tar.gz` | database and worker hosts without access to the console's download URL | the agent; `./install-agent.sh` installs it offline |
| `pg-arca-agent_<v>_all.deb` / `pg-arca-agent-<v>-1.noarch.rpm` | fleets managed with apt/dnf repositories | the agent in `/usr/share/pg-arca-agent`; a package upgrade upgrades the agent in service |
| `SHA256SUMS`, `BUILDINFO` | everyone | checksums; version, commit, Node.js runtime, agent fingerprint, test result |

The console always serves the agent of its own release (`/agent/install.sh`, `/agent/pg-arca-agent.tar.gz`), and the agent packages contain the same code (the build checks the fingerprint). An agent of another release is shown as outdated in the console, with its upgrade command.

Installation and operations: [INSTALL.md](INSTALL.md).

## Versioning

- One version for console and agent, in the `VERSION` file. `tools/release/set-version.sh X.Y.Z[-rc.N]` writes it to `VERSION`, `package.json` and the agent; `tests/server/version.test.ts` fails if they disagree.
- Semantic versioning. Pre-releases: `-rc.N` (release candidate). In package managers the pre-release sorts before the final release (`1.0.0~rc.1` in deb/rpm).
- The console shows its version under the product name and in `/api/health`; agents report theirs to the console.

## Building a release

```
npm ci
tools/release/set-version.sh 1.0.0-rc.1       # if not set already; commit it
tools/release/build.sh                         # out/release-<v>/
```

The build stops on: a version mismatch, failing tests (`npm test`: server, UI logic and agent unit tests), a failing UI build, a packaged console that does not start or does not serve the UI and the agent (smoke test), a Node.js runtime with a wrong checksum, an agent package whose code differs from the one the console serves. A build from a working tree with uncommitted changes is marked `-dirty` in `BUILDINFO` and is not a release build.

## Release gate

A release candidate (`-rc.N`) is published when the build passes and the lab runs (`tools/lab/`) are green on the supported PostgreSQL versions that are already verified. The final release (GA) needs all of the following, each recorded in `HANDOFF.md` with the date and the evidence:

| Gate | State on 1.0.0-rc.1 |
|---|---|
| Version matrix 14, 15, 16, 17, 18 green with the full suites (`tools/lab/matrix.sh`), `VERIFIED` in `pgcompat.py` updated | 15, 16, 17 PASS; 14 and 18 to rerun after fixes |
| Real network storage as backup destination: NFS and SMB, including loss of the share during a backup | not done |
| Console install, upgrade from the previous release and rollback on clean VMs (RHEL family and Debian/Ubuntu) | to run on the lab |
| Agent upgrade through `.deb`/`.rpm` on a registered node, and removal refused while WAL archiving is active | to run on the lab |
| Security review: authentication and sessions, RBAC on every route, agent enrollment and tokens, command execution on nodes, TLS, systemd hardening, dependency audit | not done |
| Console state backup and restore procedure tested (`install-console.sh --backup-state`, restore on another host) | not done |
| Installation and administration guide reviewed by someone who did not write it | first version in INSTALL.md |
| No open defect classified as data loss or wrong restore | no open one known |

## Release candidates

### 1.0.0-rc.1

First packaged release. Changes since the development builds:
- One version for console and agent (`VERSION`); shown in the UI and in `/api/health`.
- Console: native TLS (`PG_ARCA_TLS_CERT`/`PG_ARCA_TLS_KEY`, reload with SIGHUP), listen address (`PG_ARCA_LISTEN`), paths resolved from the install directory instead of the working directory.
- Console installer for systemd hosts: system user, hardened unit, settings file kept across upgrades, state backup before every upgrade, automatic rollback when the new release does not start, `--rollback`, `--backup-state`, `--uninstall`.
- Container image recipe for the console.
- Agent packages: offline tarball, `.deb`, `.rpm`; the installer has a no-package mode for them (`PG_ARCA_NO_PKG=1`).
- The whole interface, server messages and agent messages in English (guard tests on all three).

Fixed during the rc.1 test round (15/10):
- Backups taken on a standby: the console asks the primary to switch its WAL segment when the backup reaches the WAL phase; an archive that receives nothing is diagnosed as not shared within a minute (`PGA-WAL-021`, with the remedy) instead of a blind two-minute timeout; the Backup page warns before starting when the cluster has no shared destination.
- Patroni member names: a node whose hostname differs from its Patroni member name was listed twice and switchover/failover/restart/reinit failed with "not a member of this cluster"; the agent now reports its member name and every Patroni action uses it.
- Access (HBA): new cluster access matrix, every node → every node, for the replication user and the superuser, with one click to add the missing explicit rules (through the DCS on Patroni, per node otherwise).
- Geo-redundancy: a site that comes back after a failover is fenced (demoted) at its first sign of life, before Patroni there can promote it; the dead WAL branch of a timeline two servers used can be retired from the Backup tab (nothing is deleted).
- Backup server with a folder: the directory check shows every problem with its remedy and, when it passes, the exact NFS export, mount line and destination to set.
- Dialogs no longer steal the cursor while typing (polling pages re-focused the first field; copy/paste lost its selection).
- Cluster header badge agrees with the health findings.
- Backup copy and restore extraction run with a sliding window over the worker threads instead of batches with a barrier.
- API tokens for automation (Users page: bearer tokens with their own role and expiry, revocable, every action audited as `token:<label>`).
- Prometheus metrics on `/metrics` (enabled by `PG_ARCA_METRICS_TOKEN`), daily snapshots of the console state, install command for a console with a private/self-signed certificate, backup policy option to prefer a standby, geo rejoin of a site that came back on a higher timeline.

Known limits: see the release gate above and [COMPAT.md](COMPAT.md).
