#!/usr/bin/env bash
# Lab helper: run a shell command inside a lab container, the command given in base64 (no quoting through Windows/PowerShell/ssh).
#   usage: in.sh <container> <base64 of the command> [tail lines]
c=$1; cmd=$(echo "$2" | base64 -d); n=${3:-60}
sg docker -c "docker exec $c bash -c $(printf '%q' "$cmd")" 2>&1 | tail -n "$n"
