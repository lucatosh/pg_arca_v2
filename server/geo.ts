/**
 * Geo-redundancy: two (or more) Patroni clusters in different sites that hold the SAME database (same system identifier): one primary site, the others
 * Patroni "standby clusters" replicating from it over the WAN (standby_cluster in their DCS, usually through a permanent slot on the primary site).
 *
 * What the console adds:
 *  - recognises the sites from the agents' telemetry (system identifier, standby_cluster, standby leader, WAL receiver) and pairs them;
 *  - measures the replication between sites: bytes behind, seconds since the standby site last heard from the primary site, the slot that keeps the WAL;
 *  - DR promotion of a standby site (geo_promote) refused while the primary site is alive, unless the operator states it is lost (split-brain guard);
 *  - planned site switchover: demote the primary site (it follows the other one), wait until nothing is missing, promote the other site — through each
 *    site's own DCS (PATCH /config), never by hand on PostgreSQL. The steps are recorded (settings.geoJobs) and visible while they run.
 */
import type { Request, Response } from 'express';
import { Store, NodeRecord, newId, nowIso } from './store';
import * as ops from './ops';
import { lsnToBig } from './view';
import { conflictFor } from './conflicts';
import { requiresApproval, requestApproval } from './approvals';

const ONLINE_MS = 45_000;
const MB = 1024 * 1024;
const online = (n: NodeRecord, now = Date.now()) => !!n.lastSeen && now - Date.parse(n.lastSeen) < ONLINE_MS;
/** Name of the permanent slot that keeps, on the primary site, the WAL a standby SITE has not received yet: geo_<site> ("geo-dc1" -> geo_dc1, "milano" -> geo_milano). */
export const geoSlotFor = (name: string) => { const b = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); return (b.startsWith('geo_') ? b : 'geo_' + b).slice(0, 63).replace(/_+$/, ''); };

export interface Site {
  clusterId: string; name: string; environment: string; folder: string; role: 'primary' | 'standby' | 'unknown';
  leader: string | null; leaderNodeId: string | null; online: boolean; lsn: string | null; timeline: number | null;
  endpoint: { host: string; port: number } | null;                 // how the OTHER sites reach this one (configured, or what a standby site points at)
  endpointSource?: 'configured' | 'detected' | null;
  upstream?: { host: string; port: number; slot?: string } | null; // standby site: where it replicates from
  receiver?: { status: string; sender: string; silentSec: number | null } | null;
  lagBytes?: number | null; replayDelaySec?: number | null; slot?: { name: string; active: boolean; retainedBytes: number | null } | null;
  health: 'ok' | 'warn' | 'bad'; problems: string[];
}
export interface GeoGroup { sysid: string; sites: Site[]; primary: string | null }

function siteOf(st: any, c: any, now: number): Site & { _sysid: string | null; _lsn: bigint | null } {
  const nodes = (Object.values(st.nodes) as NodeRecord[]).filter(n => n.clusterId === c.id && n.kind !== 'worker');
  const on = nodes.filter(n => online(n, now));
  const prim = on.find(n => n.snapshot?.postgres?.is_in_recovery === false);
  const sl = on.find(n => n.snapshot?.patroni?.local_node?.role === 'standby_leader');
  const sc = nodes.map(n => n.snapshot?.patroni?.standby_cluster).find(x => x && x.host);
  const lead = prim || sl || null;
  const pg = lead?.snapshot?.postgres || {};
  const sysid = nodes.map(n => n.snapshot?.postgres?.system_identifier).find(Boolean) || null;
  const role: Site['role'] = prim && !sc ? 'primary' : (sc || sl) ? 'standby' : 'unknown';
  const wr = sl?.snapshot?.postgres?.wal_receiver;
  return {
    clusterId: c.id, name: c.name, environment: c.environment, folder: c.folder || '', role, leader: lead?.name || null, leaderNodeId: lead?.id || null,
    online: !!lead, lsn: pg.current_lsn || null, timeline: pg.timeline ?? null,
    endpoint: c.geoEndpoint || null, endpointSource: c.geoEndpoint ? (c.geoEndpoint.detected ? 'detected' : 'configured') : null,
    upstream: sc ? { host: String(sc.host), port: Number(sc.port || 5432), slot: sc.primary_slot_name || undefined } : null,
    receiver: wr ? { status: String(wr.status || ''), sender: wr.sender_host ? `${wr.sender_host}:${wr.sender_port}` : '', silentSec: wr.silent_sec != null ? Number(wr.silent_sec) : null } : (role === 'standby' ? { status: 'none', sender: '', silentSec: null } : null),
    replayDelaySec: sl?.snapshot?.postgres?.replay_ts ? Math.max(0, Math.round((now - Date.parse(sl.snapshot.postgres.replay_ts)) / 1000)) : null,
    health: 'ok', problems: [], _sysid: sysid, _lsn: lsnToBig(pg.current_lsn),
  };
}

