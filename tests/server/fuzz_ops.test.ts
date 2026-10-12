/**
 * Malformed and hostile input against the console's operation API: for every operation type, random parameters (wrong types, huge strings, nulls, arrays,
 * nested objects, path traversal, SQL/shell metacharacters, extreme numbers). The validator must never THROW (a 500 is a bug), the route must answer
 * 4xx/2xx, and nothing invalid may reach an agent's queue. Seeded and reproducible: FUZZ_SEED=<n>.
 */
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { mountOperatorRoutes } from '../../server/agents';
import { OP_SPECS, validateOp } from '../../server/optypes';

const SEED = Number(process.env.FUZZ_SEED || Math.floor(Math.random() * 1e9));
let s = SEED;
const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const STR = ['', ' ', 'x', '../../etc/passwd', '/etc/shadow', "'; DROP TABLE t; --", '$(rm -rf /)', '`id`', 'a\nb', '\u0000', 'é漢字🙂', 'RIAVVIA', 'ELIMINA', 'INSTALL',
  'x'.repeat(10000), 'replace', 'as_new', 'missing_only', 'full', 'incr', 'pgarca_stage_x', 'db.schema.table', '"a.b"."c"', '2026-10-12 10:00:00+02', 'now', '0/1000000', '-1', 'NaN', 'Infinity'];
const val = (depth = 0): any => {
  const k = Math.floor(rnd() * 10);
  if (depth > 2) return pick(STR);
  switch (k) {
    case 0: return null; case 1: return undefined; case 2: return pick([0, -1, 1, 2 ** 53, -(2 ** 53), 1e308, NaN, Infinity, 0.5]);
    case 3: return pick([true, false]); case 4: return [val(depth + 1), val(depth + 1)];
    case 5: return { [pick(['a', 'host', 'port', 'path', '__proto__', 'constructor'])]: val(depth + 1) };
    default: return pick(STR);
  }
};
const KEYS = ['type', 'set', 'database', 'object', 'objects', 'target_time', 'target_lsn', 'target_xid', 'target_name', 'new_name', 'stage_db', 'mode', 'into', 'destination',
  'dry_run', 'confirm', 'name', 'value', 'force', 'source_repo', 'source_wal', 'throttle_mb_s', 'retention_full', 'list', 'rules', 'major', 'delete_keys', 'restore_keys',
  'action', 'tablespace_remap', 'set', 'jobs', 'limit', 'hours', 'mode', 'min_rows', 'abandon', 'keep_archiving', 'create_missing_roles', 'repo_path', 'wal_path', 'bench'];
const params = (): any => {
  const k = Math.floor(rnd() * 12);
  if (k === 0) return null; if (k === 1) return 'string params'; if (k === 2) return [1, 2]; if (k === 3) return 42;
  const o: any = {};
  for (let i = 0; i < 1 + Math.floor(rnd() * 6); i++) o[pick(KEYS)] = val();
  return o;
};

(async () => {
  console.log(`fuzz ops seed=${SEED} (replay: FUZZ_SEED=${SEED})`);
  // 1. the validator never throws, whatever it gets
  const types = Object.keys(OP_SPECS);
  for (let i = 0; i < 6000; i++) {
    const t = pick(types); const p = params();
    try { const r = validateOp(t, p); assert(r === null || typeof r === 'string', `validator of ${t} returned ${typeof r}`); }
    catch (e: any) { assert.fail(`validateOp('${t}', ${JSON.stringify(p)?.slice(0, 300)}) THREW: ${e.message}  (FUZZ_SEED=${SEED})`); }
  }
  // 2. the HTTP route never answers 5xx and never queues something the validator refuses
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'fz-'))); const app = new MiniApp();
  mountOperatorRoutes(app, store, {});
  await store.mutate(d => {
    d.clusters.push({ id: 'c1', name: 'c1', environment: 'dev', source: 'agent', haState: { nodes: [] } } as any);
    d.nodes.n1 = { id: 'n1', name: 'n1', clusterId: 'c1', lastSeen: new Date().toISOString(), snapshot: { postgres: { alive: true, is_in_recovery: false } } } as any;
  });
  for (let i = 0; i < 1500; i++) {
    const t = rnd() < 0.9 ? pick(types) : pick(STR); const body: any = rnd() < 0.05 ? pick([null, 'x', [], 7]) : { type: t, params: params(), ...(rnd() < 0.2 ? { nodeId: val(), ttlSeconds: val() } : {}) };
    let r: any;
    try { r = await app.call('POST', '/api/clusters/c1/operations', { body, headers: { 'idempotency-key': `k${i}` } }); }
    catch (e: any) { assert.fail(`route THREW for ${JSON.stringify(body)?.slice(0, 300)}: ${e.message}  (FUZZ_SEED=${SEED})`); }
    assert(r.status < 500, `HTTP ${r.status} for ${JSON.stringify(body)?.slice(0, 300)}: ${JSON.stringify(r.body)?.slice(0, 300)}  (FUZZ_SEED=${SEED})`);
    if (r.status === 202 && r.body?.operation) {
      const op = r.body.operation;
      assert.equal(validateOp(op.type, op.params), null, `queued an operation its own validator refuses: ${JSON.stringify(op).slice(0, 300)}`);
    }
  }
  console.log('fuzz ops OK');
})().catch(e => { console.error(e); process.exit(1); });
