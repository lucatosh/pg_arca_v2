#!/usr/bin/env bash
# Runs INSIDE a fresh container (pushed there by release-test.sh): installs, upgrades, breaks, rolls back and removes the packaged console,
# then installs the agent package as a worker host registered with that console, upgrades it through the package manager and removes it.
#   release-test-ct.sh <release dir>        (the dir holds pg-arca-console-*.tar.gz, pg-arca-agent* packages)
# Every check prints "PASS <what>" or "FAIL <what>"; the exit code is the number of failures.
set -uo pipefail
R=${1:?release dir}; cd "$R"
FAILS=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
check() { local what=$1; shift; if "$@" >/tmp/check.out 2>&1; then pass "$what"; else fail "$what"; sed 's/^/     | /' /tmp/check.out | tail -15; fi; }
V=$(ls pg-arca-console-*-linux-x64.tar.gz | head -1 | sed -E 's/pg-arca-console-(.*)-linux-x64.tar.gz/\1/')
W=/root/reltest; rm -rf "$W"; mkdir -p "$W"; tar xzf "pg-arca-console-$V-linux-x64.tar.gz" -C "$W"
P1="$W/pg-arca-console-$V-linux-x64"
URL=https://127.0.0.1:8443
health() { curl -fsSk --max-time 3 "$URL/api/health"; }
ver() { health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
JAR=/tmp/jar
login() { rm -f $JAR; curl -fsSk -c $JAR -H 'content-type: application/json' -d '{"username":"reladmin","password":"release-test-pass-1"}' "$URL/api/auth/login" >/dev/null; }
api() { curl -fsSk -b $JAR -X "$1" -H 'content-type: application/json' ${3:+-d "$3"} "$URL$2"; }
# a package that claims another version (upgrade test) and one whose server dies at start (automatic rollback test)
mkpkg() {   # $1 = version, $2 = broken (1/0)
  local d="$W/pg-arca-console-$1-linux-x64"; rm -rf "$d"; cp -a "$P1" "$d"; echo "$1" > "$d/VERSION"
  [[ "$2" == 1 ]] && printf 'process.exit(3);\n' > "$d/server.mjs"
  echo "$d"
}

echo "== console $V: first install (self-signed TLS, port 8443)"
check "install exits 0" "$P1/install-console.sh" --tls-self-signed --port 8443
check "health answers with version $V" bash -c "[[ \$(curl -fsSk $URL/api/health | sed -n 's/.*\"version\":\"\\([^\"]*\\)\".*/\\1/p') == $V ]]"
check "service runs as pgarca-console" bash -c '[[ $(systemctl show -p User --value pg-arca-console) == pgarca-console ]]'
check "state dir is 0700 pgarca-console" bash -c '[[ $(stat -c %a:%U /var/lib/pg-arca-console) == 700:pgarca-console ]]'
check "settings file 0640 root:pgarca-console" bash -c '[[ $(stat -c %a:%U:%G /etc/pg-arca-console/console.env) == 640:root:pgarca-console ]]'
check "code not writable by the service user" bash -c '! runuser -u pgarca-console -- touch /opt/pg-arca-console/current/x 2>/dev/null'
check "web UI served" bash -c "curl -fsSk $URL/ | grep -q '<div id=\"root\"'"
check "agent bundle served" bash -c "curl -fsSk $URL/agent/pg-arca-agent.tar.gz | tar tzf - | grep -q pg_arca/__init__.py"
check "http refused on the TLS port" bash -c "! curl -fsS --max-time 3 http://127.0.0.1:8443/api/health"
command -v systemd-analyze >/dev/null && { echo "   systemd-analyze security: $(systemd-analyze security pg-arca-console 2>/dev/null | tail -1)"; }
SC=$(tr -d '[:space:]' < /var/lib/pg-arca-console/setup-code 2>/dev/null)
check "setup code written" test -n "$SC"
check "administrator created with the setup code" curl -fsSk -H 'content-type: application/json' -d "{\"username\":\"reladmin\",\"password\":\"release-test-pass-1\",\"setupCode\":\"$SC\"}" "$URL/api/auth/setup"
check "login" login
check "an enrollment token saved (state marker)" api POST /api/enrollment-tokens '{"label":"rel-marker","ttlMinutes":10080}'
check "TLS reload with SIGHUP" bash -c 'systemctl reload pg-arca-console && sleep 1 && journalctl -u pg-arca-console -n 5 --no-pager | grep -q "TLS certificate reloaded"'

V2="${V%%-*}-rc.99"; P2=$(mkpkg "$V2" 0)
echo "== upgrade $V -> $V2"
check "upgrade exits 0" "$P2/install-console.sh"
check "health answers $V2" bash -c "[[ \$(curl -fsSk $URL/api/health | sed -n 's/.*\"version\":\"\\([^\"]*\\)\".*/\\1/p') == $V2 ]]"
check "login still works" login
check "state kept (marker template)" bash -c "curl -fsSk -b $JAR $URL/api/enrollment-tokens | grep -q rel-marker"
check "pre-upgrade state backup" bash -c "ls /var/lib/pg-arca-console/backups/console-state-pre-upgrade-to-v$V2-*.tar.gz"
check "previous release recorded" bash -c "[[ \$(cat /opt/pg-arca-console/previous) == $V ]]"
check "settings kept (port 8443)" grep -q '^PORT=8443' /etc/pg-arca-console/console.env

V3="${V%%-*}-rc.100"; P3=$(mkpkg "$V3" 1)
echo "== broken release $V3: the installer must roll back by itself"
check "broken upgrade exits non-zero" bash -c "! $P3/install-console.sh"
check "back on $V2" bash -c "[[ \$(curl -fsSk $URL/api/health | sed -n 's/.*\"version\":\"\\([^\"]*\\)\".*/\\1/p') == $V2 ]]"
check "login after the automatic rollback" login
check "current points to $V2" bash -c "[[ \$(readlink /opt/pg-arca-console/current) == releases/$V2 ]]"

echo "== --rollback to $V"
check "rollback refused without --yes" bash -c "! /opt/pg-arca-console/current/install-console.sh --rollback"
check "rollback exits 0" /opt/pg-arca-console/current/install-console.sh --rollback --yes
check "health answers $V" bash -c "[[ \$(curl -fsSk $URL/api/health | sed -n 's/.*\"version\":\"\\([^\"]*\\)\".*/\\1/p') == $V ]]"
check "login after rollback" login
check "--status" /opt/pg-arca-console/current/install-console.sh --status

echo "== state backup, uninstall keeping state, reinstall"
check "--backup-state to /root/consolebk" /opt/pg-arca-console/current/install-console.sh --backup-state /root/consolebk
check "backup archive holds the state and the key" bash -c 'tar tzf /root/consolebk/console-state-*.tar.gz | grep -q secret.key'
check "uninstall exits 0" "$P1/install-console.sh" --uninstall
check "service gone" bash -c '! systemctl is-active --quiet pg-arca-console && [ ! -e /etc/systemd/system/pg-arca-console.service ]'
check "state kept after uninstall" test -d /var/lib/pg-arca-console
check "reinstall exits 0" "$P1/install-console.sh"
check "login with the kept state" login

echo "== --restore-state (disaster recovery of the console on a purged host)"
BK=$(ls /root/consolebk/console-state-*.tar.gz | head -1)
check "purge the console" "$P1/install-console.sh" --uninstall --purge --yes
check "fresh install" "$P1/install-console.sh" --tls-self-signed --port 8443
check "fresh console has no users (setup code again)" test -f /var/lib/pg-arca-console/setup-code
check "restore refused without --yes" bash -c "! /opt/pg-arca-console/current/install-console.sh --restore-state $BK"
check "restore refuses a file that is not a state backup" bash -c "! /opt/pg-arca-console/current/install-console.sh --restore-state $R/pg-arca-agent-$V.tar.gz --yes"
check "restore exits 0" /opt/pg-arca-console/current/install-console.sh --restore-state "$BK" --yes
check "health after restore" bash -c "[[ \$(curl -fsSk $URL/api/health | sed -n 's/.*\"version\":\"\\([^\"]*\\)\".*/\\1/p') == $V ]]"
check "login with the restored users" login
check "restored state holds the marker" bash -c "curl -fsSk -b $JAR $URL/api/enrollment-tokens | grep -q rel-marker"
check "previous state kept aside" bash -c 'ls /var/lib/pg-arca-console/backups/console-state-before-restore-*.tar.gz'

echo "== API tokens (automation)"
APITOK=$(api POST /api/api-tokens '{"label":"rel ci","role":"viewer","ttlDays":1}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
check "token created" test -n "$APITOK"
check "bearer token reads the API" bash -c "curl -fsSk -H 'Authorization: Bearer $APITOK' $URL/api/clusters >/dev/null"
check "viewer token cannot write" bash -c "[[ \$(curl -sk -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer $APITOK' -H 'content-type: application/json' -d '{\"label\":\"x\"}' $URL/api/enrollment-tokens) == 403 ]]"
check "unknown token is 401" bash -c "[[ \$(curl -sk -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer arca_api_nope' $URL/api/clusters) == 401 ]]"

echo "== agent package as a worker host of this console"
CA=/etc/pg-arca-console/tls/console.crt
TOK=$(api POST /api/enrollment-tokens '{"label":"release test","kind":"worker"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
check "enrollment token" test -n "$TOK"
if command -v apt-get >/dev/null; then PKGF=$(ls "$R"/pg-arca-agent_*_all.deb); INST=(apt-get install -y -q); REINST=(apt-get install -y -q --reinstall); RM=(apt-get remove -y -q pg-arca-agent)
else PKGF=$(ls "$R"/pg-arca-agent-*.noarch.rpm); INST=(dnf install -y -q); REINST=(dnf reinstall -y -q); RM=(dnf remove -y -q pg-arca-agent); fi
check "package installs" "${INST[@]}" "$PKGF"
check "bundle in /usr/share/pg-arca-agent" test -f /usr/share/pg-arca-agent/install-agent.sh
check "registration with the packaged installer" env PG_ARCA_URL=https://127.0.0.1:8443 PG_ARCA_TLS_CA=$CA PG_ARCA_ENROLL_TOKEN="$TOK" PG_ARCA_ROLE=worker PG_ARCA_NODE_NAME=reltest-worker /usr/share/pg-arca-agent/install-agent.sh
check "agent service active" systemctl is-active --quiet pg-arca-agent
sleep 8
check "worker listed in the console, online" bash -c "curl -fsSk -b $JAR $URL/api/workers | grep -q '\"name\":\"reltest-worker\"[^}]*\"online\":true'"
check "agent reports version $V" bash -c "curl -fsSk -b $JAR $URL/api/workers | grep -q '\"agentVersion\":\"$V\"'"
check "package reinstall upgrades the agent in service (restart seen)" bash -c "t0=\$(systemctl show -p ActiveEnterTimestampMonotonic --value pg-arca-agent); sleep 1; ${REINST[*]} $PKGF >/dev/null 2>&1; t1=\$(systemctl show -p ActiveEnterTimestampMonotonic --value pg-arca-agent); [[ \$t1 != \$t0 ]]"
check "package removal removes the agent" "${RM[@]}"
check "agent service gone" bash -c '! systemctl is-active --quiet pg-arca-agent && [ ! -e /etc/systemd/system/pg-arca-agent.service ]'
check "agent state kept" test -d /var/lib/pgarca

echo "== purge"
check "purge refused without --yes" bash -c "! $P1/install-console.sh --uninstall --purge"
check "purge exits 0" "$P1/install-console.sh" --uninstall --purge --yes
check "nothing left" bash -c '[ ! -e /var/lib/pg-arca-console ] && [ ! -e /etc/pg-arca-console ] && [ ! -e /opt/pg-arca-console ] && ! id pgarca-console'
echo "== $FAILS failure(s)"
exit $FAILS