/** Every group of clusters sharing a system identifier (at least one standby site among them). Pure. */
export function geoGroups(st: any, now = Date.now()): GeoGroup[] {
  const sites = (st.clusters as any[]).filter(c => !c.isSandbox && c.source !== 'direct').map(c => siteOf(st, c, now));
  const by = new Map<string, typeof sites>();
  for (const s of sites) if (s._sysid) { const l = by.get(s._sysid) || []; l.push(s); by.set(s._sysid, l); }
  const out: GeoGroup[] = [];
  for (const [sysid, list] of by) {
    if (list.length < 2 && !list.some(s => s.role === 'standby')) continue;
    const prim = list.find(s => s.role === 'primary');
    const primNode = prim ? (Object.values(st.nodes) as NodeRecord[]).find(n => n.id === prim.leaderNodeId) : undefined;
    // the primary site's address as its standby sites use it: no need to type it, and it is what a later switchover back needs
    if (prim && !prim.endpoint) { const up = list.find(s => s.role === 'standby' && s.upstream)?.upstream; if (up) { prim.endpoint = { host: up.host, port: up.port }; prim.endpointSource = 'detected'; } }
    for (const s of list) {
      if (s.role !== 'standby') continue;
      if (prim && prim._lsn !== null && s._lsn !== null) s.lagBytes = prim._lsn >= s._lsn ? Number(prim._lsn - s._lsn) : 0;
      const slotName = s.upstream?.slot;
      const sl = slotName ? (primNode?.snapshot?.postgres?.slots || []).find((x: any) => x.name === slotName) : null;
      s.slot = slotName ? { name: slotName, active: !!sl?.active, retainedBytes: sl?.retained_bytes ?? null } : null;
      const p: string[] = []; let h: Site['health'] = 'ok';
      const bad = (m: string) => { p.push(m); h = 'bad'; }; const warn = (m: string) => { p.push(m); if (h === 'ok') h = 'warn'; };
      if (!s.online) bad('il sito non ha un nodo raggiungibile');
      else if (!s.receiver || s.receiver.status !== 'streaming') bad(`non riceve WAL dal sito primario (ricevitore: ${s.receiver?.status || 'assente'})`);
      if (s.receiver?.silentSec != null && s.receiver.silentSec > 120) bad(`nessun messaggio dal sito primario da ${Math.round(s.receiver.silentSec)} s`);
      else if (s.receiver?.silentSec != null && s.receiver.silentSec > 30) warn(`ultimo messaggio dal sito primario ${Math.round(s.receiver.silentSec)} s fa`);
      if (s.lagBytes != null && s.lagBytes > 1024 * MB) bad(`indietro di ${Math.round(s.lagBytes / MB)} MB`);
      else if (s.lagBytes != null && s.lagBytes > 64 * MB) warn(`indietro di ${Math.round(s.lagBytes / MB)} MB`);
      if (s.slot && !s.slot.active) warn(`lo slot ${s.slot.name} sul sito primario non è attivo: il primario conserva i WAL (${s.slot.retainedBytes != null ? Math.round(s.slot.retainedBytes / MB) + ' MB' : '?'})`);
      if (s.slot?.retainedBytes != null && s.slot.retainedBytes > 8 * 1024 * MB) bad(`lo slot ${s.slot.name} trattiene ${Math.round(s.slot.retainedBytes / MB)} MB di WAL sul sito primario: rischio di disco pieno`);
      if (!prim) warn('nessun sito primario visibile tra i cluster collegati');
      s.problems = p; s.health = h;
    }
    out.push({ sysid, sites: list.map(({ _sysid, _lsn, ...rest }) => rest), primary: prim?.clusterId || null });
  }
  return out;
}

export function geoOf(st: any, clusterId: string) {
  for (const g of geoGroups(st)) { const me = g.sites.find(s => s.clusterId === clusterId); if (me) return { ...me, peers: g.sites.filter(s => s.clusterId !== clusterId), sysid: g.sysid }; }
  return null;
}

