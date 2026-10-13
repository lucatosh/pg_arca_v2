#!/bin/sh
# Quick static check of the console UI where @types/react is not installed (CI images, this lab): build the bundle and fail on the
# errors that do not depend on React's types - undefined names, redeclarations, syntax. With the full dev dependencies use `npx tsc --noEmit`.
set -e
cd "$(dirname "$0")/.."
ESB=${ESBUILD:-$(command -v esbuild || echo /opt/npm-tools/node_modules/.bin/esbuild)}
$ESB src/main.tsx --bundle --outfile=${1:-/tmp/pgarca-ui-check.js} --loader:.css=css --jsx=automatic --log-level=error
bad=$(npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "TS2304|TS2552|TS2448|TS2451|TS2300|TS1005|TS1128|TS2554" || true)
if [ -n "$bad" ]; then echo "$bad"; exit 1; fi
echo "ui check OK"
