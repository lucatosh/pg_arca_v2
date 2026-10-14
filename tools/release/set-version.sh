#!/bin/bash
# Set the product version everywhere it lives: VERSION, package.json, the agent package.
#   tools/release/set-version.sh 1.0.0-rc.2
set -euo pipefail
v=${1:?usage: set-version.sh X.Y.Z[-rc.N]}
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha)\.[0-9]+)?$ ]] || { echo "not a release version: $v" >&2; exit 2; }
cd "$(dirname "$0")/../.."
printf '%s\n' "$v" > VERSION
sed -i -E "0,/\"version\": \"[^\"]+\"/s//\"version\": \"$v\"/" package.json
sed -i -E "s/^__version__ = \"[^\"]+\"/__version__ = \"$v\"/" unix-agent/pg_arca/__init__.py
grep -q "\"version\": \"$v\"" package.json && grep -q "__version__ = \"$v\"" unix-agent/pg_arca/__init__.py || { echo "version not applied everywhere" >&2; exit 1; }
echo "version $v"