/** Health findings for the briefing ("Oggi"): one per standby site in trouble. */
export function geoIssues(st: any, now = Date.now()) {
  const out: any[] = [];
  for (const g of geoGroups(st, now)) for (const s of g.sites) {
    if (s.role !== 'standby' || s.health === 'ok') continue;
    out.push({ key: `${s.clusterId}:geo_replication`, clusterId: s.clusterId, clusterName: s.name, environment: s.environment, severity: s.health === 'bad' ? 'critical' : 'warning', code: 'geo_replication',
      title: `Sito di replica ${s.name}: ${s.problems[0]}`, cause: s.problems.join('; ') + '. In caso di disastro sul sito primario, i dati non ancora arrivati qui andrebbero persi.', action: { label: 'Apri la georidondanza', page: 'geo' } });
  }
  return out;
}

const pick = (st: any, clusterId: string) => {
  const nodes = (Object.values(st.nodes) as NodeRecord[]).filter(n => n.clusterId === clusterId && online(n));
  return nodes.find(n => n.snapshot?.patroni?.accessible && (n.snapshot?.postgres?.is_in_recovery === false || n.snapshot?.patroni?.local_node?.role === 'standby_leader')) || nodes.find(n => n.snapshot?.patroni?.accessible);
};

async function submitTo(store: Store, clusterId: string, type: string, params: any, key: string, actor: string) {
  const st = store.peek(); const n = pick(st, clusterId);
  if (!n) throw Object.assign(new Error('nessun nodo del sito con Patroni raggiungibile'), { status: 409 });
  const c = conflictFor(st.operations, clusterId, type, params, actor);
  if (c) throw Object.assign(new Error(c.message), { status: 409, body: c });
  const { op } = await ops.submit(store, { type, clusterId, nodeId: n.id, params, idempotencyKey: key, createdBy: actor, ttlSeconds: 300 });
  return op;
}
async function waitOp(store: Store, id: string, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    const o = store.peek().operations.find(x => x.id === id);
    if (o && ops.isTerminal(o.status)) return o;
    if (Date.now() - t0 > timeoutMs) throw new Error('operazione non conclusa in tempo');
    await new Promise(r => setTimeout(r, 1000));
  }
}

