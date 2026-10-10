// Pure log buffering + policy (no sockets): see the comment below. Kept separate so it can be tested and imported by the agent gateway.
export interface LiveLogEntry {
  id: string;
  timestamp: string;
  clusterId: string;
  clusterName: string;
  nodeName: string;
  nodeHost: string;
  service: 'patroni' | 'postgres' | 'wal_archiver' | 'agent' | 'etcd';
  level: 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'DEBUG';
  message: string;
  raw: string;
  details?: Record<string, any>;
}

/**
 * Log policy (scales with the number of clusters):
 *  - one bounded ring per cluster (a noisy cluster can never evict another one's history) + a separate WARN+ ring, so errors survive INFO noise;
 *  - a cluster is "watched" only while somebody has a live, un-paused subscription on it (or on "all"): agents are told so in every
 *    reply and ship the full stream only then, otherwise just WARN and above (the rest stays in the agent's small local backfill buffer);
 *  - fan-out to browsers is batched (one frame every FLUSH_MS) and drops the oldest entries of a slow consumer instead of queueing without bound.
 */
const RING_ALL = 400;
const RING_ALERTS = 200;
export const FLUSH_MS = 250;
export const MAX_QUEUE = 600;
export const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const WATCH_LINGER_MS = 60_000;                      // keep shipping a little after the last viewer left: no flapping when switching page
const rings = new Map<string, LiveLogEntry[]>();
const alertRings = new Map<string, LiveLogEntry[]>();
const lastWatched = new Map<string, number>();       // clusterId -> ms of the last time a viewer needed the full stream
let watchAll = 0;
export const LEVEL_SEVERITY: Record<string, number> = {
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5
};


let seq = 0;
function push(map: Map<string, LiveLogEntry[]>, key: string, e: LiveLogEntry, cap: number) {
  let r = map.get(key);
  if (!r) { r = []; map.set(key, r); }
  r.push(e);
  if (r.length > cap + 50) r.splice(0, r.length - cap);          // trim in blocks: no O(n) shift per entry
}

/** Store an entry in its cluster's rings. Returns it with its id. */
export function recordLog(entryData: Omit<LiveLogEntry, 'id'>): LiveLogEntry {
  const entry: LiveLogEntry = { id: `log-${Date.now()}-${String(seq++).padStart(9, '0')}`, ...entryData };
  push(rings, entry.clusterId, entry, RING_ALL);
  if ((LEVEL_SEVERITY[entry.level] || 0) >= LEVEL_SEVERITY.WARN) push(alertRings, entry.clusterId, entry, RING_ALERTS);
  return entry;
}

/** Viewer bookkeeping, recomputed from the live subscriptions by logs.ts. */
export function setWatching(all: number, clusterIds: Iterable<string>) {
  watchAll = all;
  const now = Date.now();
  for (const id of clusterIds) lastWatched.set(id, now);
}

/** What an agent of this cluster should ship right now: 'full' while somebody looks at its logs, otherwise 'alerts' (WARN and above). */
export function logModeFor(clusterId: string | undefined | null): 'full' | 'alerts' {
  if (watchAll > 0) return 'full';
  if (!clusterId) return 'alerts';
  const t = lastWatched.get(clusterId);
  return t && Date.now() - t < WATCH_LINGER_MS ? 'full' : 'alerts';
}

/** Entries for a viewer: chronological, newest `n`, same filters as the live stream (a cluster filter must never leak other clusters' lines). */
export function recent(filter: (e: LiveLogEntry) => boolean, n: number): LiveLogEntry[] {
  const out: LiveLogEntry[] = [];
  const seen = new Set<string>();
  for (const map of [rings, alertRings]) for (const r of map.values()) for (const e of r) if (!seen.has(e.id) && filter(e)) { seen.add(e.id); out.push(e); }
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out.slice(-n);
}
