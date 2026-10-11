# pg_arca lab "versions" target: a PLAIN Debian 12 server with systemd as PID 1 — nothing of pg_arca and no PostgreSQL baked in.
# PostgreSQL (PGDG apt), Patroni and the pg_arca agent are installed afterwards exactly as an administrator would (prep.sh + the console's
# install command), so the onboarding is tested on something that behaves like a real VM (systemd units, apt layout, sudo).
FROM debian:bookworm
ENV container=docker DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus sudo curl ca-certificates gnupg lsb-release \
      procps iproute2 iputils-ping less vim-tiny netcat-openbsd python3 cron \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /lib/systemd/system/multi-user.target.wants/getty* /etc/systemd/system/getty.target.wants/* \
 && systemctl mask systemd-logind.service getty.target console-getty.service systemd-udevd.service 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
