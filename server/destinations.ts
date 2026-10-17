/**
 * Where backups and WAL archives are written, decided per scope (global > environment > folder > cluster, field by field) instead of per machine.
 *
 * What is real today: a local directory, or a network share (NFS / SMB-CIFS) that is MOUNTED on the nodes. The agents never mount anything: before a destination is applied,
 * each node checks it (destination_check): the path must really sit on the expected kind of filesystem, be writable the way the engine writes (exclusive create, fsync,
 * atomic rename) and have room. Object storage (S3, Azure, GCS) and SFTP need a native engine backend that does not exist yet: they are listed in the UI as "Preview"
 * and are refused here.
 *
 * Paths may contain {cluster} {env} {id}: one global value such as /mnt/backup/pgarca/{env}/{cluster}/wal gives every cluster its own directory. (A WAL archive MUST be
 * per cluster: two clusters writing the same segment names into one directory would overwrite each other.)
 */
import type { Request, Response } from 'express';
import { Store, NodeRecord } from './store';
import * as ops from './ops';
import { audit } from './ops';
import { registerKind, resolveScoped, KindSpec } from './scoped';
import { requiresApproval, requestApproval } from './approvals';
import { geoGroups } from './geo';
import { normFolder } from './policies';

export const DEST_TYPES = ['local', 'nfs', 'smb'] as const;
export const PREVIEW_TYPES = [
  { id: 's3', label: 'Amazon S3 / compatible (MinIO, Ceph RGW)' }, { id: 'azure', label: 'Azure Blob Storage' }, { id: 'gcs', label: 'Google Cloud Storage' }, { id: 'sftp', label: 'SFTP' },
];
export const DEST_DEFAULTS = { type: 'local', requireMount: false };
const slug = (s: any) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'cluster';

const destPath = (v: any, name: string): string => {
  const s = String(v ?? '');
  if (!s.startsWith('/') || /[\u0000-\u001f]/.test(s) || s.length > 300 || s.split('/').includes('..')) throw new Error(`${name}: an absolute path is required, without “..”`);
  const bad = s.replace(/\{(cluster|env|id)\}/g, '').match(/[{}]/);
  if (bad) throw new Error(`${name}: the allowed placeholders are {cluster}, {env} and {id}`);
  return s.replace(/\/+$/, '') || '/';
};

const destination: KindSpec = {
  defaults: DEST_DEFAULTS,
  validate(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'an object was expected' };
    const out: Record<string, any> = {};
    try {
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined || x === null || x === '') continue;
        switch (k) {
          case 'type':
            if (PREVIEW_TYPES.some(t => t.id === String(x))) throw new Error('This destination type is in preview: today the backup engine writes to a local directory or to a network share (NFS/SMB) mounted on the nodes.');
            if (!(DEST_TYPES as readonly string[]).includes(String(x))) throw new Error('invalid type');
            out[k] = x; break;
          case 'baseDir': {                                   // automatic layout: <baseDir>/<environment>/<cluster>/{backup,wal}, one directory per cluster
            const b = destPath(x, 'baseDir');
            if (/[{}]/.test(b)) throw new Error('baseDir: no placeholders - each cluster gets its own directory under it automatically');
            if (b === '/') throw new Error('baseDir: choose a dedicated directory, not /');
            out[k] = b; break;
          }
          case 'repoPath': out[k] = destPath(x, 'repoPath'); break;
          case 'walPath': out[k] = destPath(x, 'walPath'); break;
          case 'requireMount': out[k] = !!x; break;
          case 'server':                                      // the backup server (a worker host) that exports the share: the check proves the mount comes from it
            if (typeof x !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(x)) throw new Error('server: a worker host id was expected');
            out[k] = x; break;
          case 'serverPath': out[k] = destPath(x, 'serverPath'); break;   // the exported directory ON the backup server (for the export / mount instructions)
          case 'minFreeGb': { const n = Number(x); if (!Number.isFinite(n) || n < 0 || n > 1e6) throw new Error('minFreeGb: a number between 0 and 1000000'); out[k] = n; break; }
          default: throw new Error(`unknown field: ${k}`);
        }
      }
    } catch (e: any) { return { ok: false, error: e.message }; }
    if (out.baseDir && (out.repoPath || out.walPath)) return { ok: false, error: 'either a base directory (one directory per cluster, created automatically) or explicit repository / WAL directories, not both' };
    if (out.server && out.type && out.type === 'local') return { ok: false, error: 'a backup server is reached through a network share: choose NFS or SMB as the type' };
    if (out.repoPath && out.walPath && out.repoPath === out.walPath) return { ok: false, error: 'the repository and the WAL archive must be different directories' };
    return { ok: true, value: out };
  },
};
destination.mask = maskPaths;                               // (a hoisted function declaration, defined further down)
registerKind('destination', destination);

