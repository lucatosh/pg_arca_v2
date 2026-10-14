#!/bin/bash
# The standby site's infrastructure node (Rocky 9): its own etcd (one DCS per site, as in real geo deployments) and an HAProxy :5000 that follows the
# site's leader (what the other site replicates from after a switchover). Run as root on hybx.   hybx.sh <node1 ip> <node2 ip>
set -euo pipefail
n1=$1 n2=$2; ip=$(hostname -I | awk '{print $1}'); V=v3.5.17
if [ ! -x /usr/local/bin/etcd ]; then
  curl -fsSL -o /tmp/etcd.tgz https://github.com/etcd-io/etcd/releases/download/$V/etcd-$V-linux-amd64.tar.gz
  tar xzf /tmp/etcd.tgz -C /tmp && install /tmp/etcd-$V-linux-amd64/etcd /tmp/etcd-$V-linux-amd64/etcdctl /usr/local/bin/
  useradd -r -d /var/lib/etcd -s /sbin/nologin etcd 2>/dev/null || true; install -d -o etcd -g etcd /var/lib/etcd
  cat > /etc/systemd/system/etcd.service <<U
[Unit]
Description=etcd (site DCS)
After=network-online.target
[Service]
User=etcd
ExecStart=/usr/local/bin/etcd --name hybx --data-dir /var/lib/etcd --listen-client-urls http://0.0.0.0:2379 --advertise-client-urls http://$ip:2379 --listen-peer-urls http://$ip:2380 --initial-advertise-peer-urls http://$ip:2380 --initial-cluster hybx=http://$ip:2380 --enable-v2=true
Restart=always
[Install]
WantedBy=multi-user.target
U
  systemctl daemon-reload; systemctl enable --now etcd
fi
rpm -q haproxy >/dev/null 2>&1 || dnf -y -q install haproxy >/dev/null
cat > /etc/haproxy/haproxy.cfg <<C
global
  maxconn 200
defaults
  mode tcp
  timeout connect 5s
  timeout client 30m
  timeout server 30m
  default-server inter 3s fall 3 rise 2 on-marked-down shutdown-sessions
listen leader
  bind *:5000
  option httpchk GET /leader
  http-check expect status 200
  server hyb1 $n1:5432 check port 8008
  server hyb2 $n2:5432 check port 8008
C
setsebool -P haproxy_connect_any 1 2>/dev/null || true
systemctl enable --now haproxy >/dev/null 2>&1; systemctl restart haproxy
/usr/local/bin/etcdctl --endpoints=http://127.0.0.1:2379 endpoint health; systemctl is-active haproxy
