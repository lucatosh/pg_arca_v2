#!/usr/bin/env bash
# Lab helper: what the console's "Genera comando di installazione" button does - a token for N servers - and prints the command the user would copy.
#   usage: token.sh <environment> <label> [servers]      (nothing is installed: run the printed command on each server yourself)
cd "$(dirname "$0")"
env=${1:-dev}; label=${2:-nodo}; n=${3:-1}
./api.sh POST /api/enrollment-tokens "{\"label\":\"$label\",\"environment\":\"$env\",\"ttlMinutes\":60,\"maxUses\":$n}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("installCommand") or d)'
