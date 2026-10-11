#!/bin/bash
# Lab helper (VM, needs sudo): give the lab the space of a newly added disk.
# The root fs is a plain ext4 partition (no LVM), so it cannot span a second disk: the new disk is formatted and mounted on /srv/lab,
# and Docker's data-root (containers + volumes = all PostgreSQL data, repositories, WAL archives) moves there. /tmp scratch too.
#   sudo tools/lab/add-disk.sh /dev/sdb
set -euo pipefail
DEV=${1:?disk, e.g. /dev/sdb}; MNT=/srv/lab
[[ -b $DEV ]] || { echo "$DEV is not a block device"; exit 1; }
if ! blkid "$DEV" >/dev/null 2>&1; then echo "formatting $DEV"; mkfs.ext4 -q -L arcalab "$DEV"; fi
UUID=$(blkid -s UUID -o value "$DEV"); mkdir -p $MNT
grep -q "$UUID" /etc/fstab || echo "UUID=$UUID $MNT ext4 defaults,noatime 0 2" >> /etc/fstab
mountpoint -q $MNT || mount $MNT
CUR=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
if [[ $CUR != $MNT/docker ]]; then
  echo "moving docker data-root $CUR -> $MNT/docker (containers stop for the copy)"
  systemctl stop docker.socket docker
  rsync -aHAX --numeric-ids "$CUR/" $MNT/docker/
  python3 - "$MNT/docker" <<'PY'
import json, os, sys
p = '/etc/docker/daemon.json'; d = json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}
d['data-root'] = sys.argv[1]; json.dump(d, open(p, 'w'), indent=2)
PY
  systemctl start docker
  [[ $(docker info -f '{{.DockerRootDir}}') == $MNT/docker ]] && mv "$CUR" "$CUR.old" && echo "old data kept in $CUR.old (remove when the lab runs fine)"
fi
mkdir -p $MNT/tmp && chmod 1777 $MNT/tmp
df -h / $MNT
