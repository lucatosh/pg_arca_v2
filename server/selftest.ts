/** Real self-checks of the control plane (no canned results). Each check actually executes. */
import fs from 'fs'; import os from 'os'; import path from 'path';
import { Store, encrypt, decrypt, sha256 } from './store';
import * as ops from './ops';
import { hashPassword, verifyPassword } from './auth';

export async function runSelfTest(): Promise<{ name: string; ok: boolean; detail?: string; ms: number }[]> {
  const out: { name: string; ok: boolean; detail?: string; ms: number }[] = [];
  const check = async (name: string, fn: () => Promise<void> | void) => {
    const t = Date.now();
    try { await fn(); out.push({ name, ok: true, ms: Date.now() - t }); }
    catch (e: any) { out.push({ name, ok: false, detail: e.message, ms: Date.now() - t }); }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-selftest-'));
  const st = new Store(dir);
  await check('state store: atomic write + reload', async () => {
    await st.mutate(d => { d.settings.x = 1; });
    if (new Store(dir).peek().settings.x !== 1) throw new Error('state not durable');
  });
  await check('state store: failed transaction commits nothing', async () => {
    await st.mutate(d => { d.settings.y = 1; throw new Error('boom'); }).catch(() => undefined);
    if (st.peek().settings.y !== undefined) throw new Error('partial commit');
  });
  await check('operations: idempotent submit under concurrency', async () => {
    const r = await Promise.all([1, 2, 3, 4].map(() => ops.submit(st, { type: 'pg_reload', clusterId: 'c', nodeId: 'n', idempotencyKey: 'k' })));
    if (new Set(r.map(x => x.op.id)).size !== 1) throw new Error('duplicate operations created');
  });
  await check('operations: one in-flight per cluster', async () => {
    await ops.submit(st, { type: 'wal_switch', clusterId: 'c', nodeId: 'n', idempotencyKey: 'k2' });
    const l = await ops.lease(st, 'n', 5);
    if (l.length !== 1) throw new Error(`expected 1 leased, got ${l.length}`);
  });
  await check('secrets: AES-256-GCM roundtrip + tamper detection', () => {
    const key = Buffer.alloc(32, 7); const enc = encrypt(key, 's3cret');
    if (decrypt(key, enc) !== 's3cret') throw new Error('roundtrip failed');
    let bad = false; try { decrypt(key, enc.slice(0, -2) + 'AA'); } catch { bad = true; }
    if (!bad) throw new Error('tampering not detected');
  });
  await check('auth: scrypt hash verify', () => {
    const h = hashPassword('correct horse battery'); if (!verifyPassword('correct horse battery', h) || verifyPassword('wrong', h)) throw new Error('verify mismatch');
  });
  await check('hashing: sha256 known vector', () => { if (sha256('abc') !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') throw new Error('bad sha256'); });
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
