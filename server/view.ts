/**
 * Derives the UI's cluster model from REAL telemetry (agent snapshots / direct polls).
 * Pure functions: no I/O, fully unit-tested. Nothing here invents values: unknown => null/0 + explicit flag.
 */
import type { NodeRecord } from './store';

export const OFFLINE_AFTER_MS = 45_000;

export function lsnToBig(lsn?: string | null): bigint | null {
  if (!lsn || !/^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/.test(lsn)) return null;
  const [h, l] = lsn.split('/');
  return (BigInt('0x' + h) << 32n) + BigInt('0x' + l);
}

export interface DerivedNode {
  name: string; role: 'primary' | 'sync_standby' | 'replica' | 'standby_leader'; state: string;
  host: string; port: number; timeline: number; lsn: string;
  replicationLagBytes: number; replicationLagMs: number; dcsLeader: boolean;
  cpuPercent: number; memoryPercent: number; connections: number; maxConnections: number;
  online: boolean; nodeId?: string; source: 'agent' | 'patroni' | 'direct';
}

function num(v: any, d = 0): number { const n = Number(v); return Number.isFinite(n) ? n : d; }

export function deriveNodes(nodes: NodeRecord[], now = Date.now()): DerivedNode[] {
  const withSnap = nodes.filter(n => n.snapshot);
  // the primary's replication view is the authority for lag / sync state
  const primarySnap = withSnap.map(n => n.snapshot).find(s => s?.postgres && s.postgres.is_in_recovery === false);
  const repl: any[] = primarySnap?.postgres?.replication || [];
  const primaryLsn = lsnToBig(primarySnap?.postgres?.current_lsn);
  const patroniMembers: any[] = withSnap.flatMap(n => n.snapshot?.patroni?.members || []);

  const agentNodes = nodes.map(n => {
    const s = n.snapshot || {};
    const pg = s.postgres || {};
    const pt = s.patroni || {};
    const online = !!n.lastSeen && now - Date.parse(n.lastSeen) < OFFLINE_AFTER_MS;
    const member = patroniMembers.find(m => m.name === n.name);
    const r = repl.find(x => x.application_name === n.name || (member && x.application_name === member.name));

    let role: DerivedNode['role'];
    const pr = (pt.local_node?.role || pt.role || '').toString();
    if (pr === 'leader' || pr === 'primary' || pr === 'master') role = 'primary';
    else if (pr === 'sync_standby' || pr === 'quorum_standby') role = 'sync_standby';
    else if (pr === 'standby_leader') role = 'standby_leader';
    else if (pr === 'replica') role = r?.sync_state === 'sync' ? 'sync_standby' : 'replica';
    else if (pg.is_in_recovery === false) role = 'primary';
    else role = r?.sync_state === 'sync' ? 'sync_standby' : 'replica';

    const nodeLsn = lsnToBig(pg.current_lsn);
    let lagBytes = num(r?.replay_lag_bytes, -1);
    if (lagBytes < 0) lagBytes = role !== 'primary' && primaryLsn !== null && nodeLsn !== null && primaryLsn >= nodeLsn ? Number(primaryLsn - nodeLsn) : 0;
    const sys = s.system || {};
    const ncpu = Math.max(1, num(sys.cpu_count, 1));
    return {
      name: n.name, role,
      state: !online ? 'offline' : (role === 'primary' ? (pg.alive === false ? 'down' : 'running') : (r?.state || pt.local_node?.state || (pg.alive ? 'running' : 'down'))),
      host: member?.host || n.remoteIp || '', port: num(member?.port || pg.port, 5432),
      timeline: num(pg.timeline, 0), lsn: pg.current_lsn || '', replicationLagBytes: lagBytes,
      replicationLagMs: num(r?.replay_lag_ms, 0), dcsLeader: role === 'primary' && !!pt.accessible,
      cpuPercent: Math.min(100, Math.round(num(sys.load_avg_1m) / ncpu * 100)),
      memoryPercent: Math.round(num(sys.memory_used_percent)),
      connections: num(pg.connections?.used), maxConnections: num(pg.connections?.max),
      online, nodeId: n.id, source: 'agent',
    };
  });
  // Cluster members that Patroni reports but that have no agent enrolled yet: show them (read-only, from Patroni's own view) so the cluster looks complete.
  const seen = new Set(nodes.map(n => n.name)); const extra: DerivedNode[] = [];
  for (const m of patroniMembers) {
    if (!m?.name || seen.has(m.name)) continue; seen.add(m.name);
    const pr = String(m.role || ''); const st = String(m.state || '');
    const role: DerivedNode['role'] = ['leader', 'primary', 'master'].includes(pr) ? 'primary' : pr === 'standby_leader' ? 'standby_leader' : pr === 'sync_standby' || pr === 'quorum_standby' ? 'sync_standby' : 'replica';
    const lag = num(m.lag, 0);
    extra.push({ name: m.name, role, state: st || 'unknown', host: m.host || '', port: num(m.port, 5432), timeline: num(m.timeline, 0), lsn: '',
      replicationLagBytes: lag, replicationLagMs: 0, dcsLeader: role === 'primary', cpuPercent: 0, memoryPercent: 0, connections: 0, maxConnections: 0,
      online: ['running', 'streaming'].includes(st), source: 'patroni' });
  }
  return agentNodes.concat(extra);
}

