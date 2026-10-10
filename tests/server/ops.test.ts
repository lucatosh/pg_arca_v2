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
})().catch(e=>{console.error(e);process.exit(1)});