/** Planned switchover between sites. Runs in the background; every step is recorded in settings.geoJobs[id]. */
export async function runSwitchover(store: Store, job: { id: string; from: string; to: string; toEndpoint: { host: string; port: number }; actor: string }) {
  const step = (text: string, status = 'running', extra: any = {}) => store.mutate(d => {
    const j = (d.settings.geoJobs ||= {})[job.id]; if (!j) return;
    j.steps.push({ at: nowIso(), text }); j.status = status; Object.assign(j, extra);
    if (j.steps.length > 60) j.steps.splice(0, j.steps.length - 60);
  });
  try {
    const st = store.peek(); const g = geoGroups(st).find(x => x.sites.some(s => s.clusterId === job.from) && x.sites.some(s => s.clusterId === job.to));
    if (!g) throw new Error('i due cluster non risultano siti dello stesso database');
    const from = g.sites.find(s => s.clusterId === job.from)!, to = g.sites.find(s => s.clusterId === job.to)!;
    if (from.role !== 'primary') throw new Error(`${from.name} non è il sito primario`);
    if (to.role !== 'standby' || to.health === 'bad') throw new Error(`${to.name} non è un sito di replica in salute: ${to.problems.join('; ') || to.role}`);
    if ((to.lagBytes ?? 0) > 16 * MB) throw new Error(`${to.name} è indietro di ${Math.round((to.lagBytes || 0) / MB)} MB: attendi che si allinei`);
    const slot = geoSlotFor(from.name);
    await step(`1/4 ${from.name} diventa sito di replica di ${to.name} (${job.toEndpoint.host}:${job.toEndpoint.port}): le scritture su ${from.name} si fermano`);
    // the slot the target site used on this one is useless once it is primary (and a standby site must not hold WAL for nobody): dropped in the same DCS change
    const drop = to.upstream?.slot && /^[a-z0-9_]{1,63}$/.test(to.upstream.slot) && to.upstream.slot !== slot ? [to.upstream.slot] : [];
    const d = await submitTo(store, job.from, 'geo_demote', { host: job.toEndpoint.host, port: job.toEndpoint.port, primary_slot_name: slot, drop_slots: drop, confirm: 'DECLASSA' }, `geo:${job.id}:demote`, job.actor);
    const dr = await waitOp(store, d.id, 240_000);
    if (dr.status !== 'succeeded') throw new Error(`declassamento di ${from.name} non riuscito: ${dr.error || dr.status}`);
    await step(`2/4 attesa che ${to.name} abbia ricevuto e applicato tutto ciò che ${from.name} ha scritto`);
    const fromLsn = lsnToBig(store.peek().nodes[dr.nodeId!]?.snapshot?.postgres?.current_lsn) ?? 0n;
    const t0 = Date.now(); let ok = false;
    while (Date.now() - t0 < 120_000) {
      const t = geoGroups(store.peek()).flatMap(x => x.sites).find(s => s.clusterId === job.to);
      const tl = lsnToBig(t?.lsn || null);
      if (tl !== null && tl >= fromLsn) { ok = true; break; }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!ok) throw new Error(`${to.name} non ha raggiunto la posizione di ${from.name} entro 2 minuti: NON viene promosso (${from.name} resta sito di replica, nessun dato perso: si può tornare indietro con la promozione di ${from.name})`);
    await step(`3/4 promozione di ${to.name} (slot ${slot} creato per ${from.name})`);
    const p = await submitTo(store, job.to, 'geo_promote', { confirm: 'PROMUOVI', slot_for_peer: slot }, `geo:${job.id}:promote`, job.actor);
    const pr = await waitOp(store, p.id, 240_000);
    if (pr.status !== 'succeeded') throw new Error(`promozione di ${to.name} non riuscita: ${pr.error || pr.status}`);
    await step(`4/4 completato: ${to.name} è il sito primario, ${from.name} replica da lui`, 'succeeded', { finishedAt: nowIso() });
    await store.mutate(d2 => ops.audit(d2, { clusterId: job.to, actor: job.actor, action: 'geo.switchover', status: 'OK', details: { from: job.from, to: job.to } }));
  } catch (e: any) {
    await step(`interrotto: ${e.message}`, 'failed', { finishedAt: nowIso(), error: e.message });
    await store.mutate(d2 => ops.audit(d2, { clusterId: job.to, actor: job.actor, action: 'geo.switchover', status: 'FAILED', details: { from: job.from, to: job.to, error: e.message } }));
  }
}

/** Checks and starts a planned switchover (used by the API and by the approval of a pending request). */
export async function startSwitchover(store: Store, from: string, to: string, actor: string): Promise<{ code: number; body: any }> {
  const st = store.peek(); const target = st.clusters.find((c: any) => c.id === to); const src = st.clusters.find((c: any) => c.id === from);
  if (!target || !src) return { code: 404, body: { error: 'cluster_not_found' } };
  const g0 = geoGroups(st).find(x => x.sites.some(s => s.clusterId === from) && x.sites.some(s => s.clusterId === to));
  const fromSite = g0?.sites.find(s => s.clusterId === from);
  if (fromSite?.endpoint && fromSite.endpointSource === 'detected')            // remember how the others reach the current primary: the switchover back will need it
    await store.mutate(d => { const c = d.clusters.find((x: any) => x.id === from); if (c && !c.geoEndpoint) c.geoEndpoint = { ...fromSite.endpoint!, detected: true }; });
  if (!target.geoEndpoint) return { code: 409, body: { error: 'endpoint_required', message: `Indica prima come ${src.name} raggiunge ${target.name} (indirizzo e porta del suo leader, per esempio l’HAProxy o il VIP del sito).` } };
  if (Object.values(st.settings.geoJobs || {}).some((j: any) => j.status === 'running')) return { code: 409, body: { error: 'busy', message: 'C’è già uno switchover tra siti in corso.' } };
  const id = newId('geo');
  await store.mutate(d => { (d.settings.geoJobs ||= {})[id] = { id, type: 'switchover', from, to, fromName: src.name, toName: target.name, createdBy: actor, createdAt: nowIso(), status: 'running', steps: [] }; });
  runSwitchover(store, { id, from, to, toEndpoint: target.geoEndpoint, actor }).catch(() => undefined);
  return { code: 202, body: { job: store.peek().settings.geoJobs[id] } };
}