export interface ResolvedDestination { type: string; repo_path?: string; wal_path?: string; base_dir?: string; cluster_dir?: string; require_mount: boolean; min_free_gb?: number; wal_shared_warning?: string; wal_collision?: string;
  server?: { id: string; name: string | null; hosts: string[]; missing?: boolean; isBackupServer?: boolean }; server_path?: string }

/** Every name and address a worker host is known by (its node name, the address the console sees, what it reports about itself), lower-case, de-duplicated. */
export function hostsOf(n: any): string[] {
  const id = n?.snapshot?.worker?.identity || {};
  const all = [n?.name, n?.remoteIp, id.hostname, id.fqdn, ...((id.addresses || []) as any[])].map(x => String(x || '').trim().toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, ''))
    .filter(x => x && x !== 'localhost' && x !== 'localhost.localdomain' && !x.startsWith('127.') && x !== '::1');
  return [...new Set(all)].sort();
}

/** The worker host a mount's server part ("bk1", "bk1.lan", "10.0.0.9") points to, if any. Backup servers (role "repository") win over other workers. */
export function workerForHost(st: any, host?: string | null): any | null {
  if (!host) return null;
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  const isIp = (x: string) => /^[0-9.]+$/.test(x) || x.includes(':');
  // addresses match exactly; a short name matches an FQDN only when ONE side has no domain ("bk1" ~ "bk1.lan", never "bk1.lan" ~ "bk1.other.org")
  // a mount from "bk1.x.org" matches a host known only as "bk1", but not one whose own FQDN is "bk1.lan"
  const matches = (hosts: string[]) => {
    if (hosts.includes(h)) return true;
    if (isIp(h)) return false;
    const names = hosts.filter(x => !isIp(x));
    if (!h.includes('.')) return names.some(x => x.split('.')[0] === h);
    return !names.some(x => x.includes('.')) && names.includes(h.split('.')[0]);
  };
  const ws = (Object.values(st.nodes || {}) as any[]).filter(n => n.kind === 'worker')
    .sort((a, b) => Number((b.roles || []).includes('repository')) - Number((a.roles || []).includes('repository')));
  return ws.find(w => matches(hostsOf(w))) || null;
}
const expand = (p: string, c: any) => p.replace(/\{cluster\}/g, slug(c.name)).replace(/\{env\}/g, slug(c.environment)).replace(/\{id\}/g, slug(c.id));
const sysidOf = (st: any, cid: string) => Object.values(st.nodes || {}).map((n: any) => n.clusterId === cid ? n.snapshot?.postgres?.system_identifier : null).find(Boolean) || null;

/**
 * The cluster's own directory under a base directory: "<environment>/<cluster name>-<short id>" (readable on the share, unique even for two
 * clusters with the same name). STABLE: once applied, the name is remembered (a renamed cluster or one moved to another environment keeps
 * writing where its history is). The sites of one geo-redundant database share it on purpose (one WAL archive, one catalogue).
 */
export function clusterDir(st: any, c: any): string {
  const applied = (st.settings?.destinationApplied || {}) as Record<string, any>;
  if (applied[c.id]?.dirName) return applied[c.id].dirName;
  let owner = c;
  try {
    const g = geoGroups(st).find(x => x.sites.some(s => s.clusterId === c.id));
    if (g) {
      const ids = new Set(g.sites.map(s => s.clusterId));
      const done = [...ids].map(id => applied[id]?.dirName).find(Boolean);
      if (done) return done;
      owner = (st.clusters as any[]).find(x => ids.has(x.id)) || c;              // the first site the console knew
    }
  } catch { /* geo view unavailable: the cluster's own name */ }
  const short = String(owner.id || '').replace(/^[a-z]+_/, '').replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
  return `${slug(owner.environment || 'env')}/${slug(owner.name)}${short ? '-' + short : ''}`;
}

const RANK: Record<string, number> = { default: 0, global: 1, env: 2, folder: 3, cluster: 4 };
/** Repository and WAL directories of a cluster, as configured (no checks): a base directory gives <base>/<cluster dir>/backup and /wal; explicit
 *  paths are used as they are. Field by field, the more specific level wins (a base directory set for an environment beats explicit paths set
 *  for all clusters, explicit paths set for one cluster beat a global base directory). */
