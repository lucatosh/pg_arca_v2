# pg_arca lab "hy" (hybrid geo pair, primary site on Docker): a PLAIN Rocky Linux 9 server with systemd as PID 1. Nothing of PostgreSQL, Patroni or
# pg_arca baked in: prep-rocky.sh does what a DBA does on a fresh RHEL-like server, the agent comes from the console's install command.
FROM rockylinux/rockylinux:9
ENV container=docker LANG=C.UTF-8
RUN dnf -y install systemd sudo procps-ng iproute iputils nfs-utils python3 less which hostname tar findutils \
 && dnf clean all \
 && (cd /lib/systemd/system/sysinit.target.wants/ && for i in *; do [ "$i" = systemd-tmpfiles-setup.service ] || rm -f "$i"; done) \
 && rm -f /lib/systemd/system/local-fs.target.wants/* /lib/systemd/system/sockets.target.wants/*udev* /lib/systemd/system/sockets.target.wants/*initctl* \
 && systemctl mask systemd-logind.service getty.target console-getty.service systemd-udevd.service 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
