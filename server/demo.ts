/** The one clearly-labelled demo cluster of a fresh install. Operations on it are refused by the API; it can be deleted and restored once. */
export const DEMO_CLUSTER_ID = 'cluster-demo';
export function buildDemoCluster() {
  const node = (name: string, role: string, state: string, host: string, lag: number, cpu: number, mem: number, conn: number) => ({
    name, role, state, host, port: 5432, timeline: 3, lsn: '0/1F8A9B20', replicationLagBytes: lag, replicationLagMs: lag ? 3 : 0, dcsLeader: role === 'primary',
    cpuPercent: cpu, memoryPercent: mem, connections: conn, maxConnections: 500, online: true, source: 'agent',
  });
  return {
    id: DEMO_CLUSTER_ID, name: 'DEMO · pg-demo-cluster', environment: 'dev', isSandbox: true, source: 'demo', pgVersion: '16.4', status: 'healthy',
    tps: 4280, totalSizeBytes: 4_350_000_000, activeTimeline: 3, currentLSN: '0/1F8A9B20',
    databases: [{ oid: '16384', name: 'billing', size: 1_450_000_000, schemas: [] }, { oid: '16385', name: 'crm', size: 2_100_000_000, schemas: [] }, { oid: '16386', name: 'analytics', size: 800_000_000, schemas: [] }],
    haState: { clusterName: 'pg-demo-ha', dcsType: 'etcd', dcsEndpoint: '', failoverMode: 'auto', maintenanceMode: false, activeTimeline: 3, managedByPatroni: false,
      nodes: [node('pg-node-01', 'primary', 'running', '10.0.2.11', 0, 24, 62, 184), node('pg-node-02', 'sync_standby', 'streaming', '10.0.2.12', 304, 18, 59, 62), node('pg-node-03', 'replica', 'streaming', '10.0.2.13', 768, 12, 54, 45)] },
    hbaRules: [], ldapConfig: { enabled: false }, features: {},
  };
}
