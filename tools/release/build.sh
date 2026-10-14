#!/usr/bin/env bash
# Build the release artifacts of the version in VERSION:
#   pg-arca-console-<v>-linux-x64.tar.gz   console: bundled server (server.mjs), web UI (dist/), agent bundle it serves, Node.js runtime, installer, Dockerfile
#   pg-arca-agent-<v>.tar.gz               agent, offline install: tar xzf …; cd pg-arca-agent-<v>; sudo PG_ARCA_URL=… ./install-agent.sh
#   pg-arca-agent_<v>_all.deb              agent for Debian/Ubuntu (bundle in /usr/share/pg-arca-agent; upgrades the agent in service)
#   pg-arca-agent-<v>-1.noarch.rpm         agent for RHEL/Rocky/Alma (same)
#   SHA256SUMS, BUILDINFO
#
#   tools/release/build.sh [--out DIR] [--no-node] [--no-rpm] [--skip-tests]
# Needs: the dependencies installed (npm ci), python3, tar, dpkg-deb; rpmbuild or docker for the .rpm; network to nodejs.org for the runtime
# (cached in ~/.cache/pg-arca-release; NODE_VERSION=… picks another runtime, default: the Node.js running this build).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
V="$(tr -d '[:space:]' < VERSION)"
OUT="$ROOT/out/release-$V"; WITH_NODE=1; WITH_RPM=1; TESTS=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$(mkdir -p "$2" && cd "$2" && pwd)"; shift ;;
    --no-node) WITH_NODE=0 ;;
    --no-rpm) WITH_RPM=0 ;;
    --skip-tests) TESTS=0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac; shift
done
log() { echo "== $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
[[ -x node_modules/.bin/vite && -x node_modules/.bin/esbuild && -x node_modules/.bin/tsc ]] || die "dependencies missing: run npm ci first"
DEB_V="${V/-/\~}"; RPM_V="${V/-/\~}"
COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"; DIRTY=""; [[ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]] || DIRTY="-dirty"
rm -rf "$OUT"; mkdir -p "$OUT"; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# --- 1. checks ---------------------------------------------------------------------------------------------------
log "version $V (commit $COMMIT$DIRTY)"
node_modules/.bin/tsx tests/server/version.test.ts >/dev/null || die "VERSION, package.json and the agent disagree: tools/release/set-version.sh $V"
if [[ $TESTS == 1 ]]; then
  log "tests"
  npm test >"$WORK/tests.log" 2>&1 || { tail -40 "$WORK/tests.log"; die "tests failed (full log: rerun npm test)"; }
fi

# --- 2. console ------------------------------------------------------------------------------------------------
log "web UI"
npm run build >"$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log"; die "npm run build failed"; }
CON="pg-arca-console-$V-linux-x64"; S="$WORK/$CON"; mkdir -p "$S"
log "server bundle"
# one ESM file with express/ws/pg inside; vite is only used in development, the optional native addons of pg/ws are not needed
node_modules/.bin/esbuild server.ts --bundle --platform=node --target=node20 --format=esm --outfile="$S/server.mjs" \
  --external:vite --external:pg-native --external:bufferutil --external:utf-8-validate \
  --banner:js="import { createRequire as __pgArcaRequire } from 'module'; const require = __pgArcaRequire(import.meta.url);" \
  --legal-comments=external --log-level=warning
cp VERSION "$S/"; cp -a dist "$S/dist"
mkdir -p "$S/unix-agent"; tar cf - -C unix-agent --exclude=__pycache__ --exclude=tests --exclude='*.pyc' . | tar xf - -C "$S/unix-agent"
cp packaging/console/install-console.sh packaging/console/Dockerfile packaging/console/healthcheck.cjs "$S/"
[[ -f LICENSE ]] && cp LICENSE "$S/"
if [[ $WITH_NODE == 1 ]]; then
  NV="${NODE_VERSION:-$(node -p process.versions.node)}"; C="$HOME/.cache/pg-arca-release"; mkdir -p "$C"
  NT="node-v$NV-linux-x64.tar.xz"
  log "Node.js runtime $NV"
  if [[ ! -f "$C/$NT" ]]; then curl -fsSL --retry 3 --connect-timeout 20 --speed-time 60 --speed-limit 1024 -o "$C/$NT.part" "https://nodejs.org/dist/v$NV/$NT" || die "cannot download the Node.js runtime (or --no-node)"; mv "$C/$NT.part" "$C/$NT"; fi
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 120 -o "$C/SHASUMS256-$NV.txt" "https://nodejs.org/dist/v$NV/SHASUMS256.txt"
  (cd "$C" && grep " $NT\$" "SHASUMS256-$NV.txt" | sha256sum -c - >/dev/null) || { rm -f "$C/$NT"; die "Node.js runtime checksum mismatch"; }
  tar xJf "$C/$NT" -C "$WORK"
  mkdir -p "$S/node/bin"; cp "$WORK/node-v$NV-linux-x64/bin/node" "$S/node/bin/"; cp "$WORK/node-v$NV-linux-x64/LICENSE" "$S/node/LICENSE"
