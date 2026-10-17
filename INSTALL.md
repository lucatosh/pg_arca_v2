# Installation and administration

This guide covers the packaged releases (see [RELEASE.md](RELEASE.md)). For development from the repository, see the Quick start in [README.md](README.md).

## 1. What runs where

```
Browser ──HTTPS──> Console host ──(optional, "direct" clusters)──> PostgreSQL :5432
                      ^
                      └──HTTPS, outbound from each node── Agent on every PostgreSQL server and worker host
```

| Component | Where | Network |
|---|---|---|
| Console | one Linux x86_64 host with systemd (or a container) | listens on one port (default 3000); agents and browsers connect to it |
| Agent | every PostgreSQL server (same host as the data directory), and every worker host (backup server, recovery host) | outbound only, to the console's port; no inbound port |

Firewall: open the console port from the administrators' networks and from every node. Nothing has to be opened towards the nodes, except the PostgreSQL port for clusters connected without an agent ("direct").

## 2. Requirements

**Console host**: Linux x86_64 with systemd (RHEL/Rocky/Alma 8-10, Debian 11-13, Ubuntu 20.04-24.04 have been the targets; the lab runs Debian 12), 2 CPU, 2 GB RAM, 10 GB for the state (operation history and results grow with use). The release package carries its own Node.js runtime; `tar` and, for `--tls-self-signed`, `openssl`.

