# pg_arca lab "hy" (hybrid geo pair, primary site on Docker): a Rocky Linux 9 server with systemd as PID 1 and the PACKAGES a DBA installs (PostgreSQL 16
# from PGDG, Patroni rpm) - downloaded once for both nodes (the lab VM is on a slow link). Nothing is configured here and nothing of pg_arca is in the image:
# prep-rocky.sh configures Patroni like a DBA, the agent comes from the console's install command.
FROM rockylinux/rockylinux:9
ENV container=docker LANG=C.UTF-8
RUN dnf -y install systemd sudo procps-ng iproute iputils nfs-utils python3 less which hostname tar findutils \
 && dnf -y install https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm epel-release dnf-plugins-core \
 && dnf config-manager --set-enabled crb && dnf -qy module disable postgresql \
 && dnf -y install postgresql16-server postgresql16-contrib patroni patroni-etcd \
 && dnf clean all \
 && (cd /lib/systemd/system/sysinit.target.wants/ && for i in *; do [ "$i" = systemd-tmpfiles-setup.service ] || rm -f "$i"; done) \
 && rm -f /lib/systemd/system/local-fs.target.wants/* /lib/systemd/system/sockets.target.wants/*udev* /lib/systemd/system/sockets.target.wants/*initctl* \
 && systemctl mask systemd-logind.service getty.target console-getty.service systemd-udevd.service 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
