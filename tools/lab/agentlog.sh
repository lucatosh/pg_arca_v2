#!/bin/bash
# Lab helper: tail of the agent log on the given containers (default: the 3 lab nodes).   agentlog.sh [lines] [containers...]
L=${1:-12}; shift; for n in ${@:-pg1 pg2 pg3}; do echo "== $n"; docker exec "$n" tail -n "$L" /var/log/pgarca/agent.out; done