function pathsFor(st: any, c: any, r = resolveScoped(st, 'destination', c)) {
  const v = r.value; const rk = (f: string) => RANK[r.sources?.[f]?.scope] ?? 0;
  if (v.baseDir && rk('baseDir') >= Math.max(v.repoPath ? rk('repoPath') : 0, v.walPath ? rk('walPath') : 0)) {
    const dir = clusterDir(st, c);
    return { base: String(v.baseDir), dir, repo: `${v.baseDir}/${dir}/backup`, wal: `${v.baseDir}/${dir}/wal` };
  }
  return { base: undefined, dir: undefined, repo: v.repoPath ? expand(v.repoPath, c) : undefined, wal: v.walPath ? expand(v.walPath, c) : undefined };
}

/** The concrete destination of one cluster (placeholders expanded). `null` when nothing is configured for it. */
export function destinationFor(st: any, c: any): { dest: ResolvedDestination | null; resolved: ReturnType<typeof resolveScoped> } {
  const r = resolveScoped(st, 'destination', c);
  const v = r.value;
  if (!v.repoPath && !v.walPath && !v.baseDir) return { dest: null, resolved: r };
  const d: ResolvedDestination = { type: v.type || 'local', require_mount: !!v.requireMount };
  const ps = pathsFor(st, c, r);
  if (ps.repo) d.repo_path = ps.repo;
  if (ps.wal) d.wal_path = ps.wal;
  if (ps.base) { d.base_dir = ps.base; d.cluster_dir = ps.dir; }
  if (v.minFreeGb) d.min_free_gb = Number(v.minFreeGb);
  // the backup server belongs to the level that chose the KIND of storage: a level below that switches to another share or to local disks
  // (setting type and paths without a server) must not inherit a server check from above
  const sameLevel = (a?: { scope: string; key: string }, b?: { scope: string; key: string }) => !!a && !!b && a.scope === b.scope && a.key === b.key;
  const serverHere = !!v.server && d.type !== 'local' && sameLevel(r.sources?.server, r.sources?.type);
  if (serverHere) {
    const w = (st.nodes || {})[v.server];
    d.server = w && w.kind === 'worker' && Object.prototype.hasOwnProperty.call(st.nodes, v.server)
      ? { id: v.server, name: w.name, hosts: hostsOf(w), isBackupServer: (w.roles || []).includes('repository') }
      : { id: v.server, name: null, hosts: [], missing: true };
  }
  if (serverHere && v.serverPath) d.server_path = v.serverPath;
  // a value set on ONE cluster is that cluster's own path: the warning is about a shared value (global / environment / folder) without {cluster}
  if (!ps.base && v.walPath && !/\{(cluster|id)\}/.test(v.walPath) && r.sources?.walPath?.scope !== 'cluster' && st.clusters.filter((x: any) => !x.isSandbox).length > 1) {
    d.wal_shared_warning = 'The WAL path does not contain {cluster}: if the same value applies to several clusters, their WAL segments end up in the same directory and overwrite each other.';
  }
  if (d.wal_path) {                                         // two clusters that RESOLVE to the same (or a nested) archive directory, even with placeholders (same name and environment, two clusters assigned the same path by hand)
    const mine = d.wal_path.replace(/\/+$/, '') + '/';
    // the sites of ONE geo-redundant database (same system identifier) share its archive on purpose: same WAL names, same history, one catalogue
    const me = sysidOf(st, c.id);
    for (const o of st.clusters) {
      if (o.id === c.id || o.isSandbox) continue;
      if (me && sysidOf(st, o.id) === me) continue;
      const ow = pathsFor(st, o).wal;
      if (!ow) continue;
      const theirs = ow.replace(/\/+$/, '') + '/';
      if (mine === theirs || mine.startsWith(theirs) || theirs.startsWith(mine)) { d.wal_collision = `WAL archive ${d.wal_path} is the same as (or contains / is contained in) the one of cluster “${o.name}”: segments with the same name would overwrite each other. Change the path (for example by adding {id}).`; break; }
    }
  }
  return { dest: d, resolved: r };
}

const stable = (v: any): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const CHECK_MAX_AGE_MS = 30 * 60 * 1000;
const checkParams = (d: ResolvedDestination) => ({ type: d.type, ...(d.repo_path ? { repo_path: d.repo_path } : {}), ...(d.wal_path ? { wal_path: d.wal_path } : {}), require_mount: d.require_mount, ...(d.min_free_gb ? { min_free_gb: d.min_free_gb } : {}),
  ...(d.server && !d.server.missing && d.type !== 'local' ? { expect_server: { name: d.server.name, hosts: d.server.hosts } } : {}) });

