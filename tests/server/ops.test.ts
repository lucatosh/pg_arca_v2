import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { Store } from '../../server/store';
import * as ops from '../../server/ops';
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const st = new Store(dir);
  // idempotent submit
  const a = await ops.submit(st, { type:'pg_reload', clusterId:'c1', nodeId:'n1', idempotencyKey:'k1' });
  const b = await ops.submit(st, { type:'pg_reload', clusterId:'c1', nodeId:'n1', idempotencyKey:'k1' });
  assert(a.created && !b.created && a.op.id===b.op.id);
  await assert.rejects(ops.submit(st,{type:'other',clusterId:'c1',idempotencyKey:'k1'}), /idempotency/);
  // concurrent submits with same key => single op
  const rs = await Promise.all([1,2,3,4,5].map(()=>ops.submit(st,{type:'wal_switch',clusterId:'c2',nodeId:'n2',idempotencyKey:'same'})));
  assert.strictEqual(new Set(rs.map(r=>r.op.id)).size,1); assert.strictEqual(rs.filter(r=>r.created).length,1);
  // lease: one in-flight per cluster
  await ops.submit(st,{type:'x',clusterId:'c1',nodeId:'n1',idempotencyKey:'k2'});
  const l1 = await ops.lease(st,'n1',5); assert.strictEqual(l1.length,1); assert.strictEqual(l1[0].id,a.op.id);
  assert.strictEqual((await ops.lease(st,'n1',5)).length,0, 'cluster busy');
  assert.strictEqual((await ops.lease(st,'wrong',5)).length,0);
  // report monotonic / idempotent
  assert((await ops.report(st,'n1',a.op.id,'running')).ok);
  assert((await ops.report(st,'n1',a.op.id,'succeeded',{x:1})).ok);
  assert((await ops.report(st,'n1',a.op.id,'succeeded',{x:1})).ok);       // duplicate
  assert(!(await ops.report(st,'n1',a.op.id,'failed','boom')).ok);        // conflicting
  assert(!(await ops.report(st,'other',a.op.id,'succeeded')).ok);
  // next op now deliverable
  const l2 = await ops.lease(st,'n1',5); assert.strictEqual(l2.length,1);
  // lease expiry redelivers, then fails after max attempts
  let now = Date.now();
  for (let i=0;i<ops.MAX_ATTEMPTS+1;i++){ now += 10*60*1000; await ops.lease(st,'n1',1,60,now); }
  const o2 = st.peek().operations.find(o=>o.id===l2[0].id)!; assert.strictEqual(o2.status,'failed');
  // ttl expiry
  const e = await ops.submit(st,{type:'switchover',clusterId:'c9',nodeId:'n9',idempotencyKey:'old',ttlSeconds:10});
  await ops.lease(st,'n9',1,60,Date.now()+60000);
  assert.strictEqual(st.peek().operations.find(o=>o.id===e.op.id)!.status,'expired');
  // cancel
  const c = await ops.submit(st,{type:'t',clusterId:'c7',nodeId:'n7',idempotencyKey:'cc'});
  assert((await ops.cancel(st,c.op.id)).ok); assert((await ops.cancel(st,c.op.id)).ok);
  // runLocal replay
  let runs=0; const f=()=>ops.runLocal(st,{type:'reload',clusterId:'c5',idempotencyKey:'loc'},async()=>{runs++;return {ok:1}});
  const [r1,r2]=await Promise.all([f(),f()]); await f(); assert.strictEqual(runs,1); assert.strictEqual(r1.op.id,r2.op.id);
  // persistence + corruption recovery
  const st2 = new Store(dir); assert.strictEqual(st2.peek().operations.length, st.peek().operations.length);
  fs.writeFileSync(path.join(dir,'state.json'),'{corrupt'); const st3=new Store(dir); assert(st3.peek().operations.length>0);
  // failed mutate commits nothing
  const before=st.peek().operations.length; await assert.rejects(st.mutate(d=>{d.operations.push({} as any); throw new Error('x');}));
  assert.strictEqual(st.peek().operations.length,before);
  console.log('ALL OPS TESTS PASSED');
  // history retention: default 7 days, configurable, never touches running work
  {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'st-')); const s2 = new Store(d2); const DAY = 86400000; const t = Date.now();
    assert.strictEqual(ops.retentionDays(s2.peek().settings), 7);
    await s2.mutate((d: any) => {
      const mk = (id: string, status: string, ageDays: number) => ({ id, type: 'backup_run', clusterId: 'c', params: {}, status, createdAt: new Date(t - ageDays * DAY).toISOString(), updatedAt: new Date(t - ageDays * DAY).toISOString(), createdBy: 'x', attempts: 1, ttlSeconds: 1, history: [] });
      d.operations.push(mk('old-ok', 'succeeded', 8), mk('old-fail', 'failed', 7.5), mk('edge', 'succeeded', 6.9), mk('new', 'succeeded', 0.1), mk('old-running', 'running', 30));
    });
    assert(ops.prunable(s2.peek(), t));
    await s2.mutate((d: any) => { ops.pruneOps(d, t); });
    assert.deepStrictEqual(s2.peek().operations.map((o: any) => o.id).sort(), ['edge', 'new', 'old-running']);
    await s2.mutate((d: any) => { d.settings.activity = { retentionDays: 1 }; ops.pruneOps(d, t); });
    assert.deepStrictEqual(s2.peek().operations.map((o: any) => o.id).sort(), ['new', 'old-running']);
    for (const bad of [0, 91, 'x', null, 1.5]) { const x: any = { activity: { retentionDays: bad } }; assert.strictEqual(ops.retentionDays(x), bad === 1.5 ? 1 : 7); }
  }
  // analysis lane: a WAL analysis never waits behind a backup (and a backup never behind an analysis); two analyses on one cluster do queue
  {
    const s3 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'st-')));
    await ops.submit(s3, { type: 'backup_run', clusterId: 'c9', nodeId: 'n9', idempotencyKey: 'l1' });
    await ops.submit(s3, { type: 'wal_forensics', clusterId: 'c9', nodeId: 'n9', idempotencyKey: 'l2' });
    await ops.submit(s3, { type: 'wal_forensics', clusterId: 'c9', nodeId: 'n9', idempotencyKey: 'l3', params: { hours: 1 } });
    await ops.submit(s3, { type: 'pg_reload', clusterId: 'c9', nodeId: 'n9', idempotencyKey: 'l4' });
    const got = await ops.lease(s3, 'n9', 5);
    assert.deepStrictEqual(got.map(o => o.type).sort(), ['backup_run', 'pg_reload', 'wal_forensics']);
    assert.strictEqual((await ops.lease(s3, 'n9', 5)).length, 0, 'the second analysis waits for the first');
    const { validateOp } = await import('../../server/optypes');
    assert.strictEqual(validateOp('wal_forensics', { mode: 'databases', hours: 0 }), null);
    assert.ok(validateOp('wal_forensics', { mode: 'x' }) && validateOp('wal_forensics', { hours: -1 }) && validateOp('wal_forensics', { limit: 0 }));
    // swapping restored tables in for the originals needs the explicit confirmation (the preview and the other modes do not)
    const pr = { stage_db: 'pgarca_stage_1', object: 'app.public.orders' };
    assert.ok(validateOp('restore_promote', { ...pr, mode: 'replace' }));
    assert.strictEqual(validateOp('restore_promote', { ...pr, mode: 'replace', confirm: 'SOSTITUISCI' }), null);
    assert.strictEqual(validateOp('restore_promote', { ...pr, mode: 'replace', dry_run: true }), null);
    assert.strictEqual(validateOp('restore_promote', { ...pr, mode: 'as_new' }), null);
    // whole server back IN PLACE: typed confirmation, no copy options; kept directories only by their exact name
    assert.ok(validateOp('restore_instance', { replace_production: true }));
    assert.strictEqual(validateOp('restore_instance', { replace_production: true, confirm: 'REPLACE' }), null);
    assert.strictEqual(validateOp('restore_instance', { replace_production: true, confirm: 'SOSTITUISCI' }), null, 'the Italian word of earlier consoles is still accepted');
    assert.ok(validateOp('pg_restart', { confirm: 'restart' }), 'confirmation words are exact');
    assert.strictEqual(validateOp('pg_restart', { confirm: 'RESTART' }), null);
    assert.strictEqual(validateOp('restore_instance', { replace_production: true, dry_run: true }), null);
    assert.ok(validateOp('restore_instance', { replace_production: true, confirm: 'SOSTITUISCI', destination: '/x' }));
    assert.ok(validateOp('restore_instance', { replace_production: true, confirm: 'SOSTITUISCI', action: 'pause' }));
    assert.strictEqual(validateOp('restore_kept_drop', { path: '/var/lib/pg/16/main.pgarca-before-20261014101010', confirm: 'main.pgarca-before-20261014101010' }), null);
    assert.ok(validateOp('restore_kept_drop', { path: '/var/lib/pg/16/main', confirm: 'main' }));
    assert.ok(validateOp('restore_kept_drop', { path: '/var/lib/pg/16/main.pgarca-before-20261014101010', confirm: 'x' }));
    // operation log: phase changes are lines, counters of the same phase are throttled
    const id = got.find(o => o.type === 'backup_run')!.id;
    await ops.report(s3, 'n9', id, 'running', undefined, undefined, 120, { phase: 'checkpoint' });
    await ops.report(s3, 'n9', id, 'running', undefined, undefined, 120, { phase: 'checkpoint', elapsed_sec: 2 });
    await ops.report(s3, 'n9', id, 'running', undefined, undefined, 120, { phase: 'copy', files: 1, files_total: 10 });
    const op = s3.peek().operations.find((o: any) => o.id === id)!;
    assert.deepStrictEqual((op.log || []).map(l => l.text.split(' · ')[0]), ['PostgreSQL checkpoint', 'Copying data']);   // phases in words
    assert.ok((op.log || [])[1].text.includes('1 of 10 files (10%)'), (op.log || [])[1].text);
    const tl = ops.opTimeline(op);
    assert.ok(tl.some(x => x.kind === 'status') && tl.some(x => x.kind === 'log') && tl.every((x, i) => i === 0 || tl[i - 1].at <= x.at));
    // a large result lives in a side file: the state keeps a summary (scalars included), the API gives back the whole thing, pruning removes the file
    const rdir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-')); ops.setResultsDir(rdir);
    const big = { ok: true, set: 'S1', tables: Array.from({ length: 6000 }, (_, i) => ({ schema: 's', name: 'table_' + i, size: i })) };
    await ops.report(s3, 'n9', id, 'succeeded', big);
    const done = s3.peek().operations.find((o: any) => o.id === id)!;
    assert.strictEqual(done.result.ok, true); assert.strictEqual(done.result.set, 'S1'); assert(done.result._offloaded); assert(!done.result.tables);
    assert(JSON.stringify(s3.peek()).length < 100_000, 'the state stays small');
    assert.strictEqual(ops.withResult(done).result.tables.length, 6000);
    await s3.mutate((d: any) => { d.settings.activity = { retentionDays: 1 }; for (const o of d.operations) if (o.id === id) o.updatedAt = new Date(Date.now() - 3 * 86400e3).toISOString(); ops.pruneOps(d); });
    assert.strictEqual(fs.readdirSync(rdir).length, 0, 'pruned with its operation');
    ops.setResultsDir(null);
  }
})().catch(e=>{console.error(e);process.exit(1)});
