import assert from 'node:assert/strict';
import { resolveScoped, ephemeralForAgent, SPECS } from '../../server/scoped';
import { withEphemeral, centralInto } from '../../server/agents';
import { validateOp } from '../../server/optypes';

const st: any = {
  nodes: { n1: { id: 'n1', name: 'pg1', clusterId: 'c1', remoteIp: '::ffff:10.0.0.5', lastSeen: new Date().toISOString(), snapshot: { postgres: { is_in_recovery: false, port: 5433 } } },
           n2: { id: 'n2', name: 'restore-host', clusterId: 'c9', remoteIp: '10.0.0.9', lastSeen: new Date().toISOString(), snapshot: {} } },
  clusters: [{ id: 'c1', name: 'prod', environment: 'prod', folder: 'dc1/db' }, { id: 'c2', name: 'dev', environment: 'dev', folder: '' }],
  settings: { scoped: { ephemeral: {
    global: { sharedBuffersMb: 512, scratchDir: '/var/tmp/pgarca-scratch' },
    'env:prod': { portMin: 55000, portMax: 55100 },
    'folder:dc1': { sharedBuffersMb: 1024 },
    'folder:dc1/db': { keepOnFailure: true },
    'cluster:c1': { scratchDir: '/data/scratch' },
  } } },
};
const store: any = { peek: () => st };

// field-by-field inheritance: cluster > folder (deepest first) > env > global > default, each field remembers where it came from
const r = resolveScoped(st, 'ephemeral', st.clusters[0]);
assert.equal(r.value.scratchDir, '/data/scratch');
assert.equal(r.value.sharedBuffersMb, 1024, 'folder beats global');
assert.equal(r.value.portMin, 55000);
assert.equal(r.value.keepOnFailure, true);
assert.equal(r.value.placement, 'node', 'default');
assert.deepEqual(r.sources.scratchDir, { scope: 'cluster', key: 'cluster:c1' });
assert.deepEqual(r.sources.sharedBuffersMb, { scope: 'folder', key: 'folder:dc1' });
assert.deepEqual(r.sources.placement, { scope: 'default', key: '' });
const r2 = resolveScoped(st, 'ephemeral', st.clusters[1]);
assert.equal(r2.value.sharedBuffersMb, 512);
assert.equal(r2.value.scratchDir, '/var/tmp/pgarca-scratch');
assert.equal(r2.value.portMin, undefined);

// what the agent receives
assert.deepEqual(ephemeralForAgent(r), { placement: 'node', scratch_dir: '/data/scratch', port_min: 55000, port_max: 55100, shared_buffers_mb: 1024, keep_on_failure: true, install_mode: 'private' });

// resolved at hand-over, only for the operations it concerns; the stored params are untouched
const o: any = { type: 'restore_object', clusterId: 'c1', params: { object: 'a.b.c' } };
assert.equal(withEphemeral(store, o).ephemeral.scratch_dir, '/data/scratch');
assert.equal(o.params.ephemeral, undefined);
assert.equal(withEphemeral(store, { type: 'backup_run', clusterId: 'c1', params: { type: 'full' } }).ephemeral, undefined);

// validation
const v = (x: any) => SPECS.ephemeral.validate(x, st) as any;
assert.equal(v({ placement: 'central', centralNode: 'n2', portMin: 55000, portMax: 55010, scratchDir: '/mnt/fast/scratch' }).ok, true);
for (const bad of [{ placement: 'cloud' }, { centralNode: 'nope' }, { scratchDir: 'relative' }, { scratchDir: '/a/../etc' }, { portMin: 55000 }, { portMin: 60, portMax: 70 },
  { portMin: 55010, portMax: 55000 }, { sharedBuffersMb: 4 }, { installMode: 'rpm' }, { whatever: 1 }, { centralInto: { host: 'a b' } }]) assert.equal(v(bad).ok, false, JSON.stringify(bad));
assert.equal(v({ keepOnFailure: false }).value.keepOnFailure, false);

// central delivery target: derived from the cluster's primary, overridable
assert.deepEqual(centralInto(st, st.clusters[0], {}), { host: '10.0.0.5', port: 5433, user: 'postgres' });
assert.deepEqual(centralInto(st, st.clusters[0], { centralInto: { host: 'db.example.test', user: 'arca' } }), { host: 'db.example.test', port: 5433, user: 'arca' });
assert.equal(centralInto(st, st.clusters[1], {}), null, 'a cluster with no agent node has no known primary');