export function deriveCluster(opts: {
  id: string; name: string; environment: string; nodes: NodeRecord[]; prior?: any; now?: number;
}): any {
  const now = opts.now ?? Date.now();
  const dn = deriveNodes(opts.nodes, now);
  const primary = dn.find(n => n.role === 'primary' && n.online);
  const primaryRec = primary ? opts.nodes.find(n => n.id === primary.nodeId) : undefined;
  const pg = primaryRec?.snapshot?.postgres || {};
  const pt = primaryRec?.snapshot?.patroni || {};
  const anyOffline = dn.some(n => !n.online);
  const lagging = dn.some(n => n.role !== 'primary' && n.replicationLagBytes > 64 * 1024 * 1024);
  const status = !primary ? 'degraded' : (anyOffline || lagging ? 'degraded' : 'healthy');
  const prior = opts.prior || {};
  const dbs = (pg.databases || []).map((d: any) => {
    const old = (prior.databases || []).find((x: any) => x.name === d.name);
    return { oid: String(d.oid), name: d.name, size: num(d.size), schemas: old?.schemas || [] };
  });
  return {
    ...prior,
    id: opts.id, name: opts.name, environment: opts.environment, isSandbox: false, source: 'agent',
    pgVersion: pg.version || prior.pgVersion || '', status,
    tps: Math.round(dn.reduce((a, n) => a + num(opts.nodes.find(x => x.id === n.nodeId)?.tps), 0)),
    totalSizeBytes: dbs.reduce((a: number, d: any) => a + d.size, 0),
    activeTimeline: num(pg.timeline, prior.activeTimeline || 0), currentLSN: pg.current_lsn || '',
    databases: dbs,
    haState: {
      clusterName: pt.scope || opts.name,
      dcsType: pt.dcs_type || 'none', dcsEndpoint: Array.isArray(pt.dcs_hosts) ? pt.dcs_hosts.join(',') : (pt.dcs_hosts || ''),
      failoverMode: pt.scope ? 'auto' : 'manual',
      maintenanceMode: !!pt.paused,
      activeTimeline: num(pg.timeline, 0),
      nodes: dn,
      managedByPatroni: !!pt.scope,
    },
    hbaRules: prior.hbaRules || [],
    ldapConfig: prior.ldapConfig || { enabled: false, serverUrl: '', bindDN: '', baseDN: '', userFilter: '', groupFilter: '', sslVerify: true, syncIntervalMinutes: 0, lastSync: '', managedRolesCount: 0, managedGrantsCount: 0 },
    features: prior.features || {},
    liveAt: new Date(now).toISOString(),
  };
}

/** TPS from monotonically increasing xact counter; returns undefined on counter reset / first sample. */
export function computeTps(prev: { total: number; at: number } | undefined, total: number, at: number): number | undefined {
  if (!prev || total < prev.total || at <= prev.at) return undefined;
  return Math.round(((total - prev.total) / ((at - prev.at) / 1000)) * 10) / 10;
}
