/** A real Express app: an async route that throws answers a JSON 500 (it used to hang until the browser timed out); bad JSON is a JSON 400. */
import assert from 'node:assert/strict';
import http from 'http';
import { makeAsyncSafe, asyncErrorHandler } from '../../server/asyncsafe';

(async () => {
  // 1. the wrapper alone (no Express needed): every handler shape reaches next(err)
  const reg: Record<string, any[]> = {};
  const fake: any = { settings: { s: 1 } }; for (const m of ['get', 'post', 'put', 'patch', 'delete', 'all']) fake[m] = (...a: any[]) => (a.length === 1 ? fake.settings[a[0]] : (reg[m + ' ' + a[0]] = a.slice(1)));
  makeAsyncSafe(fake);
  assert.equal(fake.get('s'), 1, 'app.get(setting) untouched');
  fake.get('/a', async () => { throw new Error('async'); }); fake.post('/b', () => { throw new Error('sync'); }); fake.put('/c', (_q: any, r: any) => r.done = true);
  const errMw = (e: any, _q: any, _r: any, _n: any) => e; fake.all('/d', errMw);
  const got: any[] = []; const next = (e?: any) => got.push(e);
  await reg['get /a'][0]({}, {}, next); await new Promise(r => setImmediate(r)); assert.equal(got.pop()?.message, 'async');
  reg['post /b'][0]({}, {}, next); assert.equal(got.pop()?.message, 'sync');
  const res: any = {}; reg['put /c'][0]({}, res, next); assert.equal(res.done, true); assert.equal(got.length, 0);
  assert.equal(reg['all /d'][0], errMw, 'error middleware (4 arguments) is left as it is');
  let express: any; try { express = (await import('express')).default; } catch { console.log('asyncsafe: wrapper OK; express not installed here, the real-Express part did not run'); return; }
  const app = express(); app.use(express.json());
  makeAsyncSafe(app);
  app.set('x-setting', 'v'); assert.equal(app.get('x-setting'), 'v', 'app.get(setting) still reads settings');
  app.get('/api/async-throws', async () => { await new Promise(r => setTimeout(r, 5)); throw new Error('store write failed'); });
  app.get('/api/sync-throws', () => { throw new Error('boom'); });
  app.post('/api/ok', async (req, res) => { await new Promise(r => setTimeout(r, 5)); res.json({ got: req.body }); });
  app.get('/api/multi', (_q, _r, next) => next(), async (_q, res) => { res.json({ second: true }); });
  app.use('/api', asyncErrorHandler);
  const srv = http.createServer(app); await new Promise<void>(r => srv.listen(0, r));
  const port = (srv.address() as any).port;
  const call = async (m: string, u: string, body?: string) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 3000);
    try { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: m, body, headers: body ? { 'content-type': 'application/json' } : {}, signal: ac.signal }); return { status: r.status, body: await r.json() }; } finally { clearTimeout(t); } };
  const origErr = console.error; console.error = () => undefined;
  try {
    let r = await call('GET', '/api/async-throws'); assert.equal(r.status, 500); assert.match(r.body.message, /store write failed/);
    r = await call('GET', '/api/sync-throws'); assert.equal(r.status, 500); assert.equal(r.body.error, 'internal_error');
    r = await call('POST', '/api/ok', '{"a":1}'); assert.deepEqual(r, { status: 200, body: { got: { a: 1 } } });
    r = await call('POST', '/api/ok', '{bad'); assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_json');
    r = await call('GET', '/api/multi'); assert.deepEqual(r.body, { second: true });
  } finally { console.error = origErr; srv.close(); }
  console.log('asyncsafe OK');
})().catch(e => { console.error(e); process.exit(1); });