const online = (n: NodeRecord) => !!n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45000;
const nodesOf = (st: any, id: string): NodeRecord[] => (Object.values(st.nodes) as NodeRecord[]).filter(n => n.clusterId === id);

/** Latest check per node for the CURRENT resolved destination (same parameters), with its age. */
export function checksFor(st: any, c: any, d: ResolvedDestination) {
  const want = stable(checkParams(d));
  const out: Record<string, any> = {};
  for (const n of nodesOf(st, c.id)) {
    const op = [...st.operations].reverse().find((o: any) => o.type === 'destination_check' && o.clusterId === c.id && o.nodeId === n.id && stable({ ...o.params, bench: undefined }) === stable({ ...JSON.parse(want), bench: undefined }));
    out[n.id] = op ? { opId: op.id, status: op.status, ok: op.status === 'succeeded' ? !!op.result?.ok : null, at: op.updatedAt, fresh: Date.now() - Date.parse(op.updatedAt) < CHECK_MAX_AGE_MS } : null;
  }
  return out;
}

/** Why the destination cannot be applied now (null = it can). */
export function precheckApply(st: any, c: any): { code: number; body: any } | null {
  if (c.isSandbox) return { code: 409, body: { error: 'demo_cluster' } };
  const { dest } = destinationFor(st, c);
  if (!dest) return { code: 409, body: { error: 'no_destination' } };
  if (dest.wal_collision) return { code: 409, body: { error: 'wal_collision', message: dest.wal_collision } };
  if (dest.server?.missing) return { code: 409, body: { error: 'server_missing', message: 'The backup server chosen for this destination is no longer registered: choose another one (or another kind of storage) first.' } };
  const nodes = nodesOf(st, c.id).filter(online);
  if (!nodes.length) return { code: 409, body: { error: 'no_online_node' } };
  const chk = checksFor(st, c, dest);
  const bad = nodes.filter(n => !chk[n.id] || chk[n.id].ok !== true || !chk[n.id].fresh);
  if (bad.length) return { code: 409, body: { error: 'check_required', message: `Before applying, every node needs a recent passed check (missing: ${bad.map(n => n.name).join(', ')}).`, nodes: bad.map(n => n.name) } };
  return null;
}

/**
 * Apply the resolved destination to every online node of the cluster (also called when a four-eyes request is approved). Each agent keeps its OLD
 * repository / WAL archive as a read-only previous location (restores and PITR keep working across the change) and, on the primary, proves that the
 * next WAL segment lands in the new archive - or goes back to the old one by itself. Existing backups are not moved (destination_migrate does that).
 */
export async function applyDestination(store: Store, c: any, key: string, by: string, approved?: { repo_path?: string; wal_path?: string }): Promise<{ code: number; body: any }> {
  const st = store.peek();
  const pre = precheckApply(st, c);
  if (pre) return pre;
  const { dest } = destinationFor(st, c);
  // a four-eyes request approves THE destination it shows: if the configured one changed meanwhile, approving must not apply the other one
  // (independent review: the approver saw /mnt/nfs/A, the nodes were moved to B)
  if (approved && ((approved.repo_path || '') !== (dest?.repo_path || '') || (approved.wal_path || '') !== (dest?.wal_path || '')))
    return { code: 409, body: { error: 'destination_changed', message: `The destination was changed after this request (requested: ${approved.repo_path || '-'} / ${approved.wal_path || '-'}, now: ${dest?.repo_path || '-'} / ${dest?.wal_path || '-'}): reject it and request the change again.` } };
  const out = [];
  for (const n of nodesOf(st, c.id).filter(online)) {
    const set: Record<string, string> = {};
    if (dest!.repo_path) set.repo_path = dest!.repo_path;
    if (dest!.wal_path) set.wal_archive_dir = dest!.wal_path;
    const r = await ops.submit(store, { type: 'agent_config_set', clusterId: c.id, nodeId: n.id, params: { set, verify_wal: true }, idempotencyKey: `${key}:cfg:${n.id}`, createdBy: by, ttlSeconds: 300 });
    out.push({ nodeId: n.id, nodeName: n.name, operation: r.op });
  }
  const prevOf = (n: any) => ({ repo: n.snapshot?.storage?.repo_path || null, wal: n.snapshot?.storage?.wal_path || null });
  const prim = nodesOf(st, c.id).find(n => online(n) && n.snapshot?.postgres?.is_in_recovery === false);
  await store.mutate(d => {
    (d.settings.destinationApplied ||= {})[c.id] = { at: new Date().toISOString(), by, repo_path: dest!.repo_path, wal_path: dest!.wal_path, type: dest!.type, previous: prim ? prevOf(prim) : null,
      ...(dest!.cluster_dir ? { dirName: dest!.cluster_dir, baseDir: dest!.base_dir } : {}) };
    audit(d, { clusterId: c.id, actor: by, action: 'destination.apply', status: 'OK', details: { ...dest } });
  });
  return { code: 202, body: { destination: dest, operations: out,
    note: dest!.repo_path ? 'Existing backups stay in the previous location, readable by restores; the new backup storage starts with a full backup (the next backup becomes one by itself). You can migrate the old content in the background.' : undefined } };
}