**Database servers**: Linux with PostgreSQL 14-18 (see [COMPAT.md](COMPAT.md) for what is verified), Python 3.6 or newer, `bash`, systemd (without it the agent runs, but you start it yourself and it does not survive a reboot). Recommended: `python3-zstandard` and `zstd` (backups are 5-10x slower without them). Disk for the repository and the WAL archive, local or on a mounted network share (an existing directory is used as it is: it must be writable by the agent's user, the installer does not chown it).

Platforms: the installer targets RHEL/Rocky/Alma 8-10, Debian 11-13 and Ubuntu 20.04-24.04 (apt/dnf/yum). The agent's own tests also run on Alpine (musl, busybox) and Rocky 8/9 (see COMPAT.md), but the installer has no apk/zypper/OpenRC support: on Alpine and SLES install the dependencies yourself, and on Alpine start the agent with your own service (OpenRC) using the command the installer prints.

Restart of a standalone PostgreSQL from the console (after enabling archiving, a restart-only parameter, the START of the unit at the end of a whole-server restore in place): the agent may restart/start only the `postgresql*` units. With polkit 0.106 or later through a polkit rule (the installer adds polkit when missing); with an older polkit (Debian ≤ 11, Ubuntu ≤ 22.04, which ignore JavaScript rules) or none, through the `pg-arca-pgctl` bridge: a root oneshot started by a path unit, accepting only `restart`/`start` of PostgreSQL units known to systemd, from the agent users listed in `/etc/pg-arca-pgctl.users`. `PG_ARCA_ALLOW_PG_RESTART=0` disables both.

## 3. Install the console

```bash
tar xzf pg-arca-console-1.0.0-rc.1-linux-x64.tar.gz
cd pg-arca-console-1.0.0-rc.1-linux-x64
sha256sum -c ../SHA256SUMS --ignore-missing      # from the release directory
sudo ./install-console.sh --tls-cert /path/console.crt --tls-key /path/console.key --port 8443
```

The installer creates the system user `pgarca-console`, puts the release in `/opt/pg-arca-console/releases/<version>` (`current` points to it), writes the settings to `/etc/pg-arca-console/console.env`, keeps the state in `/var/lib/pg-arca-console` and starts the hardened `pg-arca-console` systemd service. At the end it prints the address and the **setup code**: open the address and create the administrator account with it (the code is also in `/var/lib/pg-arca-console/setup-code` and in `journalctl -u pg-arca-console` until the account exists).

TLS choices:
- your certificate: `--tls-cert`/`--tls-key` (PEM; copied to `/etc/pg-arca-console/tls/`). Renewal: replace the two files there, then `systemctl reload pg-arca-console`.
- trial: `--tls-self-signed` (agents then need `PG_ARCA_TLS_CA=<copy of console.crt>`). Re-running the installer keeps that certificate (the agents pinned it); `--tls-regenerate` makes a new one, after which every agent needs the new file.
- a reverse proxy that terminates TLS: install without TLS, listen on loopback (`--listen 127.0.0.1`), and set `PG_ARCA_TRUST_PROXY=1` and `PG_ARCA_COOKIE_SECURE=1` in `console.env`. The proxy must pass websockets on `/ws/logs`.

Plain http is accepted, and the installer says so: use it only on a lab network.

### Settings (`/etc/pg-arca-console/console.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | listening port (below 1024 the unit gets `CAP_NET_BIND_SERVICE`) |
| `PG_ARCA_LISTEN` | 0.0.0.0 | listening address |
| `PG_ARCA_TLS_CERT`, `PG_ARCA_TLS_KEY` | — | native TLS (both or neither) |
| `PG_ARCA_TRUST_PROXY` | — | behind a reverse proxy: number of hops or a subnet, so the audit and the login back-off see the real client address |
| `PG_ARCA_COOKIE_SECURE` | — | `1`: session cookie only over https (set it behind a TLS proxy) |
| `PG_ARCA_ALLOWED_ORIGINS` | — | other browser origins allowed on the live-log websocket |
| `PG_ARCA_SECRET_KEY` | generated in the state directory | key that encrypts stored credentials (direct clusters, notification channels) |
| `PG_ARCA_ADMIN_USER`, `PG_ARCA_ADMIN_PASSWORD` | — | create the administrator without the setup code (automation; 12 characters minimum) |
| `PG_ARCA_METRICS_TOKEN` | — (metrics off) | enables `GET /metrics` (Prometheus text format) for scrapers sending `Authorization: Bearer <token>`: cluster status, findings, backup age, archiver failures, WAL gaps/conflicts, replication lag, nodes and workers online, operations of the last 24 h |

After a change: `systemctl restart pg-arca-console`. The installer never overwrites this file; options given to a later run (`--port`, `--listen`, `--tls-cert`) change only their own line.

### Container

```bash
cd pg-arca-console-1.0.0-rc.1-linux-x64
docker build -t pg-arca-console:1.0.0-rc.1 .
docker run -d --name pg-arca-console -p 3000:3000 -v pg-arca-console:/var/lib/pg-arca-console pg-arca-console:1.0.0-rc.1
docker logs pg-arca-console          # setup code on first start
```

The image runs as an unprivileged user (uid 10001), keeps the state in the volume and has a health check. Settings are the same environment variables.

## 4. Install the agents

**From the console** (recommended): Clusters → Connect cluster → With agent, copy the command and run it as root on the server. The server appears in the console; with a token it is registered at once, without one an administrator approves it ("New server detected").

**Offline** (no access to the console's download URL from the server, or an approved-software process):

```bash
tar xzf pg-arca-agent-1.0.0-rc.1.tar.gz && cd pg-arca-agent-1.0.0-rc.1
sudo PG_ARCA_URL=https://console.example:8443 PG_ARCA_ENROLL_TOKEN=<token> ./install-agent.sh
```

**Packages**: `apt install ./pg-arca-agent_1.0.0~rc.1_all.deb` or `dnf install ./pg-arca-agent-1.0.0~rc.1-1.noarch.rpm`, then register once:

```bash
sudo PG_ARCA_URL=https://console.example:8443 PG_ARCA_ENROLL_TOKEN=<token> /usr/share/pg-arca-agent/install-agent.sh
```

Later package upgrades (`apt upgrade`, `dnf upgrade`) upgrade the agent in service by themselves, keeping configuration and credentials. Removing the package removes every agent of the host but keeps backups and the WAL archives, and is **refused while a PostgreSQL instance archives WAL through pg_arca, or when the installer cannot tell** (switch archiving off first, otherwise every archive attempt would fail and pg_wal would fill the disk; `PG_ARCA_FORCE=1` overrides). The check reads the instance's own data directory: the running server through its own socket and port, or its configuration files when it is down.

Installer options (environment variables): `PG_ARCA_TLS_CA` (CA of the console certificate), `PG_ARCA_NODE_NAME`, `PG_ARCA_REPO`, `PG_ARCA_WAL`, `PG_ARCA_SCRATCH`, `PG_ARCA_USER` (OS user owning PostgreSQL, detected by default), `PG_ARCA_ROLE=worker` (worker host), `PG_ARCA_INSTANCE` + `PG_ARCA_PGDATA` (a second PostgreSQL instance on the same host: its own configuration `/etc/pg-arca/<name>`, state `/var/lib/pgarca/<name>`, service `pg-arca-agent-<name>`; it runs as the owner of that data directory unless `PG_ARCA_USER` says otherwise), `PG_ARCA_ALLOW_PG_RESTART=0`, `PG_ARCA_FORCE=1`. The full list is at the top of `install-agent.sh`.

**SELinux (enforcing, RHEL family)**: `archive_command` runs inside PostgreSQL's confined domain and writes into the WAL archive. The installer labels the WAL archive (and the asynchronous spool) as PostgreSQL data with `semanage fcontext` + `restorecon` (package `policycoreutils-python-utils`); on a network share that cannot carry labels use the mount option `context="system_u:object_r:postgresql_db_t:s0"`. Not verified yet on an enforcing host: if archiving fails with "Permission denied", check `ausearch -m avc -ts recent`.

After registration: enable WAL archiving from the cluster's Backup tab, take the first full backup, then assign a backup policy.

### Where the backups are stored

Every node of a cluster must write repository and WAL archive to the **same** storage: after a switchover or a failover the new primary continues the same history. Three choices, configured from the console (Backup page → Where the backups are stored → **Configure…**, or Storage & recovery → Backup storage), administrators only:

1. **A backup server**: install the agent on that machine as a worker host (`PG_ARCA_ROLE=worker`) and give it the *Backup server* role on its page. The wizard checks the folder on the server and prints the export and mount commands: the folder belongs to PostgreSQL's uid:gid on the database nodes (the same on every node), exported over NFS (`rw,sync,no_subtree_check`) and mounted at the same path on every node (`hard,noatime,_netdev` in `/etc/fstab`). The check on each node then proves the path is really mounted **from that server**, writable the way the engine writes (exclusive create, fsync, rename, hard links for the WAL archive) and with room, before anything is applied.
2. **An existing network share** (NAS, storage array; NFS or SMB with hard-link support) mounted at the same path on every node.
3. **The local disk of each node**: single-node clusters and test systems only.

pg_arca never mounts anything itself. Existing backups stay readable in the previous location after a change and can be migrated in the background. Directories, mount sources and server addresses are shown to administrators only, on request.

## 5. Upgrades

**Console**: extract the new release and run its `install-console.sh` (same command as the first install). The installer saves the state to `/var/lib/pg-arca-console/backups/`, switches the code, starts the service and waits for the new version to answer. If it does not, it puts back the previous release and the saved state by itself. Agents keep working during the upgrade (they retry), and the console then lists the agents of the older release as outdated, with the upgrade command.

**Rollback** after a successful upgrade: `sudo /opt/pg-arca-console/current/install-console.sh --rollback --yes`. It restores the state saved before the upgrade: changes made in the console since then (users, policies, operation history) are lost; backups on the servers are not affected.

**Agents**: the command shown by the console for outdated agents (it names the instance for a further instance's agent), the package manager, or the offline tarball's `install-agent.sh` again. One run upgrades the code shared by every agent of the host and restarts them all; it is **refused while an agent is running an operation** (a backup, a restore), so that nothing is cut off midway: run it again later, or `PG_ARCA_FORCE=1`. Upgrade the console first: a newer console works with older agents (it says what they lack), not the other way round.

## 6. Back up the console

The console protects its own state by itself: a compressed snapshot of the state (users, clusters, policies, schedules, history) is written to `/var/lib/pg-arca-console/snapshots/` one minute after every start and once a day, and the newest 14 are kept. `GET /api/health` reports the time of the newest one (`stateSnapshot`). The snapshot does not contain the secret key; a full copy to take off the host is the command below.

```bash
sudo /opt/pg-arca-console/current/install-console.sh --backup-state /srv/backup/pg-arca
```

The archive holds users, clusters, policies, schedules, history and the secret key (which decrypts stored credentials): protect it like the console. Schedule it daily (cron or a systemd timer). The database backups themselves are not in it: they live in the repositories on the nodes and worker hosts.

To restore, on the same host or a new one: install the same release (or a newer one), then

```bash
sudo /opt/pg-arca-console/current/install-console.sh --restore-state /srv/backup/pg-arca/console-state-v1.0.0-rc.1-20261015T060000Z.tar.gz --yes
```

It stops the service, keeps a copy of the current state in `/var/lib/pg-arca-console/backups/`, loads the archive, starts the service and waits for it to answer. The agents stay enrolled (same secret key); if the console changed address, set `web_server_url` in `/etc/pg-arca/agent.conf` on each node and restart `pg-arca-agent`.

## 7. Operations

| Task | Command |
|---|---|
| Status, versions, address | `sudo /opt/pg-arca-console/current/install-console.sh --status` |
| Logs | `journalctl -u pg-arca-console -f`; on a node `journalctl -u pg-arca-agent -f` |
| Health check for monitoring | `GET /api/health` → `{"ok":true,"version":"…"}` (no authentication) |
| Prometheus metrics | `GET /metrics` with `Authorization: Bearer $PG_ARCA_METRICS_TOKEN` (see settings); alert on `pg_arca_cluster_status >= 2`, `pg_arca_cluster_rpo_seconds < 0 or pg_arca_cluster_rpo_seconds > pg_arca_cluster_rpo_target_seconds` (the objective declared in the policy; use a constant such as `> 900` when none is declared), `time() - pg_arca_cluster_last_backup_timestamp_seconds > 86400`, `pg_arca_cluster_archiver_failed_total` increasing |
| WAL rate higher than the archive can take synchronously | Cluster → Status → Nodes → *Paths and discovery* → *Asynchronous WAL archiving* = on: `archive_command` parks each segment in `/var/lib/pgarca/state/walspool` and the agent pushes it in parallel. The console shows the spool depth and counts it in the recovery point; a segment still in the spool is lost if the host is lost. Leave off unless the *WAL archiving is … segments behind* finding appears. |
| Copy of the backups outside the building (S3, MinIO, Ceph) | Cluster → Status → Nodes → *Offsite copy*: endpoint, bucket, prefix, keys (stored on the node only, in the agent's settings file); *Test the bucket and save*; the agent mirrors packs, backup sets and WAL every minute and reports it in the heartbeat. After a loss of the backup storage: install/mount empty directories, set the same offsite settings, *Download what is missing here*. |
| Sign-in with the company directory | Users → *Directory sign-in (LDAP / Active Directory)*: server (`ldaps://` or `ldap://` + StartTLS; CA file for a private PKI), service account for the user search, base DN and filter (`(sAMAccountName={user})` on AD, `(uid={user})` on OpenLDAP) or a DN template, groups → roles; the *Test* button says what a given user would get. Local accounts keep working. |
| API access from scripts, CI, monitoring | Users → *API tokens*: create a token with a role and an expiry; send `Authorization: Bearer arca_api_…` on any `/api/...` call. The token is shown once; actions are audited as `token:<label>`; revoke it from the same page |
| Uninstall the console | `install-console.sh --uninstall` (keeps the state); `--uninstall --purge --yes` deletes it |
| Uninstall an agent | `sudo PG_ARCA_UNINSTALL=1 /usr/share/pg-arca-agent/install-agent.sh` (add `PG_ARCA_INSTANCE=<name>` for a further instance); removes only that agent's files, keeps its backups, WAL archive and encryption key unless `PG_ARCA_PURGE=1`; the shared code and the restart permission go with the last agent of the host |

## 8. Security notes

- The console unit runs as `pgarca-console` with `ProtectSystem=strict`, no capabilities (except to bind a port below 1024), private `/tmp`, no access to `/home`, writable only in its state directory.
- The agent runs as the PostgreSQL OS user, never as root; its unit forbids privilege escalation and keeps `/usr`, `/boot` and `/etc` read-only except the PostgreSQL configuration directories. The optional restart permission (polkit rule, or the `pg-arca-pgctl` bridge on older polkit) lets it start/restart only the PostgreSQL units; the agent never gets sudo or a setuid helper.
- Agents authenticate with a per-node credential obtained at enrollment (single-use tokens that expire in one hour, or administrator approval). Operations on nodes go through typed operations; destructive ones need a typed confirmation and are recorded in the audit log.
- Roles: administrator, operator, read-only. Every API route is checked against the role.