export function mountGeoRoutes(app: any, store: Store) {
  const actor = (req: Request) => (req as any).actor || 'admin';
  app.get('/api/geo', (_req: Request, res: Response) => {
    const st = store.peek();
    res.json({ groups: geoGroups(st), jobs: Object.values(st.settings.geoJobs || {}).sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10) });
  });
  app.get('/api/clusters/:id/geo', (req: Request, res: Response) => res.json({ geo: geoOf(store.peek(), req.params.id) }));

  /** How the other sites reach this one (host:port of its leader endpoint, e.g. the site's HAProxy or VIP): needed to make another site follow it. */
  app.put('/api/clusters/:id/geo-endpoint', async (req: Request, res: Response) => {
    const { host, port } = req.body || {};
    if (host !== null && (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(String(host || '')) || !(Number(port) >= 1 && Number(port) <= 65535))) return res.status(400).json({ error: 'invalid_endpoint' });
    const ok = await store.mutate(d => { const c = d.clusters.find((x: any) => x.id === req.params.id); if (!c) return false; c.geoEndpoint = host === null ? undefined : { host: String(host), port: Number(port) };
      ops.audit(d, { clusterId: c.id, actor: actor(req), action: 'geo.endpoint', status: 'OK', details: c.geoEndpoint || null }); return true; });
    res.status(ok ? 200 : 404).json({ ok });
  });

  /** DR: a standby site becomes writable. Refused while the primary site is alive unless the operator states it is lost. */
  app.post('/api/geo/promote', async (req: Request, res: Response) => {
    const { clusterId, primaryLost, confirm } = req.body || {};
    const key = String(req.headers['idempotency-key'] || ''); if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    if (confirm !== 'PROMUOVI') return res.status(400).json({ error: 'confirm_required', message: 'Scrivi PROMUOVI per confermare.' });
    const st = store.peek(); const me = geoOf(st, clusterId);
    if (!me || me.role !== 'standby') return res.status(409).json({ error: 'not_a_standby_site', message: 'Questo cluster non è un sito di replica.' });
    const alive = me.peers.find(p => p.role === 'primary' && p.online);
    if (alive && primaryLost !== true) return res.status(409).json({ error: 'primary_site_alive', message: `Il sito primario ${alive.name} è ancora attivo e accetta scritture: promuovere ${me.name} ora creerebbe due primari con dati divergenti. Usa lo switchover pianificato, oppure conferma che ${alive.name} è perso.`, primary: alive.name });
    const cluster = st.clusters.find((c: any) => c.id === clusterId);
    const params = { confirm: 'PROMUOVI', ...(me.peers[0] ? { slot_for_peer: geoSlotFor(me.peers.find(p => p.role === 'primary')?.name || me.peers[0].name) } : {}) };
    if (requiresApproval(st, cluster, 'geo_promote', params)) {
      const r = await requestApproval(store, ops.audit, { cluster, type: 'geo_promote', params, key, actor: actor(req) } as any);
      return res.status(202).json({ approval: r, message: 'Operazione rischiosa su un ambiente protetto: serve l’approvazione di un altro amministratore.' });
    }
    try { const op = await submitTo(store, clusterId, 'geo_promote', params, key, actor(req)); res.status(202).json({ operation: op }); }
    catch (e: any) { res.status(e.status || 500).json(e.body || { error: 'failed', message: e.message }); }
  });

  /** Planned switchover between sites (both alive): demote the primary site, wait, promote the standby site. Four-eyes approval on protected environments. */
  app.post('/api/geo/switchover', async (req: Request, res: Response) => {
    const { from, to, confirm } = req.body || {};
    if (confirm !== 'SWITCHOVER') return res.status(400).json({ error: 'confirm_required', message: 'Scrivi SWITCHOVER per confermare.' });
    const st = store.peek(); const target = st.clusters.find((c: any) => c.id === to);
    if (target && requiresApproval(st, target, 'geo_switchover', {})) {
      const key = String(req.headers['idempotency-key'] || `geo-sw-${from}-${to}-${Date.now()}`);
      const r = await requestApproval(store, ops.audit, { cluster: target, type: 'geo_switchover', params: { from, to }, key, actor: actor(req) } as any);
      return res.status(202).json({ approval: r, message: 'Switchover tra siti su un ambiente protetto: serve l’approvazione di un altro amministratore.' });
    }
    const r = await startSwitchover(store, from, to, actor(req));
    res.status(r.code).json(r.body);
  });
}
