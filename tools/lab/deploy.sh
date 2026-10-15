#!/bin/bash
# Lab helper: bring the VM to a branch of origin (default: the one checked out): pull, rebuild UI, restart console, update agents.
#   tools/lab/deploy.sh [branch]        e.g. tools/lab/deploy.sh release/1.0.0-rc.1
# Run from /opt/pg_arca_v2/tools/lab as a docker-group user (sudo w/o password).
set -e; cd "$(dirname "$0")/../.."
if [ -n "${1:-}" ]; then
  git fetch -q origin "$1"
  # an untracked package-lock.json left by an earlier `npm install` blocks the checkout of a branch that tracks it
  [ -f package-lock.json ] && [ -z "$(git ls-files package-lock.json)" ] && mv package-lock.json /tmp/package-lock.json.before-deploy
  git checkout -q -B "$1" "origin/$1" || { echo "CHECKOUT FAILED: not deployed"; exit 1; }
fi
git pull -q --ff-only; git log --oneline | head -1
if ! npm run build > /tmp/deploy-build.log 2>&1; then grep -E "error" /tmp/deploy-build.log | head -20; echo "BUILD FAILED: console not restarted"; exit 1; fi; grep -E "built" /tmp/deploy-build.log
sudo systemctl restart pg-arca-console
cd tools/lab; ./lab.sh agent-update 2>&1 | tail -1
[ -n "$(docker ps -q -f name=solo1)" ] && ./lab.sh solo-agent-update 2>&1 | tail -2 || true
[ -n "$(docker ps -q -f name=dc1-pg1)" ] && ./geo.sh agent-update 2>&1 | grep -E "^==|FAILED|ERROR" || true
[ -n "$(docker ps -q -f name=s14)" ] && ./vers.sh agent-update 2>&1 | grep -E "^==|OK|PROBLEM|ERROR" || true
./agents-update.sh 2>&1 | grep -E "^==|failed" || true
echo deployed
