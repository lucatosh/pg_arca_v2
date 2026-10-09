import assert from 'assert';
import { deriveCluster, computeTps, lsnToBig } from '../../server/view';
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
console.log('ALL VIEW TESTS PASSED');
