#!/bin/bash
# Lab helper: time a real heartbeat (no snapshot, no ops requested) with the credentials of the agent inside a container.   hb-time.sh [container] [wait_seconds]
n=${1:-pg1}; w=${2:-0}
docker exec "$n" python3 -c "
import json,time,urllib.request
c=json.load(open('/etc/pg-arca/credentials.json'))
for i in range(3):
    t=time.time()
    r=urllib.request.Request('http://host.docker.internal:3000/api/agent/heartbeat',data=json.dumps({'max_ops':0,'wait_seconds':$w}).encode(),headers={'content-type':'application/json','authorization':'Bearer '+c['agent_token'],'x-arca-node':c['node_id']})
    try:
        b=urllib.request.urlopen(r,timeout=60).read(); print('heartbeat %.2fs %s' % (time.time()-t, b[:120]))
    except Exception as e: print('heartbeat FAILED after %.2fs: %s' % (time.time()-t, e))
"
