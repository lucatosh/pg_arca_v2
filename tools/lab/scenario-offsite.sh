#!/usr/bin/env bash
# Lab scenario: offsite copy driven from the CONSOLE (as the Status -> Nodes -> Offsite copy card does) against a real S3 server with
# signature checking (SeaweedFS: MinIO is no longer freely downloadable). Configure + probe, backup, sync, check the bucket, rehydrate
# (nothing missing -> 0 downloads), clear the configuration.   usage: sg docker -c "tools/lab/scenario-offsite.sh [cluster-substring] [node]"
set -u
cd "$(dirname "$0")"
CL=${1:-solo}; NODE=${2:-solo1}; KEEP=${KEEP:-}
IP=$(hostname -I | awk '{print $1}'); EP="http://$IP:9000"; BK=pgarca-lab; KEY=pgarca; SEC=pgarca-secret-1
pass=0; fail=0; ok() { echo "PASS $*"; pass=$((pass+1)); }; ko() { echo "FAIL $*"; fail=$((fail+1)); }
mkdir -p ~/s3cfg && echo '{"identities":[{"name":"pgarca","credentials":[{"accessKey":"pgarca","secretKey":"pgarca-secret-1"}],"actions":["Admin","Read","Write","List","Tagging"]}]}' > ~/s3cfg/s3.json
docker rm -f s3srv >/dev/null 2>&1
docker run -d --name s3srv -p 9000:8333 -v ~/s3cfg:/cfg:ro chrislusf/seaweedfs server -s3 -s3.config=/cfg/s3.json >/dev/null || { echo "cannot start the S3 server"; exit 1; }
for i in $(seq 1 30); do curl -s -o /dev/null "$EP/" && break; sleep 2; done; sleep 3
s3() { (cd ../../unix-agent && python3 -c "
import sys, json; sys.path.insert(0, '.')
from pg_arca.s3 import S3Client
c = S3Client('$EP', '$BK', '$KEY', '$SEC')
cmd = sys.argv[1]
if cmd == 'mkbucket':
    try: c._req('PUT')
    except Exception as e: print('bucket:', e)
elif cmd == 'count':
    objs = c.list('')
    print(len(objs), sum(objs.values()), len([k for k in objs if '/cas/packs/' in k or k.split('/')[1:2] == ['repo']]), len([k for k in objs if '/wal/' in k]))
" "$@"); }
s3 mkbucket
PREFIX="lab-$(date +%s)"
P=$(printf '{"offsite":{"type":"s3","endpoint":"%s","bucket":"%s","prefix":"%s","access_key":"%s","secret_key":"%s","region":"us-east-1"},"test":true}' "$EP" "$BK" "$PREFIX" "$KEY" "$SEC")
python3 op.py "$CL" offsite_set "$P" --node "$NODE" --wait 120 > /tmp/off1.log 2>&1 && ok "offsite_set with probe (console -> agent -> bucket)" || { ko "offsite_set"; cat /tmp/off1.log | tail -5; }
python3 op.py "$CL" offsite_get --node "$NODE" --wait 60 > /tmp/off2.log 2>&1
grep -q '"secret_key_set": true' /tmp/off2.log && ! grep -q "$SEC" /tmp/off2.log && ok "offsite_get: secret stored, never shown" || { ko "offsite_get"; tail -15 /tmp/off2.log; }
python3 op.py "$CL" backup_run '{"type":"full"}' --node "$NODE" --wait 1800 > /tmp/off3.log 2>&1 && ok "full backup" || { ko "full backup"; tail -5 /tmp/off3.log; }
T0=$(date +%s)
python3 op.py "$CL" offsite_sync --node "$NODE" --wait 1800 > /tmp/off4.log 2>&1 && ok "offsite_sync ($(( $(date +%s) - T0 )) s)" || { ko "offsite_sync"; tail -8 /tmp/off4.log; }
grep -E '"(uploaded|bytes_up|uploaded_bytes|seconds|deleted)"' /tmp/off4.log | head -6
read n bytes packs wal <<< "$(s3 count)"
echo "   bucket: $n objects, $bytes bytes, repo objects $packs, wal objects $wal"
[ "${n:-0}" -gt 0 ] && [ "${packs:-0}" -gt 0 ] && [ "${wal:-0}" -gt 0 ] && ok "bucket holds repository and WAL archive" || ko "bucket content"
python3 op.py "$CL" offsite_rehydrate '{"what":"all"}' --node "$NODE" --wait 600 > /tmp/off5.log 2>&1 && grep -q '"downloaded": 0' /tmp/off5.log && ok "rehydrate with nothing missing downloads nothing" || { ko "rehydrate"; tail -8 /tmp/off5.log; }
python3 op.py "$CL" offsite_sync --node "$NODE" --wait 600 > /tmp/off6.log 2>&1 && ok "second sync (nothing changed)" || ko "second sync"
grep -E '"(uploaded|seconds)"' /tmp/off6.log | head -3
if [ -z "$KEEP" ]; then
  python3 op.py "$CL" offsite_set '{"offsite":null}' --node "$NODE" --wait 60 > /dev/null 2>&1 && ok "configuration cleared" || ko "clear"
  docker rm -f s3srv >/dev/null 2>&1
fi
echo "== offsite scenario: $pass passed, $fail failed"
[ "$fail" = 0 ]
