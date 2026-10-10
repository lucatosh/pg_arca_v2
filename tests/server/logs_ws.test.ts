// Real WebSocket test of the log stream: per-cluster routing, no traffic before subscribe, batching, bounded queues, on-demand watching.
import assert from 'assert';
import http from 'http';
import { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { attachLogSocket, broadcastLiveLog } from '../../server/logs';
import { logModeFor } from '../../server/logring';

const base = { timestamp: new Date().toISOString(), nodeName: 'n', nodeHost: '', service: 'postgres' as const, raw: '' };
const log = (clusterId: string, message: string, level: any = 'INFO') => broadcastLiveLog({ ...base, clusterId, clusterName: clusterId, level, message });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = http.createServer(); attachLogSocket(server, req => (String(req.url).includes('deny') ? null : 'tester'));
  await new Promise<void>(r => server.listen(0, r)); const port = (server.address() as AddressInfo).port;
  const client = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/logs`); const frames: any[] = [];
    ws.on('message', d => frames.push(JSON.parse(d.toString()))); await new Promise(r => ws.once('open', r));
    return { ws, frames, send: (m: any) => ws.send(JSON.stringify(m)), entries: () => frames.filter(f => f.type === 'batch').flatMap(f => f.entries) };
  };

  log('c1', 'old c1 line'); log('c2', 'old c2 line');
  const a = await client(); const b = await client();
  log('c1', 'before subscribe'); await sleep(400);
  assert.strictEqual(a.frames.length, 0, 'nothing is sent (or watched) before the client subscribes');
  assert.strictEqual(logModeFor('c1'), 'alerts');

  a.send({ type: 'subscribe', clusterId: 'c1' }); b.send({ type: 'subscribe', clusterId: 'c2' }); await sleep(200);
  const initA = a.frames.find(f => f.type === 'init'); assert.ok(initA, 'subscribe answers with the backlog');
  assert.ok(initA.logs.every((l: any) => l.clusterId === 'c1') && initA.logs.some((l: any) => l.message === 'old c1 line'), 'backlog of that cluster only');
  assert.strictEqual(logModeFor('c1'), 'full'); assert.strictEqual(logModeFor('c2'), 'full'); assert.strictEqual(logModeFor('c3'), 'alerts', 'a cluster nobody looks at stays on alerts');

  log('c1', 'live c1'); log('c2', 'live c2'); log('c3', 'live c3'); await sleep(450);
  assert.deepStrictEqual(a.entries().map((e: any) => e.message), ['live c1']); assert.deepStrictEqual(b.entries().map((e: any) => e.message), ['live c2']);

  // a flood is batched and bounded: far fewer frames than lines, never an unbounded queue
  const before = a.frames.length;
  for (let i = 0; i < 5000; i++) log('c1', 'flood ' + i); await sleep(900);
  const got = a.entries().filter((e: any) => e.message.startsWith('flood')); const frames = a.frames.length - before;
  assert.ok(got.length > 0 && got.length <= 5000, 'received ' + got.length);
  assert.ok(frames <= 8, `5000 lines went out in ${frames} frames`);
  assert.ok(a.frames.some(f => f.type === 'batch' && f.dropped > 0), 'a consumer that cannot keep up is told how many lines were skipped');
  assert.strictEqual(got[got.length - 1].message, 'flood 4999', 'the newest lines are the ones kept');

  // pause = not watching, and nothing is sent
  a.send({ type: 'pause' }); await sleep(100); const n = a.frames.length; log('c1', 'while paused'); await sleep(400);
  assert.strictEqual(a.frames.length, n); a.send({ type: 'resume' }); await sleep(100);

  // unauthenticated sockets are refused
  const bad = new WebSocket(`ws://127.0.0.1:${port}/ws/logs?deny=1`); const code = await new Promise<number>(r => bad.on('close', c => r(c))); assert.strictEqual(code, 4401);

  // closing clients stops watching (after the linger) and frees the subscription
  a.ws.close(); b.ws.close(); await sleep(100);
  server.close(); console.log('logs ws: ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
