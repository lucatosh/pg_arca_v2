/** GET /api/clusters/:id/storage: where each node keeps backups and WAL (backup server / share / local disk), shared or split, and the
 *  administrator-only details (paths, mount sources, server addresses); the masking of the other destination answers for non-administrators. */
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { mountScopedRoutes, SPECS } from '../../server/scoped';
import { mountDestinationRoutes, destinationFor, workerForHost, hostsOf, HIDDEN } from '../../server/destinations';
import { validateOp } from '../../server/optypes';
import { mountOperatorRoutes } from '../../server/agents';
import { evaluate } from '../../server/health';
import { workerView, mountWorkerRoutes } from '../../server/workers';

(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sto-'))); const app = new MiniApp();
  app.use((req: any, _res: any, next: any) => { req.role = req.headers['x-role'] || 'admin'; req.actor = 'u'; return next(); });
  mountScopedRoutes(app, store); mountDestinationRoutes(app, store); mountOperatorRoutes(app, store, {}); mountWorkerRoutes(app, store);
  const now = new Date().toISOString();
  const disks = (repoDev: number) => ({ repo: { path: '/mnt/pgarca/repo', free_bytes: 5e11, total_bytes: 1e12, dev: repoDev }, wal_archive: { path: '/mnt/pgarca/wal', free_bytes: 5e11, total_bytes: 1e12, dev: repoDev }, pgdata: { path: '/var/lib/pgsql/data', free_bytes: 1e11, total_bytes: 2e11, dev: 1 } });
  const nfs = (id: string) => ({ repo_path: '/mnt/pgarca/repo', wal_path: '/mnt/pgarca/wal', repo_id: id, wal_id: id + 'w',
    repo_mount: { mountpoint: '/mnt/pgarca', fstype: 'nfs4', source: 'bk1.lan:/srv/pgarca', remote_host: 'bk1.lan' }, wal_mount: { mountpoint: '/mnt/pgarca', fstype: 'nfs4', source: 'bk1.lan:/srv/pgarca', remote_host: 'bk1.lan' } });
  await store.mutate(d => {
    d.clusters.push({ id: 'c1', name: 'prod1', environment: 'prod', folder: '', source: 'agent' } as any, { id: 'c2', name: 'dev1', environment: 'dev', folder: '', source: 'agent' } as any);
    d.nodes.a = { id: 'a', name: 'pg-a', clusterId: 'c1', lastSeen: now, snapshot: { postgres: { alive: true, is_in_recovery: false }, storage: nfs('S1'), system: { disks: disks(9) } } } as any;
    d.nodes.b = { id: 'b', name: 'pg-b', clusterId: 'c1', lastSeen: now, snapshot: { postgres: { alive: true, is_in_recovery: true }, storage: nfs('S1'), system: { disks: disks(9) } } } as any;
    d.nodes.x = { id: 'x', name: 'dev-x', clusterId: 'c2', lastSeen: now, snapshot: { postgres: { alive: true, is_in_recovery: false },
      storage: { repo_path: '/var/lib/pgarca/repo', wal_path: '/var/lib/pgarca/wal', repo_id: 'L1', wal_id: 'L2', repo_mount: { mountpoint: '/', fstype: 'xfs', source: '/dev/sda1', remote_host: null }, wal_mount: null },
      system: { disks: { repo: { path: '/var/lib/pgarca/repo', free_bytes: 1, total_bytes: 10, dev: 1 }, pgdata: { path: '/var/lib/pgsql', free_bytes: 1, total_bytes: 10, dev: 1 } } } } } as any;
    d.nodes.y = { id: 'y', name: 'dev-y', clusterId: 'c2', lastSeen: now, snapshot: { postgres: { alive: true, is_in_recovery: true },
      storage: { repo_path: '/var/lib/pgarca/repo', wal_path: '/var/lib/pgarca/wal', repo_id: 'L9', wal_id: 'L8', repo_mount: { mountpoint: '/', fstype: 'xfs', source: '/dev/sda1', remote_host: null } } } } as any;
    d.nodes.w1 = { id: 'w1', name: 'backup-dc1', kind: 'worker', roles: ['repository'], lastSeen: now, remoteIp: '::ffff:10.0.0.9',
      snapshot: { worker: { identity: { hostname: 'bk1', fqdn: 'bk1.lan', addresses: ['10.0.0.9', '127.0.0.1'] } } } } as any;
    d.nodes.w2 = { id: 'w2', name: 'restore-dc1', kind: 'worker', roles: ['recovery'], lastSeen: now, remoteIp: '10.0.0.20', snapshot: { worker: { identity: { hostname: 'rc1' } } } } as any;
  });
  const call = (m: string, u: string, role = 'admin', body?: any) => app.call(m, u, { body, headers: { 'x-role': role } });

  // the worker a mount points to: by FQDN, short name, address; loopback never counts
  assert.deepEqual(hostsOf(store.peek().nodes.w1), ['10.0.0.9', 'backup-dc1', 'bk1', 'bk1.lan']);
  assert.equal(workerForHost(store.peek(), 'bk1.lan')?.id, 'w1');
  assert.equal(workerForHost(store.peek(), 'BK1')?.id, 'w1');
  assert.equal(workerForHost(store.peek(), '10.0.0.9')?.id, 'w1');
  assert.equal(workerForHost(store.peek(), '10.0.0.20')?.id, 'w2');
  assert.equal(workerForHost(store.peek(), '127.0.0.1'), null);
  assert.equal(workerForHost(store.peek(), '10.0.0'), null, 'an address prefix is not a short name');
  assert.equal(workerForHost(store.peek(), '10.7.7.7'), null, 'addresses are never shortened');
  assert.equal(workerForHost(store.peek(), 'bk1.other.org'), null, 'two different domains');
  assert.equal(workerForHost(store.peek(), 'bk1.dc2.lan')?.id ?? null, null);

  // administrator: the backup server by name, shared storage, details
  let r = await call('GET', '/api/clusters/c1/storage');
  assert.equal(r.status, 200); assert.equal(r.body.admin, true);
  assert.equal(r.body.repoSharing, 'shared'); assert.equal(r.body.walSharing, 'shared');
  const a = r.body.nodes.find((n: any) => n.id === 'a');
  assert.equal(a.role, 'primary'); assert.equal(a.repo.kind, 'backup_server'); assert.equal(a.repo.server.name, 'backup-dc1'); assert.equal(a.repo.fstype, 'nfs4');
  assert.equal(a.repo.path, '/mnt/pgarca/repo'); assert.equal(a.repo.source, 'bk1.lan:/srv/pgarca'); assert.equal(a.repo.sameDiskAsData, false);
  assert.equal(a.repo.id, undefined, 'storage ids stay internal');
  assert.deepEqual(r.body.backupServers.map((s: any) => s.name), ['backup-dc1']); assert.ok(r.body.backupServers[0].hosts.includes('bk1.lan'));

  // the backup server's page says which clusters really write there (from the nodes' mounts)
  assert.deepEqual((workerView(store.peek(), store.peek().nodes.w1, true) as any).stores, [{ clusterId: 'c1', clusterName: 'prod1', nodes: ['pg-a', 'pg-b'], what: ['backups', 'WAL archive'] }]);
  assert.deepEqual((workerView(store.peek(), store.peek().nodes.w2, true) as any).stores, []);
  // a backup server's addresses, mount points and directories: administrators only
  await store.mutate(d => { (d.nodes.w1 as any).snapshot.worker.mounts = [{ mount: '/srv/pgarca', fstype: 'xfs', remote: false }]; (d.nodes.w1 as any).snapshot.worker.dirs = { repo: { path: '/srv/pgarca/repo', exists: true } }; });
  for (const u of ['/api/workers', '/api/workers/w1']) {
    const ad = JSON.stringify((await call('GET', u, 'admin')).body), vw = JSON.stringify((await call('GET', u, 'viewer')).body);
    assert.ok(ad.includes('10.0.0.9'), u); assert.equal(vw.includes('10.0.0.9'), false, u); assert.equal(vw.includes('/srv/pgarca'), false, u);
  }
  // operator / viewer: the same picture, no paths, sources or addresses
  for (const role of ['operator', 'viewer']) {
    r = await call('GET', '/api/clusters/c1/storage', role);
    const b = r.body.nodes.find((n: any) => n.id === 'a');
    assert.equal(r.body.admin, false); assert.equal(b.repo.kind, 'backup_server'); assert.equal(b.repo.server.name, 'backup-dc1');
    for (const k of ['path', 'source', 'mountpoint', 'remoteHost']) assert.equal(k in b.repo, false, `${role} must not get ${k}`);
    assert.equal('hosts' in r.body.backupServers[0], false);
    assert.equal(JSON.stringify(r.body).includes('/mnt/pgarca'), false); assert.equal(JSON.stringify(r.body).includes('10.0.0.9'), false);
  }

  // the fleet in one answer (no locations in it, for every role)
  const ov = (await call('GET', '/api/storage-overview', 'viewer')).body.clusters;
  assert.deepEqual(ov.find((x: any) => x.id === 'c1'), { id: 'c1', name: 'prod1', environment: 'prod', nodes: 2, kinds: ['backup_server'], servers: ['backup-dc1'], repoSharing: 'shared', walSharing: 'shared', sameDiskAsData: false });
  assert.deepEqual(ov.find((x: any) => x.id === 'c2').kinds, ['local_disk']); assert.equal(ov.find((x: any) => x.id === 'c2').repoSharing, 'split');
  assert.equal(JSON.stringify(ov).includes('/mnt'), false);
  // local disks on each node: split (a failover loses the history), same disk as the data
  r = await call('GET', '/api/clusters/c2/storage');
  assert.equal(r.body.repoSharing, 'split');
  const x = r.body.nodes.find((n: any) => n.id === 'x');
  assert.equal(x.repo.kind, 'local_disk'); assert.equal(x.repo.sameDiskAsData, true); assert.equal(x.repo.server, null);
  assert.equal(x.wal.kind, 'unknown');

  // a share from a non-backup worker, from an unknown machine
  await store.mutate(d => { (d.nodes.b as any).snapshot.storage.repo_mount = { mountpoint: '/mnt/o', fstype: 'nfs', source: 'rc1:/x', remote_host: 'rc1' }; (d.nodes.b as any).snapshot.storage.wal_mount = { mountpoint: '/mnt/z', fstype: 'cifs', source: '//nas7/b', remote_host: 'nas7' }; });
  r = await call('GET', '/api/clusters/c1/storage');
  const b2 = r.body.nodes.find((n: any) => n.id === 'b');
  assert.equal(b2.repo.kind, 'worker_share'); assert.equal(b2.repo.server.name, 'restore-dc1'); assert.equal(b2.wal.kind, 'network_share'); assert.equal(b2.wal.server, null);

  // destination with a backup server: validation, resolution, the check proves the share comes from it
  const v = (x: any) => SPECS.destination.validate(x, store.peek()) as any;
  assert.equal(v({ type: 'nfs', server: 'w1', serverPath: '/srv/pgarca', repoPath: '/mnt/pgarca/{cluster}/repo', walPath: '/mnt/pgarca/{cluster}/wal', requireMount: true }).ok, true);
  assert.match(v({ type: 'local', server: 'w1', repoPath: '/x' }).error, /NFS or SMB/);
  assert.equal(v({ server: 'bad id!' }).ok, false); assert.equal(v({ serverPath: 'rel' }).ok, false);
  assert.equal((await call('PUT', '/api/scoped/destination/assignments', 'admin', { scope: 'env', key: 'prod', value: { type: 'nfs', server: 'w1', serverPath: '/srv/pgarca', repoPath: '/mnt/pgarca/{cluster}/repo', walPath: '/mnt/pgarca/{cluster}/wal', requireMount: true } })).status, 200);
  const d1 = destinationFor(store.peek(), store.peek().clusters[0]).dest!;
  assert.equal(d1.server?.name, 'backup-dc1'); assert.equal(d1.server?.isBackupServer, true); assert.ok(d1.server?.hosts.includes('10.0.0.9'));
  r = await app.call('POST', '/api/clusters/c1/destination/check', { body: {}, headers: { 'idempotency-key': 'k1', 'x-role': 'admin' } });
  assert.equal(r.status, 202);
  const op = store.peek().operations.find((o: any) => o.type === 'destination_check')!;
  assert.deepEqual(op.params.expect_server, { name: 'backup-dc1', hosts: d1.server!.hosts });
  assert.equal(validateOp('destination_check', op.params), null);
  assert.ok(validateOp('destination_check', { type: 'nfs', repo_path: '/x', expect_server: { name: 'a', hosts: 'bk1' } }));
  // drift: applied on the nodes, but one of them writes through a mount from another machine -> a warning naming it
  const mismatch = () => evaluate(store.peek()).filter((i: any) => i.code === 'backup_server_mismatch' && i.clusterId === 'c1');
  assert.equal(mismatch().length, 0, 'not applied yet: no drift');
  await store.mutate(d => { for (const id of ['a', 'b']) { const sto = (d.nodes as any)[id].snapshot.storage; sto.repo_path = '/mnt/pgarca/prod1/repo'; sto.wal_path = '/mnt/pgarca/prod1/wal'; } });
  const mm = mismatch();
  assert.equal(mm.length, 1); assert.match(mm[0].cause, /On pg-b /); assert.equal(/pg-a/.test(mm[0].cause), false, 'pg-a mounts from bk1 = the backup server');
  await store.mutate(d => { const sto = (d.nodes as any).b.snapshot.storage; sto.repo_mount = sto.wal_mount = { mountpoint: '/mnt/pgarca', fstype: 'nfs4', source: '10.0.0.9:/srv/pgarca', remote_host: '10.0.0.9' }; });
  assert.equal(mismatch().length, 0, 'remounted from the backup server');
  // a level below that picks another share (or local disks) does not inherit the server check from above
  await call('PUT', '/api/scoped/destination/assignments', 'admin', { scope: 'cluster', key: 'c1', value: { type: 'nfs', repoPath: '/mnt/nas/repo', walPath: '/mnt/nas/wal/{cluster}', requireMount: true } });
  assert.equal(destinationFor(store.peek(), store.peek().clusters[0]).dest!.server, undefined);
  await call('PUT', '/api/scoped/destination/assignments', 'admin', { scope: 'cluster', key: 'c1', value: { type: 'local', repoPath: '/var/lib/pgarca/repo' } });
  assert.equal(destinationFor(store.peek(), store.peek().clusters[0]).dest!.server, undefined);
  await call('PUT', '/api/scoped/destination/assignments', 'admin', { scope: 'cluster', key: 'c1', inherit: true });
  assert.equal(destinationFor(store.peek(), store.peek().clusters[0]).dest!.server?.id, 'w1');
  // the server disappears: nothing can be applied until another one is chosen
  await store.mutate(d => { delete d.nodes.w1; });
  assert.equal(destinationFor(store.peek(), store.peek().clusters[0]).dest!.server?.missing, true);
  r = await app.call('POST', '/api/clusters/c1/destination/apply', { body: {}, headers: { 'idempotency-key': 'k2', 'x-role': 'admin' } });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'server_missing');

  // the other answers about the destination: masked for non-administrators, complete for administrators
  for (const u of ['/api/clusters/c1/destination', '/api/clusters/c1/placement', '/api/scoped/destination', '/api/clusters/c1/scoped/destination']) {
    const ad = await call('GET', u, 'admin'); const op2 = await call('GET', u, 'operator');
    assert.equal(ad.status, 200, u); assert.equal(op2.status, 200, u);
    assert.ok(JSON.stringify(ad.body).includes('/mnt/pgarca'), `${u}: administrators see the paths`);
    assert.equal(JSON.stringify(op2.body).includes('/mnt/pgarca'), false, `${u}: operators do not`);
    assert.ok(JSON.stringify(op2.body).includes(HIDDEN), u);
  }
  // the operations that carry locations (check, apply, migrate): masked for non-administrators too
  const opId = store.peek().operations.find((o: any) => o.type === 'destination_check')!.id;
  for (const u of ['/api/operations', `/api/operations/${opId}`]) {
    const ad = await call('GET', u, 'admin'); const vw = await call('GET', u, 'viewer');
    assert.ok(JSON.stringify(ad.body).includes('/mnt/pgarca'), u); assert.equal(JSON.stringify(vw.body).includes('/mnt/pgarca'), false, u);
    assert.equal(JSON.stringify(vw.body).includes('10.0.0.9'), false, u);
  }
  // the agent's settings page: its backup locations hidden, the rest as it is
  await store.mutate(d => { d.operations.push({ id: 'cfg1', type: 'agent_config_get', clusterId: 'c1', nodeId: 'a', status: 'succeeded', params: {}, createdAt: now, updatedAt: now,
    result: { settings: [{ key: 'repo_path', detected: '/var/lib/pgarca/repo', override: '/mnt/pgarca/c1/repo', effective: '/mnt/pgarca/c1/repo' }, { key: 'pg_port', detected: 5432, override: null, effective: 5432 }] } } as any); });
  const cfgV = (await call('GET', '/api/operations/cfg1', 'viewer')).body.operation.result.settings;
  assert.equal(cfgV[0].effective, HIDDEN); assert.equal(cfgV[1].effective, 5432);
  assert.equal((await call('GET', '/api/operations/cfg1', 'admin')).body.operation.result.settings[0].effective, '/mnt/pgarca/c1/repo');
  // "source" as a plain word (a cluster's source) is not hidden
  assert.equal((await call('GET', '/api/scoped/destination', 'viewer')).body.clusters[0].source, 'agent');
  const pl = (await call('GET', '/api/clusters/c1/placement', 'viewer')).body;
  assert.equal(pl.hidden, true); assert.equal(typeof pl.backup.pending, 'boolean'); assert.equal(pl.backup.type, 'nfs');
  // automatic layout: one base directory, one directory per cluster under it (backup + wal), created by the check, remembered once applied
  {
    const st0 = store.peek();
    await store.mutate(d => { d.settings.scoped = { ...(d.settings.scoped || {}), destination: {} }; d.settings.destinationApplied = {};
      d.clusters.push({ id: 'cl_aa11bb22cc33', name: 'prod1', environment: 'prod', folder: '', source: 'agent' } as any); });
    assert.equal(v({ baseDir: '/mnt/pgarca', repoPath: '/x' }).ok, false, 'base directory or explicit paths, not both');
    assert.equal(v({ baseDir: '/mnt/{cluster}' }).ok, false); assert.equal(v({ baseDir: '/' }).ok, false);
    assert.equal((await call('PUT', '/api/scoped/destination/assignments', 'admin', { scope: 'global', value: { type: 'nfs', baseDir: '/mnt/pgarca', requireMount: true } })).status, 200);
    const dOf = (id: string) => destinationFor(store.peek(), store.peek().clusters.find((x: any) => x.id === id)).dest!;
    const a1 = dOf('c1'), a2 = dOf('cl_aa11bb22cc33'), dv = dOf('c2');
    assert.deepEqual([a1.repo_path, a1.wal_path], ['/mnt/pgarca/prod/prod1-c1/backup', '/mnt/pgarca/prod/prod1-c1/wal']);
    assert.deepEqual([a2.repo_path, a2.wal_path], ['/mnt/pgarca/prod/prod1-aa11bb/backup', '/mnt/pgarca/prod/prod1-aa11bb/wal'], 'same name, own directory');
    assert.equal(dv.wal_path, '/mnt/pgarca/dev/dev1-c2/wal');
    assert.equal(a1.wal_collision, undefined); assert.equal(a1.wal_shared_warning, undefined);
    // the more specific level wins, field by field
    await call('PUT', '/api/scoped/destination/assignments', 'admin', { scope: 'cluster', key: 'c2', value: { repoPath: '/data/dev/repo', walPath: '/data/dev/wal' } });
    assert.deepEqual([dOf('c2').repo_path, dOf('c2').base_dir], ['/data/dev/repo', undefined]);
    await call('PUT', '/api/scoped/destination/assignments', 'admin', { scope: 'cluster', key: 'c2', inherit: true });
    await call('PUT', '/api/scoped/destination/assignments', 'admin', { scope: 'global', value: { type: 'nfs', repoPath: '/mnt/old/repo', walPath: '/mnt/old/wal/{cluster}' } });
    await call('PUT', '/api/scoped/destination/assignments', 'admin', { scope: 'env', key: 'prod', value: { baseDir: '/mnt/new' } });
    assert.equal(dOf('c1').repo_path, '/mnt/new/prod/prod1-c1/backup'); assert.equal(dOf('c2').repo_path, '/mnt/old/repo');
    // the wizard's review: what a setting WOULD give each cluster, before saving (administrators only)
    const pv = await call('POST', '/api/destination/preview', 'admin', { scope: 'env', key: 'prod', value: { type: 'nfs', baseDir: '/mnt/b2', requireMount: true } });
    assert.equal(pv.status, 200);
    const p1 = pv.body.clusters.find((x: any) => x.id === 'c1'); assert.equal(p1.repo_path, '/mnt/b2/prod/prod1-c1/backup'); assert.equal(p1.affected, true);
    assert.equal(pv.body.clusters.find((x: any) => x.id === 'c2').affected, false);
    assert.equal(destinationFor(store.peek(), store.peek().clusters.find((x: any) => x.id === 'c1')).dest!.repo_path, '/mnt/new/prod/prod1-c1/backup', 'nothing saved');
    assert.equal((await call('POST', '/api/destination/preview', 'operator', { scope: 'global', value: { baseDir: '/x' } })).status, 403);
    assert.equal((await call('POST', '/api/destination/preview', 'admin', { scope: 'global', value: { baseDir: '/x', walPath: '/y' } })).status, 400);
    // remembered once applied: a renamed cluster keeps writing where its history is
    await store.mutate(d => { d.settings.destinationApplied = { c1: { dirName: 'prod/prod1-c1', baseDir: '/mnt/new' } }; (d.clusters.find((x: any) => x.id === 'c1') as any).name = 'renamed'; });
    assert.equal(dOf('c1').repo_path, '/mnt/new/prod/prod1-c1/backup');
    await store.mutate(d => { d.settings.scoped = st0.settings.scoped; d.settings.destinationApplied = st0.settings.destinationApplied; d.clusters = d.clusters.filter((x: any) => x.id !== 'cl_aa11bb22cc33'); (d.clusters.find((x: any) => x.id === 'c1') as any).name = 'prod1'; });
  }
  console.log('storage.test OK');
})().catch(e => { console.error(e); process.exit(1); });
