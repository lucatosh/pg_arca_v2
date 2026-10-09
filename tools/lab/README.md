# pg_arca lab — Patroni 3 nodi in Docker

**Status: written but NEVER run** (the authoring sandbox has no Docker daemon). Expect small fixes on the first run; the scripts are static-checked only (`bash -n`, compose YAML parses).

Topology: 3×etcd, 3×(PostgreSQL 16 + Patroni + pg_arca agent), HAProxy (5000 primary / 5001 replicas / 7000 stats). The backup repo and WAL archive are shared volumes across the 3 nodes (lab convenience: any node can restore what another backed up). The agent is installed at container start with the real `install-agent.sh` (no systemd: `PG_ARCA_NO_SERVICE`), so every `up` also exercises the installer.

## Quick start (Ubuntu/Debian/RHEL-family, one command)
```bash
sudo apt-get update && sudo apt-get install -y git && sudo git clone https://github.com/lucatosh/pg_arca_v2.git /opt/pg_arca_v2 && sudo GIT_NAME="Luca" GIT_EMAIL="mitrluca3@gmail.com" /opt/pg_arca_v2/tools/lab/setup-host.sh --all
```

## Step by step
```bash
git clone https://github.com/lucatosh/pg_arca_v2.git /opt/pg_arca_v2   # or let setup-host.sh do it
cd /opt/pg_arca_v2/tools/lab
sudo GIT_NAME="Luca" GIT_EMAIL="mitrluca3@gmail.com" [GH_TOKEN=ghp_...] ./setup-host.sh   # Docker+compose, git identity/auth, firewall, Node, clone
./lab.sh console      # web console on :3000 (create the admin in the browser)
./lab.sh up           # builds image, starts etcd/Patroni/HAProxy, waits for a leader
./lab.sh smoke        # leader, streaming replicas, replication, WAL archive, agents
```
Then in the console the 3 nodes appear as "Nuovo server rilevato" → approve (or put `ARCA_ENROLL_TOKEN` in `.env`).
Other commands: `status`, `shell [node]`, `psql`, `logs`, `agentlog`, `switchover <node>`, `failover`, `bench [scale]`, `down`, `reset`.

## Git
- With `GH_TOKEN`: stored in `~/.git-credentials` (0600), https remote. Without: an ed25519 deploy key is generated (`~/.ssh/pg_arca_lab`) — add the printed public key as a *deploy key with write access* in the repo settings.
- Identity, `pull.ff only`, `safe.directory` are set globally by `setup-host.sh` (idempotent). The repo is bind-mounted read-only at `/work` in the nodes (git is installed there, with the host `.gitconfig`; no private key is copied into containers — commit/push from the host).
- To refresh code: `git pull` on the host, then `./lab.sh down && ./lab.sh up` (data volumes are kept; `reset` wipes them).