// the new operations
assert.equal(validateOp('ephemeral_preflight', { major: 16 }), null);
assert.notEqual(validateOp('ephemeral_preflight', { major: 'x' }), null);
assert.notEqual(validateOp('ephemeral_install', { major: 16, mode: 'private' }), null, 'needs the INSTALL confirmation');
assert.equal(validateOp('ephemeral_install', { major: 16, mode: 'system', confirm: 'INSTALL' }), null);
assert.notEqual(validateOp('ephemeral_install', { major: 16, mode: 'rpm', confirm: 'INSTALL' }), null);
console.log('scoped tests OK');

// ------------------------------------------------------------------------------------------------ routes: assignments + central routing
import fs from 'fs'; import os from 'os'; import path from 'path';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { mountScopedRoutes } from '../../server/scoped';
import { mountOperatorRoutes, mountAgentRoutes } from '../../server/agents';
import { isRisky } from '../../server/approvals';
(async () => {
  assert(isRisky('ephemeral_install'));
  const store2 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'scp-'))); const app = new MiniApp();
  mountScopedRoutes(app, store2); mountOperatorRoutes(app, store2, {}); mountAgentRoutes(app, store2);
  const now = new Date().toISOString();
  await store2.mutate(d => {
    d.clusters.push({ id: 'c1', name: 'prod', environment: 'prod', folder: '', source: 'agent' } as any);
    d.nodes.p1 = { id: 'p1', name: 'p1', clusterId: 'c1', remoteIp: '10.1.1.1', lastSeen: now, snapshot: { postgres: { alive: true, is_in_recovery: false, port: 5432 } } } as any;
    d.nodes.rh = { id: 'rh', name: 'restore-host', clusterId: 'c9', remoteIp: '10.1.1.9', lastSeen: now, snapshot: { postgres: { alive: true, is_in_recovery: false } } } as any;
  });
  const call = (m: string, u: string, body?: any, key?: string) => app.call(m, u, { body, headers: key ? { 'idempotency-key': key } : {} });
  let r = await call('PUT', '/api/scoped/ephemeral/assignments', { scope: 'global', value: { sharedBuffersMb: 128 } }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.clusters[0].effective.value.sharedBuffersMb, 128);
  assert.equal((await call('PUT', '/api/scoped/ephemeral/assignments', { scope: 'global', value: { sharedBuffersMb: 1 } })).status, 400);
  assert.equal((await call('PUT', '/api/scoped/nothing/assignments', { scope: 'global', value: {} })).status, 404);
  assert.equal((await call('PUT', '/api/scoped/ephemeral/assignments', { scope: 'cluster', key: 'nope', value: { keepOnFailure: true } })).status, 404);
  // without placement the operation runs on the cluster's own node
  r = await call('POST', '/api/clusters/c1/operations', { type: 'restore_object', params: { object: 'db.public.t' } }, 'k1'); assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.operation.nodeId, 'p1'); assert.equal(r.body.operation.params.into, undefined);
  // central: runs on the restore host, delivers into the cluster's primary
  assert.equal((await call('PUT', '/api/scoped/ephemeral/assignments', { scope: 'cluster', key: 'c1', value: { placement: 'central', centralNode: 'rh' } })).status, 200);
  r = await call('POST', '/api/clusters/c1/operations', { type: 'restore_object', params: { object: 'db.public.t' } }, 'k2'); assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.operation.nodeId, 'rh'); assert.deepEqual(r.body.operation.params.into, { host: '10.1.1.1', port: 5432, user: 'postgres' });
  r = await call('POST', '/api/clusters/c1/operations', { type: 'restore_drill', params: {} }, 'k3'); assert.equal(r.body.operation.nodeId, 'rh'); assert.equal(r.body.operation.params.into, undefined, 'a drill delivers nothing');
  r = await call('POST', '/api/clusters/c1/operations', { type: 'backup_run', params: { type: 'incr' } }, 'k4'); assert.equal(r.body.operation.nodeId, 'p1', 'backups always run on the cluster itself');
  r = await call('POST', '/api/clusters/c1/operations', { type: 'restore_object', params: { object: 'db.public.t', into: { host: 'other', port: 5432 } } }, 'k5'); assert.equal(r.body.operation.params.into.host, 'other', 'an explicit target is respected');
  // the central node vanishes -> a clear refusal, nothing queued
  await store2.mutate(d => { delete d.nodes.rh; });
  r = await call('POST', '/api/clusters/c1/operations', { type: 'restore_object', params: { object: 'db.public.t' } }, 'k6'); assert.equal(r.status, 409); assert.equal(r.body.error, 'central_node_missing');
  assert.equal((await call('PUT', '/api/scoped/ephemeral/assignments', { scope: 'cluster', key: 'c1', inherit: true })).status, 200);
  assert.equal(store2.peek().settings.scoped.ephemeral['cluster:c1'], undefined);
  console.log('scoped routes OK');
})().catch(e => { console.error(e); process.exit(1); });
