import assert from 'assert';
import { deriveCluster, computeTps, lsnToBig, sanitizeSnapshot } from '../../server/view';
const now = Date.now(), iso = new Date(now - 5000).toISOString();
const mk = (id: string, name: string, rec: boolean, lsn: string, extra: any = {}) => ({
  id, name, tokenHash: '', enrolledAt: iso, lastSeen: iso, remoteIp: '10.0.0.' + id.length,
  snapshot: { postgres: { alive: true, is_in_recovery: rec, current_lsn: lsn, timeline: 3, version: '16.4', port: 5432,
    connections: { used: 3, max: 100 }, databases: [{ oid: 1, name: 'a', size: 10 }],
    replication: rec ? [] : [{ application_name: 'n2', state: 'streaming', sync_state: 'sync', replay_lag_bytes: 100, replay_lag_ms: 3 }], ...extra },
    system: { load_avg_1m: 1, cpu_count: 4, memory_used_percent: 40 } },
}) as any;
const c = deriveCluster({ id: 'c', name: 'x', environment: 'prod', nodes: [mk('n1', 'n1', false, '0/2000000'), mk('n2', 'n2', true, '0/1FFFF00')], now });
assert.strictEqual(c.status, 'healthy');
assert.deepStrictEqual(c.haState.nodes.map((n: any) => n.role), ['primary', 'sync_standby']);
assert.strictEqual(c.haState.nodes[1].replicationLagBytes, 100);
assert.strictEqual(c.totalSizeBytes, 10); assert.strictEqual(c.pgVersion, '16.4'); assert.strictEqual(c.isSandbox, false);
const off = mk('n2', 'n2', true, '0/1'); off.lastSeen = new Date(now - 120000).toISOString();
assert.strictEqual(deriveCluster({ id: 'c', name: 'x', environment: 'prod', nodes: [mk('n1', 'n1', false, '0/2'), off], now }).status, 'degraded');
assert.strictEqual(deriveCluster({ id: 'c', name: 'x', environment: 'prod', nodes: [off], now }).status, 'degraded'); // no primary
assert.strictEqual(computeTps({ total: 100, at: 0 }, 300, 2000), 100);
assert.strictEqual(computeTps({ total: 100, at: 0 }, 50, 2000), undefined);
assert.strictEqual(lsnToBig('1/0'), 4294967296n);
// Patroni members without an agent still appear (source=patroni), the enrolled node keeps source=agent
const p1 = mk('n1', 'n1', false, '0/2000000'); p1.snapshot.patroni = { scope: 'lab', members: [
  { name: 'n1', role: 'leader', state: 'running', host: 'n1', port: 5432 }, { name: 'n2', role: 'replica', state: 'streaming', host: 'n2', port: 5432, lag: 0 }, { name: 'n3', role: 'replica', state: 'stopped', host: 'n3', port: 5432 }] };
const pc = deriveCluster({ id: 'c', name: 'x', environment: 'prod', nodes: [p1], now });
assert.deepStrictEqual(pc.haState.nodes.map((n: any) => [n.name, n.source, n.online]), [['n1', 'agent', true], ['n2', 'patroni', true], ['n3', 'patroni', false]]);
assert.strictEqual(pc.haState.nodes[1].role, 'replica'); assert.strictEqual(pc.haState.nodes[1].nodeId, undefined);
// hostile / broken telemetry must never throw
for (const bad of [{ postgres: { databases: 5, replication: 'x', slots: [null] }, patroni: { members: [null, 3, { name: 'z' }] } }, { postgres: 'x', patroni: 7, backup: [], system: 1 }, 'str', [], null]) {
  const sn = sanitizeSnapshot(bad); const nd: any = { ...mk('h1', 'h1', false, '0/1'), snapshot: sn };
  deriveCluster({ id: 'c', name: 'x', environment: 'prod', nodes: sn === undefined ? [] : [nd], now });
}
assert.deepStrictEqual(sanitizeSnapshot({ patroni: { members: [null, { name: 'z' }] } }).patroni.members, [{ name: 'z' }]);
console.log('ALL VIEW TESTS PASSED');