/** Where the backups physically are (directories, share sources, server addresses) is administrator information: other roles get the shape of the
 *  answer with these values replaced, so every screen still works and says "shown to administrators". */
export const HIDDEN = '(hidden)';
const PATH_KEYS = new Set(['baseDir', 'base_dir', 'path', 'repo_path', 'wal_path', 'wal_archive_dir', 'repoPath', 'walPath', 'server_path', 'serverPath', 'source', 'mountpoint', 'remoteHost', 'hosts', 'repo', 'wal',
  'source_repo', 'source_wal', 'destination', 'dead_branch_dir', 'fix_commands', 'current']);
/** Operations whose parameters and results describe the backup locations. */
export const LOCATION_OPS = new Set(['destination_check', 'destination_migrate', 'destination_drop_old', 'agent_config_set', 'destination_apply']);
export function maskPaths<T>(v: T): T {
  const walk = (x: any, k?: string): any => {
    // "source" is also a plain word elsewhere (a cluster's source: agent / direct): only a location-looking value is hidden
    if (k === 'source' && typeof x === 'string' && !/[/:\\]/.test(x)) return x;
    if (k && PATH_KEYS.has(k)) {
      if (typeof x === 'string') return HIDDEN;
      if (Array.isArray(x)) return x.map(e => (typeof e === 'string' ? HIDDEN : walk(e)));
    }
    if (Array.isArray(x)) return x.map(e => walk(e));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([kk, vv]) => [kk, walk(vv, kk)]));
    return x;
  };
  return walk(v);
}
export const isAdmin = (req: Request) => (req as any).role === 'admin';
/** An operation as a non-administrator may see it: the backup locations in its parameters and result hidden. */
const LOCATION_SETTINGS = new Set(['repo_path', 'wal_archive_dir', 'repo_previous', 'wal_previous']);
export const maskOpFor = (req: Request, o: any) => {
  if (!o || isAdmin(req)) return o;
  if (o.type === 'agent_config_get' && Array.isArray(o.result?.settings))      // the agent's settings page: its backup locations only
    return { ...o, result: { ...o.result, settings: o.result.settings.map((x: any) => (LOCATION_SETTINGS.has(x?.key) ? { ...x, detected: x.detected ? HIDDEN : x.detected, override: x.override ? HIDDEN : x.override, effective: x.effective ? HIDDEN : x.effective, check: x.check ? maskPaths(x.check) : x.check } : x)) } };
  return LOCATION_OPS.has(o.type) ? { ...o, params: maskPaths(o.params), result: maskPaths(o.result) } : o;
};

/**
 * WHERE each node of the cluster really keeps its backups and WAL, in operator terms: on a backup server (a worker host with the
 * "repository" role, recognised from the server part of the node's NFS/SMB mount), on another network share, or on the node's own disk; whether
 * every node sees the SAME storage (proven by the id file inside it, not guessed from paths); free space; same disk as the data.
 * Paths, mount sources and server addresses are configuration details: only administrators receive them, and the console reveals them on request.
 */