fi
cat > "$S/README.txt" <<TXT
pg_arca console $V

Install or upgrade (Linux x86_64 with systemd, as root):   ./install-console.sh          (--help for TLS, port, rollback, uninstall)
Container image:                                            docker build -t pg-arca-console:$V .   (see the Dockerfile)
Agents: installed from the console (Clusters > Connect cluster), or offline with the pg-arca-agent packages of the same release.
TXT

log "smoke test of the packaged console"
NB="$S/node/bin/node"; [[ -x "$NB" ]] || NB="$(command -v node)"
PORT_T=$(( 20000 + RANDOM % 20000 )); D="$WORK/data"; mkdir -p "$D"
( cd "$D" && NODE_ENV=production PG_ARCA_DATA_DIR="$D" PORT=$PORT_T PG_ARCA_LISTEN=127.0.0.1 exec "$NB" "$S/server.mjs" ) >"$WORK/smoke.log" 2>&1 &
SP=$!; ok=0
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT_T/api/health" 2>/dev/null | grep -q "\"version\":\"$V\"" && { ok=1; break; }; sleep 0.5; done
if [[ $ok == 1 ]]; then
  curl -fsS "http://127.0.0.1:$PORT_T/" | grep -qi '<div id="root"' || ok=0
  curl -fsS "http://127.0.0.1:$PORT_T/agent/pg-arca-agent.tar.gz" | tar tzf - | grep -q 'pg_arca/__init__.py' || ok=0
  curl -fsS "http://127.0.0.1:$PORT_T/agent/install.sh" | head -1 | grep -q bash || ok=0
fi
kill "$SP" 2>/dev/null; wait "$SP" 2>/dev/null || true
[[ $ok == 1 ]] || { cat "$WORK/smoke.log"; die "the packaged console does not start or does not serve the UI/agent"; }
tar czf "$OUT/$CON.tar.gz" --owner=0 --group=0 -C "$WORK" "$CON"

# --- 3. agent --------------------------------------------------------------------------------------------------
AG="pg-arca-agent-$V"; A="$WORK/$AG"; mkdir -p "$A"
tar cf - -C unix-agent --exclude=__pycache__ --exclude=tests --exclude='*.pyc' . | tar xf - -C "$A"
cp VERSION "$A/"
tar czf "$OUT/$AG.tar.gz" --owner=0 --group=0 -C "$WORK" "$AG"
# the agent packages carry exactly the code the console of this release serves (same fingerprint: no "outdated agent" after installing them)
FP_CON="$(cd "$S/unix-agent" && python3 -B -c 'import sys; sys.path.insert(0, "."); from pg_arca.build import fingerprint; print(fingerprint("."))' 2>/dev/null || echo ?)"
FP_AG="$(cd "$A" && python3 -B -c 'import sys; sys.path.insert(0, "."); from pg_arca.build import fingerprint; print(fingerprint("."))' 2>/dev/null || echo ?)"
[[ "$FP_CON" == "$FP_AG" ]] || die "agent fingerprint differs between console ($FP_CON) and agent package ($FP_AG)"

log "agent .deb"
command -v dpkg-deb >/dev/null || die "dpkg-deb missing"
P="$WORK/deb"; mkdir -p "$P/DEBIAN" "$P/usr/share/pg-arca-agent" "$P/usr/share/doc/pg-arca-agent"
cp -a "$A/." "$P/usr/share/pg-arca-agent/"
cat > "$P/DEBIAN/control" <<CTL
Package: pg-arca-agent
Version: $DEB_V
Architecture: all
Maintainer: pg_arca release <release@pg-arca.invalid>
Section: database
Priority: optional
Depends: python3 (>= 3.6), bash, tar, procps
Recommends: python3-zstandard, zstd, polkitd | policykit-1
Description: pg_arca agent for PostgreSQL servers
 Backup, WAL archiving, point-in-time and object restore, telemetry for the pg_arca console.
 The package carries the agent; register the server with
 PG_ARCA_URL=https://<console> /usr/share/pg-arca-agent/install-agent.sh
