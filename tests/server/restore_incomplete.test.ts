// A database still marked "restore in progress" (comment set by the agent while pg_restore fills it) with no restore running = interrupted, incomplete copy.
import assert from 'assert';
import { evaluate } from '../../server/health';
const now = Date.now(); const iso = new Date(now).toISOString();
const st: any = {
  settings: {}, operations: [],
  clusters: [{ id: 'c1', name: 'prod1', environment: 'prod', source: 'agent' }],
  nodes: { n1: { id: 'n1', name: 'db1', clusterId: 'c1', lastSeen: iso, snapshot: { postgres: { alive: true, is_in_recovery: false, databases: [{ oid: 5, name: 'postgres' }, { oid: 16500, name: 'shop_restored', restoring: true }] } } } },
};
const k = (s: any) => evaluate(s, now).filter(i => i.code === 'restore_incomplete');
assert.strictEqual(k(st).length, 1); assert.match(k(st)[0].title, /shop_restored/);
st.operations.push({ id: 'o1', type: 'restore_database', clusterId: 'c1', status: 'running', params: { new_name: 'shop_restored' } });
assert.strictEqual(k(st).length, 0, 'while the restore runs it is not an incident');
console.log('restore_incomplete tests OK');
