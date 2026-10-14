#!/usr/bin/env bash
# Lab, on the Proxmox host (root): test the release packages on FRESH containers of each target distribution.
# Creates one container per distribution (ids from CTID0, default 460), pushes the release directory, runs release-test-ct.sh inside
# (install, upgrade, broken upgrade with automatic rollback, --rollback, state backup, uninstall/reinstall, agent .deb/.rpm as a worker
# host of that console, purge), prints the result, and destroys the container (KEEP=1 keeps it for analysis).
#   ./release-test.sh <release dir> [deb12 rocky9 ubu24]
# From the lab VM: tools/lab/release-test.sh copies the release there and runs this.
set -uo pipefail
R=${1:?release dir}; shift
TARGETS=${*:-deb12 rocky9 ubu24}
STORAGE=${STORAGE:-local-lvm}; TSTORE=${TSTORE:-local}; BRIDGE=${BRIDGE:-vmbr0}; CTID0=${CTID0:-460}
HERE="$(cd "$(dirname "$0")" && pwd)"
die() { echo "ERROR: $*" >&2; exit 1; }
template() {
  local prefix=$1 f
  f=$(pveam list "$TSTORE" 2>/dev/null | awk '{print $1}' | grep "/${prefix}_" | sort | tail -1 || true)
  if [ -z "$f" ]; then
    pveam update >/dev/null
    local t; t=$(pveam available --section system | awk '{print $2}' | grep "^${prefix}_" | sort | tail -1)
    [ -n "$t" ] || die "no template ${prefix}_*"
    pveam download "$TSTORE" "$t" >&2; f="$TSTORE:vztmpl/$t"
  fi
  echo "$f"
}
total=0
i=0
for t in $TARGETS; do
  case $t in
    deb12) tp=debian-12-standard; prep='apt-get update -qq && apt-get install -y -qq curl openssl python3 procps >/dev/null' ;;
    ubu24) tp=ubuntu-24.04-standard; prep='apt-get update -qq && apt-get install -y -qq curl openssl python3 procps >/dev/null' ;;
    rocky9) tp=rockylinux-9-default; prep='dnf install -y -q curl openssl python3 tar procps-ng systemd >/dev/null' ;;
    *) die "unknown target $t (deb12 rocky9 ubu24)" ;;
  esac
  id=$((CTID0 + i)); i=$((i + 1)); name="rel-$t"
  echo "=================== $name ($id): $tp"
  pct status "$id" >/dev/null 2>&1 && { pct stop "$id" >/dev/null 2>&1; pct destroy "$id" --purge >/dev/null 2>&1; }
  pct create "$id" "$(template $tp)" --hostname "$name" --memory 2048 --swap 512 --cores 2 --rootfs "$STORAGE:8" \
    --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" --unprivileged 1 --features nesting=1 --onboot 0 --description "pg_arca release test (temporary)" >/dev/null || die "pct create failed"
  pct start "$id"
  for _ in $(seq 60); do pct exec "$id" -- sh -c 'hostname -I 2>/dev/null | grep -q .' 2>/dev/null && break; sleep 2; done
  sleep 3
  pct exec "$id" -- bash -c "$prep" || echo "WARN: preparing $name failed"
  pct exec "$id" -- mkdir -p /root/release
  for f in "$R"/*; do [ -f "$f" ] && pct push "$id" "$f" "/root/release/$(basename "$f")"; done
  pct push "$id" "$HERE/release-test-ct.sh" /root/release-test-ct.sh --perms 0755
  pct exec "$id" -- bash /root/release-test-ct.sh /root/release 2>&1 | tee "/root/release-test-$t.log"
  rc=${PIPESTATUS[0]}; total=$((total + rc))
  echo "=================== $name: $rc failure(s) (log /root/release-test-$t.log)"
  if [ "${KEEP:-0}" != 1 ]; then pct stop "$id" >/dev/null 2>&1; pct destroy "$id" --purge >/dev/null 2>&1; fi
done
echo "TOTAL failures: $total"
exit $total