CTL
cp packaging/agent/postinst.sh "$P/DEBIAN/postinst"; cp packaging/agent/prerm.sh "$P/DEBIAN/prerm"; chmod 0755 "$P/DEBIAN/postinst" "$P/DEBIAN/prerm"
printf 'pg_arca agent %s (commit %s)\n' "$V" "$COMMIT" > "$P/usr/share/doc/pg-arca-agent/README"
find "$P" -type d -exec chmod 0755 {} +
dpkg-deb --root-owner-group -Zxz --build "$P" "$OUT/pg-arca-agent_${DEB_V}_all.deb" >/dev/null

if [[ $WITH_RPM == 1 ]]; then
  log "agent .rpm"
  R="$WORK/rpm"; mkdir -p "$R/SOURCES" "$R/SPECS"
  cp "$OUT/$AG.tar.gz" "$R/SOURCES/"; cp packaging/agent/postinst.sh packaging/agent/prerm.sh "$R/SOURCES/"
  cat > "$R/SPECS/pg-arca-agent.spec" <<SPEC
Name:           pg-arca-agent
Version:        $RPM_V
Release:        1
Summary:        pg_arca agent for PostgreSQL servers
License:        Proprietary
BuildArch:      noarch
Source0:        $AG.tar.gz
Requires:       python3 >= 3.6, bash, tar, procps-ng
Recommends:     python3-zstandard, zstd, polkit
%global debug_package %{nil}
%global __brp_mangle_shebangs %{nil}
%global __requires_exclude_from ^/usr/share/pg-arca-agent/.*$

%description
Backup, WAL archiving, point-in-time and object restore, telemetry for the pg_arca console.
Register the server with: PG_ARCA_URL=https://<console> /usr/share/pg-arca-agent/install-agent.sh

%prep
%setup -q -n $AG

%install
mkdir -p %{buildroot}/usr/share/pg-arca-agent
cp -a . %{buildroot}/usr/share/pg-arca-agent/

%files
/usr/share/pg-arca-agent

%post
SPEC
  cat packaging/agent/postinst.sh | sed '1d' >> "$R/SPECS/pg-arca-agent.spec"
  printf '\n%%preun\n[ "$1" = 0 ] || exit 0\n' >> "$R/SPECS/pg-arca-agent.spec"
  sed '1d' packaging/agent/prerm.sh | sed 's/^\[ "\$1" = remove \] || exit 0$//' >> "$R/SPECS/pg-arca-agent.spec"
  RPMF="pg-arca-agent-$RPM_V-1.noarch.rpm"
  if command -v rpmbuild >/dev/null; then
    rpmbuild --define "_topdir $R" -bb "$R/SPECS/pg-arca-agent.spec" >"$WORK/rpm.log" 2>&1 || { tail -30 "$WORK/rpm.log"; die "rpmbuild failed"; }
  elif command -v docker >/dev/null; then
    docker run --rm -v "$R:/rpm" "${RPM_BUILD_IMAGE:-rockylinux:9}" bash -c 'dnf -y -q install rpm-build >/dev/null 2>&1 && rpmbuild --define "_topdir /rpm" -bb /rpm/SPECS/pg-arca-agent.spec && chown -R '"$(id -u):$(id -g)"' /rpm' >"$WORK/rpm.log" 2>&1 \
      || { tail -30 "$WORK/rpm.log"; die "rpmbuild in a container failed"; }
  else die "neither rpmbuild nor docker: install rpm-build, or --no-rpm"; fi
  cp "$R/RPMS/noarch/"*.rpm "$OUT/$RPMF"
fi

# --- 4. checksums and build record ---------------------------------------------------------------------------
cat > "$OUT/BUILDINFO" <<INFO
version=$V
commit=$COMMIT$DIRTY
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node_runtime=$([[ $WITH_NODE == 1 ]] && echo "$NV" || echo none)
agent_fingerprint=$FP_AG
tests=$([[ $TESTS == 1 ]] && echo passed || echo skipped)
INFO
(cd "$OUT" && sha256sum -- *.tar.gz *.deb $(ls *.rpm 2>/dev/null) BUILDINFO > SHA256SUMS)
log "artifacts in $OUT"; (cd "$OUT" && ls -l)
[[ -z "$DIRTY" ]] || echo "WARNING: built from a working tree with uncommitted changes: not a release build"
