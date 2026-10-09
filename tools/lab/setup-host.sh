#!/usr/bin/env bash
# One-shot, idempotent prep of a lab host (Ubuntu/Debian via apt, or RHEL-family via dnf): Docker + compose, git (identity + GitHub auth), Node, firewall, repo clone.
#   sudo GIT_NAME="Luca" GIT_EMAIL="you@x.it" [GH_TOKEN=ghp_...] bash setup-host.sh [--all]
#   --all  also: console as a systemd service on :3000, lab up, smoke test (everything in one go)
# Env: LAB_DIR=/opt/pg_arca_v2   REPO_URL=https://github.com/lucatosh/pg_arca_v2.git   BRANCH=main   LAB_USER=<non-root user that will run lab.sh (default: $SUDO_USER)>
#      GH_TOKEN  -> https auth stored in ~/.git-credentials (0600);  without it an ed25519 deploy key is generated and its public half printed.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 1; }
LAB_DIR=${LAB_DIR:-/opt/pg_arca_v2}; REPO_URL=${REPO_URL:-https://github.com/lucatosh/pg_arca_v2.git}; BRANCH=${BRANCH:-main}
LAB_USER=${LAB_USER:-${SUDO_USER:-root}}; LAB_HOME=$(getent passwd "$LAB_USER" | cut -d: -f6)
GIT_NAME=${GIT_NAME:?set GIT_NAME}; GIT_EMAIL=${GIT_EMAIL:?set GIT_EMAIL}
as_user() { if [[ $LAB_USER == root ]]; then "$@"; else sudo -u "$LAB_USER" -H "$@"; fi; }
log() { echo "== $*"; }

log "packages (apt/dnf output is shown; the first run can take several minutes on a VM)"
ALL=0; [[ ${1:-} == --all ]] && ALL=1
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update && apt-get install -y ca-certificates curl git jq tar openssh-client bc rsync gnupg
  if ! command -v docker >/dev/null; then
    . /etc/os-release
    install -m 0755 -d /etc/apt/keyrings
    if curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc 2>/dev/null; then
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
    fi
    if ! { apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; }; then
      echo "   Docker's repo has no packages for '$VERSION_CODENAME' (yet): falling back to Ubuntu's own docker.io"
      rm -f /etc/apt/sources.list.d/docker.list; apt-get update
      apt-get install -y docker.io docker-compose-v2 docker-buildx || apt-get install -y docker.io docker-compose-v2
    fi
  fi
  command -v node >/dev/null && [[ $(node -p 'process.versions.node.split(".")[0]') -ge 20 ]] || apt-get install -y nodejs npm
elif command -v dnf >/dev/null; then
  dnf install -y dnf-plugins-core git curl jq tar openssh-clients bc rsync
  if ! command -v docker >/dev/null; then
    dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  command -v node >/dev/null || dnf module install -y nodejs:20 2>/dev/null || echo "WARN: install Node >= 20 yourself"
else echo "neither apt-get nor dnf found"; exit 1; fi
systemctl enable --now docker
[[ $LAB_USER != root ]] && usermod -aG docker "$LAB_USER"
docker compose version >/dev/null || { echo "docker compose plugin missing"; exit 1; }
command -v node >/dev/null && echo "   node $(node -v)"

log "firewall (containers -> console on the host)"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 3000/tcp >/dev/null; ufw allow from 172.28.0.0/16 >/dev/null; fi
if systemctl is-active --quiet firewalld 2>/dev/null; then
  firewall-cmd --permanent --zone=trusted --add-source=172.28.0.0/16 >/dev/null
  firewall-cmd --permanent --add-port=3000/tcp >/dev/null    # console UI
  firewall-cmd --reload >/dev/null
fi

log "git identity + auth for $LAB_USER"
as_user git config --global user.name "$GIT_NAME"
as_user git config --global user.email "$GIT_EMAIL"
as_user git config --global init.defaultBranch main
as_user git config --global pull.ff only
as_user git config --global --add safe.directory "$LAB_DIR"
if [[ -n "${GH_TOKEN:-}" ]]; then
  as_user git config --global credential.helper store
  ( umask 077; printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" > "$LAB_HOME/.git-credentials" ); chown "$LAB_USER" "$LAB_HOME/.git-credentials"
  echo "   https token stored in $LAB_HOME/.git-credentials (0600)"
else
  KEY="$LAB_HOME/.ssh/pg_arca_lab"
  if [[ ! -f $KEY ]]; then
    as_user mkdir -p -m 700 "$LAB_HOME/.ssh"; as_user ssh-keygen -q -t ed25519 -N "" -C "pg_arca-lab@$(hostname)" -f "$KEY"
    as_user bash -c "printf 'Host github.com\n  IdentityFile $KEY\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n' >> '$LAB_HOME/.ssh/config'; chmod 600 '$LAB_HOME/.ssh/config'"
  fi
  REPO_URL=${REPO_URL/https:\/\/github.com\//git@github.com:}
  echo "   Add this public key as a DEPLOY KEY (write access) at https://github.com/lucatosh/pg_arca_v2/settings/keys :"; cat "$KEY.pub"
fi

log "repo -> $LAB_DIR ($BRANCH)"
if [[ -d $LAB_DIR/.git ]]; then
  as_user git -C "$LAB_DIR" pull --ff-only origin "$BRANCH" || echo "WARN: pull failed (auth? local changes?) - lab continues with the current checkout"
else
  install -d -o "$LAB_USER" "$LAB_DIR"
  as_user git clone --branch "$BRANCH" "$REPO_URL" "$LAB_DIR" || echo "WARN: clone failed (deploy key not added yet?). Re-run this script after adding it."
fi
[[ -f $LAB_HOME/.gitconfig ]] || as_user touch "$LAB_HOME/.gitconfig"   # bind-mounted into the nodes
if [[ $ALL == 1 ]]; then
  log "console (systemd) + lab up + smoke"
  ( cd "$LAB_DIR" && as_user npm install --no-audit --no-fund )
  cat > /etc/systemd/system/pg-arca-console.service <<UNIT
[Unit]
Description=pg_arca web console (lab)
After=network-online.target docker.service
[Service]
User=$LAB_USER
WorkingDirectory=$LAB_DIR
ExecStart=/usr/bin/env npm start
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload; systemctl enable --now pg-arca-console >/dev/null
  as_user sg docker -c "cd $LAB_DIR/tools/lab && ./lab.sh up && ./lab.sh smoke" || echo "lab up/smoke reported a problem: see output above, then: ./lab.sh logs pg1"
  IP=$(hostname -I | awk '{print $1}')
  echo; echo "Console: http://$IP:3000  (VirtualBox NAT: http://localhost:3000 with port forwarding 3000->3000). Create the admin, then approve the 3 announced nodes."
  exit 0
fi
echo; echo "Done. Log out/in once (docker group), then:  cd $LAB_DIR/tools/lab && ./lab.sh console && ./lab.sh up"
