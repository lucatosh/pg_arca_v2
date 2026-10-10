import assert from 'assert';
import { reconcileCluster } from '../../server/agents';

const mk = () => ({
  clusters: [
    { id: 'cl-a', name: 'arca-lab', createdAt: '2026-01-01T00:00:00Z', isSandbox: false, databases: [], hbaRules: [], features: {} },
    { id: 'cl-b', name: 'arca-lab', createdAt: '2026-01-01T00:01:00Z', isSandbox: false, databases: [], hbaRules: [], features: {} },
    { id: 'cl-c', name: 'arca-lab', createdAt: '2026-01-01T00:02:00Z', isSandbox: false, databases: [], hbaRules: [], features: {} },
    { id: 'cl-other', name: 'other', clusterKey: 'patroni:other', createdAt: '2026-01-01T00:00:00Z', isSandbox: false, databases: [], hbaRules: [], features: {} },
    { id: 'cl-demo', name: 'demo', clusterKey: 'patroni:arca-lab', isSandbox: true, databases: [], hbaRules: [], features: {} },
  ] as any[],
  nodes: {
    n1: { id: 'n1', name: 'pg1', clusterId: 'cl-a', snapshot: { cluster_key: 'patroni:arca-lab' } },
    n2: { id: 'n2', name: 'pg2', clusterId: 'cl-b', snapshot: { cluster_key: 'patroni:arca-lab' } },
    n3: { id: 'n3', name: 'pg3', clusterId: 'cl-c', snapshot: { cluster_key: 'patroni:arca-lab' } },
  } as any,
  operations: [{ id: 'op1', clusterId: 'cl-b' }] as any[], audit: [] as any[], directConnections: {} as any, settings: { policyAssignments: { 'cluster:cl-c': { disabled: true } } } as any,
});

// 1. each node adopts the key; the last one triggers the merge into the cluster with history (cl-b)
const d: any = mk();
reconcileCluster(d, 'n1');
assert.equal(d.clusters.find((c: any) => c.id === 'cl-a')?.clusterKey, 'patroni:arca-lab', 'first heartbeat: the cluster adopts the key, no duplicate has one yet');
// cl-a adopted the key above; now cl-b sees a duplicate
reconcileCluster(d, 'n2');
assert.ok(!d.clusters.some((c: any) => c.id === 'cl-a'), 'cl-a merged away');
assert.equal(d.nodes.n1.clusterId, 'cl-b'); assert.equal(d.nodes.n2.clusterId, 'cl-b');
reconcileCluster(d, 'n3');
assert.deepEqual(d.clusters.filter((c: any) => !c.isSandbox && c.clusterKey === 'patroni:arca-lab').map((c: any) => c.id), ['cl-b']);
assert.ok(d.clusters.some((c: any) => c.id === 'cl-demo') && d.clusters.some((c: any) => c.id === 'cl-other'), 'sandbox and unrelated clusters untouched');
assert.deepEqual(Object.values(d.nodes).map((n: any) => n.clusterId), ['cl-b', 'cl-b', 'cl-b']);
assert.equal(d.operations[0].clusterId, 'cl-b');
assert.deepEqual(d.settings.policyAssignments['cluster:cl-b'], { disabled: true }, 'policy assignment moved'); assert.ok(!d.settings.policyAssignments['cluster:cl-c']);
assert.ok(d.audit.some((a: any) => a.action === 'cluster.merge'));

// 2. hostile / malformed keys are ignored
const e: any = mk(); e.nodes.n1.snapshot.cluster_key = '__proto__\nx'; reconcileCluster(e, 'n1'); assert.equal(e.clusters[0].clusterKey, undefined);
e.nodes.n1.snapshot.cluster_key = { a: 1 }; reconcileCluster(e, 'n1'); assert.equal(e.clusters[0].clusterKey, undefined);

// 3. a cluster that already has another identity is never overwritten or merged
const f: any = mk(); f.clusters[0].clusterKey = 'sysid:1'; reconcileCluster(f, 'n1'); assert.equal(f.clusters[0].clusterKey, 'sysid:1'); assert.equal(f.clusters.length, 5);
console.log('reconcile tests OK');
