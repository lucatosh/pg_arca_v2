import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { mountScopedRoutes, SPECS } from '../../server/scoped';
import { mountDestinationRoutes, destinationFor } from '../../server/destinations';
import { mountOperatorRoutes } from '../../server/agents';
import * as ops from '../../server/ops';
import { validateOp } from '../../server/optypes';

(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'dst-'))); const app = new MiniApp();
  mountScopedRoutes(app, store); mountDestinationRoutes(app, store); mountOperatorRoutes(app, store, {});
  const now = new Date().toISOString();
  await store.mutate(d => {
    d.clusters.push({ id: 'c1', name: 'Prod DB 1', environment: 'prod', folder: '', source: 'agent' } as any, { id: 'c2', name: 'dev2', environment: 'dev', folder: '', source: 'agent' } as any);
    d.nodes.a = { id: 'a', name: 'a', clusterId: 'c1', lastSeen: now, snapshot: { postgres: { alive: true, is_in_recovery: false } } } as any;
    d.nodes.b = { id: 'b', name: 'b', clusterId: 'c1', lastSeen: now, snapshot: { postgres: { alive: true, is_in_recovery: true } } } as any;
  });
  const call = (m: string, u: string, body?: any, key?: string) => app.call(m, u, { body, headers: key ? { 'idempotency-key': key } : {} });
  const v = (x: any) => (SPECS.destination.validate(x, store.peek()) as any);

  // validation: real types only, placeholders, paths
  assert.equal(v({ type: 'nfs', repoPath: '/mnt/backup/pgarca', walPath: '/mnt/backup/wal/{cluster}', requireMount: true, minFreeGb: 50 }).ok, true);
  for (const t of ['s3', 'azure', 'gcs', 'sftp']) { const r = v({ type: t }); assert.equal(r.ok, false); assert.match(r.error, /anteprima/i); }
  for (const bad of [{ type: 'tape' }, { repoPath: 'rel/path' }, { repoPath: '/a/../b' }, { repoPath: '/mnt/{nope}' }, { repoPath: '/x', walPath: '/x' }, { minFreeGb: -1 }, { foo: 1 }]) assert.equal(v(bad).ok, false, JSON.stringify(bad));

  // global value + per-env override; placeholders give each cluster its own directory
  assert.equal((await call('PUT', '/api/scoped/destination/assignments', { scope: 'global', value: { type: 'nfs', repoPath: '/mnt/backup/pgarca', walPath: '/mnt/backup/wal/{env}/{cluster}', requireMount: true } })).status, 200);
  assert.equal((await call('PUT', '/api/scoped/destination/assignments', { scope: 'env', key: 'dev', value: { type: 'local', requireMount: false, repoPath: '/var/lib/pgarca/repo' } })).status, 200);
  let d1 = destinationFor(store.peek(), store.peek().clusters[0]).dest!, d2 = destinationFor(store.peek(), store.peek().clusters[1]).dest!;
  assert.deepEqual([d1.type, d1.repo_path, d1.wal_path, d1.require_mount], ['nfs', '/mnt/backup/pgarca', '/mnt/backup/wal/prod/prod-db-1', true]);
  assert.deepEqual([d2.type, d2.repo_path, d2.wal_path, d2.require_mount], ['local', '/var/lib/pgarca/repo', '/mnt/backup/wal/dev/dev2', false]);
  // a WAL path shared by several clusters is called out
  await call('PUT', '/api/scoped/destination/assignments', { scope: 'global', value: { type: 'nfs', repoPath: '/mnt/backup/pgarca', walPath: '/mnt/backup/wal' } });
  assert.match(destinationFor(store.peek(), store.peek().clusters[0]).dest!.wal_shared_warning || '', /sovrascrivono/);
  await call('PUT', '/api/scoped/destination/assignments', { scope: 'global', value: { type: 'nfs', repoPath: '/mnt/backup/pgarca', walPath: '/mnt/backup/wal/{cluster}', requireMount: true } });

  // check: one operation per online node
  let r = await call('POST', '/api/clusters/c1/destination/check', {}, 'k1'); assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.operations.length, 2);
  assert.equal(r.body.operations[0].operation.type, 'destination_check');
  assert.equal(r.body.operations[0].operation.params.wal_path, '/mnt/backup/wal/prod-db-1');
  assert.equal(validateOp('destination_check', r.body.operations[0].operation.params), null);
  assert.equal((await call('POST', '/api/clusters/c1/destination/check', {})).status, 400, 'needs an idempotency key');
  assert.equal((await call('POST', '/api/clusters/nope/destination/check', {}, 'k')).status, 404);

  // apply is refused until every node has a fresh successful check of exactly this destination
  r = await call('POST', '/api/clusters/c1/destination/apply', {}, 'ap1'); assert.equal(r.status, 409); assert.equal(r.body.error, 'check_required');
  const finish = async (opId: string, ok: boolean) => store.mutate(d => { const o = d.operations.find((x: any) => x.id === opId)!; o.status = 'succeeded'; o.result = { ok, paths: [] }; o.updatedAt = new Date().toISOString(); });
  const checkOps = (await call('GET', '/api/clusters/c1/destination')).body;
  await finish(store.peek().operations.filter((o: any) => o.type === 'destination_check' && o.nodeId === 'a')[0].id, true);
  r = await call('POST', '/api/clusters/c1/destination/apply', {}, 'ap2'); assert.equal(r.status, 409, 'node b not checked yet');
  await finish(store.peek().operations.filter((o: any) => o.type === 'destination_check' && o.nodeId === 'b')[0].id, false);
  r = await call('POST', '/api/clusters/c1/destination/apply', {}, 'ap3'); assert.equal(r.status, 409, 'a failed check blocks the apply');
  // second check, both fine
  r = await call('POST', '/api/clusters/c1/destination/check', {}, 'k2');
  for (const o of r.body.operations) await finish(o.operation.id, true);
  r = await call('POST', '/api/clusters/c1/destination/apply', {}, 'ap4'); assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.operations.length, 2);
  const cfg = r.body.operations[0].operation;
  assert.equal(cfg.type, 'agent_config_set'); assert.deepEqual(cfg.params.set, { repo_path: '/mnt/backup/pgarca', wal_archive_dir: '/mnt/backup/wal/prod-db-1' });
  assert.equal(validateOp('agent_config_set', cfg.params), null);
  assert.equal(store.peek().settings.destinationApplied.c1.wal_path, '/mnt/backup/wal/prod-db-1');
  // changing the destination invalidates the previous checks
  await call('PUT', '/api/scoped/destination/assignments', { scope: 'cluster', key: 'c1', value: { repoPath: '/mnt/other/pgarca' } });
  r = await call('POST', '/api/clusters/c1/destination/apply', {}, 'ap5'); assert.equal(r.status, 409, 'checks of the old destination do not count');
  console.log('destination tests OK');
})().catch(e => { console.error(e); process.exit(1); });
