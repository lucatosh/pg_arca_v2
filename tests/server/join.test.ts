import { summarize } from '../../server/join';
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert'; import crypto from 'crypto';
import { MiniApp } from './mini-express';
import { Store, sha256 } from '../../server/store';
import { mountAgentRoutes, authNode } from '../../server/agents';
import { mountJoinRoutes } from '../../server/join';
import { mountAdvancedRoutes } from '../../server/approvals';
import { audit } from '../../server/ops';
import { requiredRole } from '../../server/auth';
(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'join-'))); const app = new MiniApp();
  mountAgentRoutes(app, store); mountJoinRoutes(app, store); mountAdvancedRoutes(app, store, audit);
  const call = (m: string, u: string, body?: any, headers: any = {}) => app.call(m, u, { body, headers });
  const agent = (n: number) => { const secret = crypto.randomBytes(32).toString('hex'); return { fingerprint: 'fp' + String(n).padStart(20, '0'), secret, secret_hash: sha256(secret) }; };
  const disc = { host: { hostname: 'db01' }, postgres_instances: [{ version: '16.4', data_directory: '/var/lib/postgresql/16/main', port: 5432, cluster_key: 'sysid:123', role: 'primary', secret_field: 'must-not-be-kept' }] };
  const A = agent(1);
  const body = (a: any, extra: any = {}) => ({ fingerprint: a.fingerprint, secret_hash: a.secret_hash, node_name: 'db01', agent_version: '2.0', discovery: disc, ...extra });

  // validation + announce + idempotent re-announce
  assert.strictEqual((await call('POST', '/api/agent/request-join', { fingerprint: 'x', secret_hash: 'y', node_name: 'db01' })).status, 400);
  assert.strictEqual((await call('POST', '/api/agent/request-join', body(A))).status, 201);
  assert.strictEqual((await call('POST', '/api/agent/request-join', body(A))).status, 200, 'same fingerprint = same request');
  assert.strictEqual((await call('POST', '/api/agent/request-join', body(A, { secret_hash: sha256('other') }))).status, 409, 'cannot hijack a fingerprint');
  assert.strictEqual(store.peek().settings.joinRequests.length, 1);
  assert(!JSON.stringify(store.peek().settings.joinRequests).includes('must-not-be-kept'), 'only a short summary is stored');
  assert.strictEqual(Object.keys(store.peek().nodes).length, 0, 'nothing is trusted yet');
  // still pending; wrong secret learns nothing
  assert.strictEqual((await call('POST', '/api/agent/join-status', { fingerprint: A.fingerprint, secret: A.secret })).body.status, 'pending');
  assert.strictEqual((await call('POST', '/api/agent/join-status', { fingerprint: A.fingerprint, secret: 'nope' })).status, 404);
  assert.strictEqual(requiredRole('GET', '/api/join-requests'), 'admin'); assert.strictEqual(requiredRole('POST', '/api/join-requests/x/approve'), 'admin');
  // operator view
  const list = (await call('GET', '/api/join-requests')).body.requests; assert.strictEqual(list.length, 1); assert.strictEqual(list[0].summary.postgres[0].version, '16.4'); assert.strictEqual(list[0].matchCluster, null);
  // approving a request that would create a cluster needs an environment
  const id = list[0].id; assert.strictEqual((await call('POST', `/api/join-requests/${id}/approve`, {})).status, 400);
  const ok = await call('POST', `/api/join-requests/${id}/approve`, { environment: 'prod', name: 'orders' }); assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(store.peek().clusters.find((c: any) => c.id === ok.body.clusterId).name, 'orders');
  const st = (await call('POST', '/api/agent/join-status', { fingerprint: A.fingerprint, secret: A.secret })).body; assert.strictEqual(st.status, 'approved'); assert.strictEqual(st.node_id, ok.body.nodeId);
  // the agent's own secret is now its bearer token; the console never saw it
  const req: any = { headers: { 'x-arca-node': st.node_id, authorization: 'Bearer ' + A.secret } }; assert.strictEqual(authNode(store, req)?.id, st.node_id);
  assert.strictEqual(authNode(store, { headers: { 'x-arca-node': st.node_id, authorization: 'Bearer ' + sha256(A.secret) } } as any), null, 'the hash alone is not a credential');
  assert.strictEqual((await call('POST', `/api/join-requests/${id}/approve`, { environment: 'prod' })).status, 409, 'cannot approve twice');
  assert.strictEqual((await call('GET', '/api/join-requests')).body.requests.length, 0);
  assert(store.peek().audit.some((e: any) => e.action === 'agent.join.approve'));

  // second node of the same cluster is matched automatically; names must be unique
  const B = agent(2); await call('POST', '/api/agent/request-join', body(B, { node_name: 'db02' }));
  const lb = (await call('GET', '/api/join-requests')).body.requests[0]; assert.strictEqual(lb.matchCluster?.name, 'orders');
  const okb = await call('POST', `/api/join-requests/${lb.id}/approve`, {}); assert.strictEqual(okb.status, 200); assert.strictEqual(okb.body.clusterId, ok.body.clusterId);
  const C = agent(3); await call('POST', '/api/agent/request-join', body(C)); // name db01 already in use
  const lc = (await call('GET', '/api/join-requests')).body.requests[0]; assert.strictEqual(lc.nameInUse, true);
  assert.strictEqual((await call('POST', `/api/join-requests/${lc.id}/approve`, { environment: 'dev' })).status, 409);
  // reject: the agent is told, and the same fingerprint cannot just re-request
  assert.strictEqual((await call('POST', `/api/join-requests/${lc.id}/reject`)).status, 200);
  assert.strictEqual((await call('POST', '/api/agent/join-status', { fingerprint: C.fingerprint, secret: C.secret })).body.status, 'rejected');
  assert.strictEqual((await call('POST', '/api/agent/request-join', body(C))).body.status, 'rejected');

  // abuse limits: per source address and global
  for (let i = 10; i < 30; i++) await call('POST', '/api/agent/request-join', body(agent(i), { node_name: 'n' + i }));
  assert.strictEqual(store.peek().settings.joinRequests.filter((r: any) => r.status === 'pending').length, 10, 'per-address cap');
  // switch off -> refused with a clear message; the token flow is untouched
  assert.strictEqual((await call('PUT', '/api/advanced', { joinRequests: false })).status, 200);
  const off = await call('POST', '/api/agent/request-join', body(agent(99), { node_name: 'zz' })); assert.strictEqual(off.status, 403); assert.strictEqual(off.body.error, 'join_disabled');
  assert.strictEqual((await call('POST', '/api/agent/enroll', { node_name: 'x', enrollment_token: 'bad' })).status, 401);
  // expiry of silent requests
  await call('PUT', '/api/advanced', { joinRequests: true });
  await store.mutate(d => { for (const r of d.settings.joinRequests) if (r.status === 'pending') r.lastSeenAt = new Date(Date.now() - 49 * 3600_000).toISOString(); });
  assert.strictEqual((await call('GET', '/api/join-requests')).body.requests.length, 0, 'silent requests disappear');
  // PostgreSQL not visible yet but Patroni is: the cluster identity still comes from the Patroni scope, so the 3 nodes group into one cluster
  assert.strictEqual(summarize({ postgres_instances: [], patroni_clusters: [{ scope: 'arca-lab' }] }).clusterKey, 'patroni:arca-lab');
  assert.strictEqual(summarize({ postgres_instances: [{ cluster_key: 'sysid:9', port: 5432 }] }).clusterKey, 'sysid:9');
  assert.strictEqual(summarize({}).clusterKey, undefined);
  console.log('join tests OK');
})().catch(e => { console.error(e); process.exit(1); });