export function storageOf(st: any, c: any, admin: boolean) {
  const { dest, resolved } = destinationFor(st, c);
  const loc = (n: NodeRecord, which: 'repo' | 'wal') => {
    const sto = n.snapshot?.storage || {};
    const disks = (n.snapshot?.system?.disks || {}) as Record<string, any>;
    const disk = which === 'repo' ? disks.repo : disks.wal_archive;
    const m = (which === 'repo' ? sto.repo_mount : sto.wal_mount) || null;
    const path = which === 'repo' ? sto.repo_path ?? n.snapshot?.config?.repo_path ?? null : sto.wal_path ?? null;
    const network = !!m?.remote_host || /^(nfs|nfs4|cifs|smb3|smbfs|ceph|glusterfs|lustre|gpfs|beegfs|9p|fuse\.sshfs)$/.test(m?.fstype || '');
    const w = network ? workerForHost(st, m?.remote_host) : null;
    const kind = !m && !disk ? 'unknown' : w && (w.roles || []).includes('repository') ? 'backup_server' : w ? 'worker_share' : network ? 'network_share' : 'local_disk';
    const sameDisk = !!(disk && disks.pgdata && disk.dev !== undefined && disk.dev === disks.pgdata.dev);
    return {
      kind, fstype: m?.fstype || null, server: w ? { id: w.id, name: w.name, online: online(w) } : null,
      freeBytes: disk?.free_bytes ?? null, totalBytes: disk?.total_bytes ?? null, sameDiskAsData: sameDisk,
      id: (which === 'repo' ? sto.repo_id : sto.wal_id) || null,
      ...(admin ? { path, mountpoint: m?.mountpoint || null, source: m?.source || null, remoteHost: m?.remote_host || null } : {}),
    };
  };
  const nodes = nodesOf(st, c.id).map(n => ({ id: n.id, name: n.name, online: online(n), role: n.snapshot?.postgres?.is_in_recovery === false ? 'primary' : n.snapshot?.postgres?.is_in_recovery === true ? 'replica' : null,
    repo: loc(n, 'repo'), wal: loc(n, 'wal') }));
  // shared = every reporting node sees the same storage (same id file); split = at least two different ones (a failover would lose the history)
  const sharing = (which: 'repo' | 'wal') => {
    const ids = nodes.filter(n => n.online && n[which].id).map(n => n[which].id);
    return nodes.length < 2 ? 'single' : ids.length < 2 ? 'unknown' : new Set(ids).size === 1 ? 'shared' : 'split';
  };
  const servers = (Object.values(st.nodes) as any[]).filter(n => n.kind === 'worker' && (n.roles || []).includes('repository'))
    .map(n => ({ id: n.id, name: n.name, online: online(n), label: n.label || '', ...(admin ? { hosts: hostsOf(n) } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
  const redact = (d: ResolvedDestination | null) => !d ? null : admin ? d : { type: d.type, require_mount: d.require_mount, server: d.server ? { id: d.server.id, name: d.server.name, missing: d.server.missing } : undefined };
  const level = (k: string) => resolved.sources?.[k] ? { scope: resolved.sources[k].scope, key: resolved.sources[k].key } : null;
  const repoSharing = sharing('repo'), walSharing = sharing('wal');
  for (const n of nodes) for (const w of ['repo', 'wal'] as const) delete (n[w] as any).id;
  return {
    admin, nodes, repoSharing, walSharing, backupServers: servers,
    configured: redact(dest), configuredAt: level('repoPath') || level('walPath') || level('type'),
    applied: (() => { const a = (st.settings.destinationApplied || {})[c.id]; return a ? { at: a.at, by: a.by, type: a.type, ...(admin ? { repo_path: a.repo_path, wal_path: a.wal_path } : {}) } : null; })(),
  };
}

export function mountDestinationRoutes(app: any, store: Store) {
  const actor = (req: Request) => (req as any).actor || 'admin';

  app.get('/api/clusters/:id/destination', (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    const { dest, resolved } = destinationFor(st, c);
    const nodes = nodesOf(st, c.id).map(n => ({ id: n.id, name: n.name, online: online(n), primary: n.snapshot?.postgres?.is_in_recovery === false,
      repo_path: n.snapshot?.storage?.repo_path ?? n.snapshot?.config?.repo_path ?? n.snapshot?.backup?.repo_path ?? null, wal_path: n.snapshot?.storage?.wal_path ?? null,
      repo_previous: n.snapshot?.storage?.repo_previous || [], wal_previous: n.snapshot?.storage?.wal_previous || [] }));
    // the locations still read by restores after a change (as the primary reports them): what can be migrated or, once safe, deleted
    const prim = nodes.find(n => n.primary && n.online) || nodes.find(n => n.online) || nodes[0];
    const previous = prim ? { repo: prim.repo_previous, wal: prim.wal_previous, nodeId: prim.id, nodeName: prim.name } : null;
    const running = st.operations.filter((o: any) => o.clusterId === c.id && ['destination_migrate', 'destination_drop_old'].includes(o.type) && ['queued', 'leased', 'running'].includes(o.status)).map((o: any) => ({ id: o.id, type: o.type, status: o.status }));
    const body = { destination: dest, effective: resolved, nodes, checks: dest ? checksFor(st, c, dest) : {}, applied: (st.settings.destinationApplied || {})[c.id] || null, previewTypes: PREVIEW_TYPES,
      current: prim ? { repo: prim.repo_path, wal: prim.wal_path } : null, previous, running };
    res.json(isAdmin(req) ? body : { ...maskPaths(body), hidden: true });
  });

  /**
   * WHERE things happen for this cluster, in one answer for the screens that need it (restore plan, backup page): the node and scratch directory of the
   * recovery instance, the repository and WAL archive in use, the free space of each as last reported by the agents, and which level of the configuration
   * each value comes from (so the screen can say "set for environment prod" and link to the right place to change it).
   */
  app.get('/api/clusters/:id/placement', (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    const nodes = nodesOf(st, c.id);
    const prim = nodes.find(n => online(n) && n.snapshot?.postgres?.is_in_recovery === false) || nodes.find(n => online(n) && n.snapshot?.postgres?.alive) || nodes.find(online) || nodes[0];
    const eph = resolveScoped(st, 'ephemeral', c);
    const central = eph.value.placement === 'central' ? (st.nodes as any)[eph.value.centralNode] as NodeRecord | undefined : undefined;
    const runNode = eph.value.placement === 'central' ? central : prim;
    const disks = (n?: NodeRecord) => (n?.snapshot?.system?.disks || {}) as Record<string, { path: string; free_bytes: number; total_bytes: number; dev?: number }>;
    const rd = disks(runNode); const pd = disks(prim);
    const scratchPath = eph.value.scratchDir || rd.scratch?.path || '/var/tmp/pg_arca_scratch';
    const scratchDisk = rd.scratch && rd.scratch.path === scratchPath ? rd.scratch : null;
    const { dest, resolved } = destinationFor(st, c);
    const applied = (st.settings.destinationApplied || {})[c.id] || null;
    const node = (n?: NodeRecord) => (n ? { id: n.id, name: n.name, online: online(n), role: n.snapshot?.postgres?.is_in_recovery === false ? 'primary' : n.snapshot?.postgres?.is_in_recovery === true ? 'replica' : null } : null);
    const admin = isAdmin(req);
    res.json({
      hidden: !admin,
      ephemeral: {
        placement: eph.value.placement || 'node', node: node(runNode), centralMissing: eph.value.placement === 'central' && !central,
        scratchDir: scratchPath, scratchDisk, scratchSharesData: !!(scratchDisk && rd.pgdata && scratchDisk.dev !== undefined && scratchDisk.dev === rd.pgdata.dev),
        binDir: eph.value.binDir || null, sharedBuffersMb: eph.value.sharedBuffersMb, keepOnFailure: !!eph.value.keepOnFailure, sources: eph.sources,
      },
      backup: (admin ? (x: any) => x : maskPaths)({
        repoPath: pd.repo?.path || applied?.repo_path || null, walPath: pd.wal_archive?.path || applied?.wal_path || null,
        repoDisk: pd.repo || null, walDisk: pd.wal_archive || null, dataDisk: pd.pgdata || null,
        configured: dest, pending: !!(dest && ((dest.repo_path && dest.repo_path !== pd.repo?.path) || (dest.wal_path && dest.wal_path !== pd.wal_archive?.path))),
        type: dest?.type || applied?.type || 'local', sources: resolved.sources, node: node(prim),
        previous: { repo: (prim?.snapshot?.storage?.repo_previous || []).map((x: any) => x.path), wal: (prim?.snapshot?.storage?.wal_previous || []).map((x: any) => x.path) },
        migrating: st.operations.some((o: any) => o.clusterId === c.id && o.type === 'destination_migrate' && !o.params?.dry_run && ['queued', 'leased', 'running'].includes(o.status)),
      }),
    });
  });

  /**
   * WHERE each node of the cluster really keeps its backups and WAL, in operator terms: on a backup server (a worker host with the
   * "repository" role, recognised from the server part of the node's NFS/SMB mount), on another network share, or on the node's own disk; whether
   * every node sees the SAME storage (proven by the id file inside it, not guessed from paths); free space; same disk as the data.
   * Paths, mount sources and server addresses are configuration details: only administrators receive them, and the console reveals them on request.
   */
  app.get('/api/clusters/:id/storage', (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    res.json(storageOf(st, c, isAdmin(req)));
  });

  /** What a storage setting WOULD give each cluster before it is saved (the wizard's review): the directories, created automatically per cluster
   *  under a base directory, and any WAL archive collision. Administrators only (it is all paths). */
  app.post('/api/destination/preview', (req: Request, res: Response) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden' });
    const { scope, key = '', value } = req.body || {};
    if (!['global', 'env', 'folder', 'cluster'].includes(scope)) return res.status(400).json({ error: 'invalid_scope' });
    const vv = destination.validate(value, store.peek());
    if (!vv.ok) return res.status(400).json({ error: 'invalid_value', message: (vv as any).error });
    const st = store.peek();
    const k = scope === 'global' ? 'global' : `${scope}:${scope === 'folder' ? normFolder(key) : String(key)}`;
    const sc = st.settings.scoped || {};
    const st2 = { ...st, settings: { ...st.settings, scoped: { ...sc, destination: { ...(sc.destination || {}), [k]: (vv as any).value } } } };
    res.json({ clusters: st.clusters.filter((c: any) => !c.isSandbox && c.source !== 'direct').map((c: any) => {
      const { dest, resolved } = destinationFor(st2, c);
      const src = resolved.sources?.baseDir || resolved.sources?.repoPath || resolved.sources?.walPath;
      return { id: c.id, name: c.name, environment: c.environment, affected: !!src && src.scope === scope && src.key === k,
        repo_path: dest?.repo_path || null, wal_path: dest?.wal_path || null, cluster_dir: dest?.cluster_dir || null, wal_collision: dest?.wal_collision || null };
    }) });
  });

  /** Every cluster in one line: where its backups really are (backup server names / share / local disks) and whether the nodes share it. */
  app.get('/api/storage-overview', (req: Request, res: Response) => {
    const st = store.peek();
    res.json({ clusters: st.clusters.filter((c: any) => !c.isSandbox && c.source !== 'direct').map((c: any) => {
      const s = storageOf(st, c, false);
      const kinds = [...new Set(s.nodes.map((n: any) => n.repo.kind).filter((k: string) => k !== 'unknown'))];
      const servers = [...new Set(s.nodes.map((n: any) => n.repo.server?.name).filter(Boolean))];
      return { id: c.id, name: c.name, environment: c.environment, nodes: s.nodes.length, kinds, servers, repoSharing: s.repoSharing, walSharing: s.walSharing,
        sameDiskAsData: s.nodes.some((n: any) => n.repo.sameDiskAsData) };
    }) });
  });

  // check on every online node: the destination must work from each of them (a standby may take over)
  app.post('/api/clusters/:id/destination/check', async (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    if (c.isSandbox) return res.status(409).json({ error: 'demo_cluster' });
    const { dest } = destinationFor(st, c);
    if (!dest) return res.status(409).json({ error: 'no_destination', message: 'No destination configured for this cluster, its folder or its environment.' });
    const key = String(req.headers['idempotency-key'] || '');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    const nodes = nodesOf(st, c.id).filter(online);
    if (!nodes.length) return res.status(409).json({ error: 'no_online_node', message: 'No node of the cluster is reachable: the check runs on the nodes.' });
    const bench = !!req.body?.bench;
    const out = [];
    for (const n of nodes) {
      const r = await ops.submit(store, { type: 'destination_check', clusterId: c.id, nodeId: n.id, params: { ...checkParams(dest), ...(bench ? { bench: true } : {}) }, idempotencyKey: `${key}:${n.id}`, createdBy: actor(req), ttlSeconds: 300 });
      out.push({ nodeId: n.id, nodeName: n.name, operation: r.op });
    }
    res.status(202).json({ destination: dest, operations: out });
  });

  // apply: only when EVERY online node has a fresh, successful check of exactly this destination. On a protected environment it is a four-eyes request.
  app.post('/api/clusters/:id/destination/apply', async (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    const key = String(req.headers['idempotency-key'] || '');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    const pre = precheckApply(st, c);
    if (pre) return res.status(pre.code).json(pre.body);
    if (requiresApproval(st, c, 'destination_apply', {})) {
      const { dest } = destinationFor(st, c);
      const rec = await requestApproval(store, audit, { cluster: c, type: 'destination_apply', params: { repo_path: dest!.repo_path, wal_path: dest!.wal_path }, key, actor: actor(req) });
      return res.status(202).json({ approval: rec, message: 'Destination change in a protected environment: another administrator must approve it.' });
    }
    const r = await applyDestination(store, c, key, actor(req));
    res.status(r.code).json(r.body);
  });
}
