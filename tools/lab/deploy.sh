#!/bin/bash
# Lab helper: bring the VM to origin/main: pull, rebuild UI, restart console, update agents. Run from /opt/pg_arca_v2/tools/lab as a docker-group user (sudo w/o password).
set -e; cd "$(dirname "$0")/../.."
git pull -q --ff-only; git log --oneline | head -1
if ! npm run build > /tmp/deploy-build.log 2>&1; then grep -E "error" /tmp/deploy-build.log | head -20; echo "BUILD FAILED: console not restarted"; exit 1; fi; grep -E "built" /tmp/deploy-build.log
sudo systemctl restart pg-arca-console
cd tools/lab; ./lab.sh agent-update 2>&1 | tail -1
[ -n "$(docker ps -q -f name=solo1)" ] && ./lab.sh solo-agent-update 2>&1 | tail -2 || true
[ -n "$(docker ps -q -f name=dc1-pg1)" ] && ./geo.sh agent-update 2>&1 | grep -E "^==|FAILED|ERROR" || true
echo deployed
