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
  link: 'auto' | 'manual';                                           // how the console knows this site belongs to the group: same system identifier, or set by an operator
  declaredPrimary?: string | null;                                   // manual link: the cluster the operator said this one replicates from
}
export interface GeoGroup { sysid: string; sites: Site[]; primary: string | null }

function siteOf(st: any, c: any, now: number): Site & { _sysid: string | null; _lsn: bigint | null } {
  const nodes = (Object.values(st.nodes) as NodeRecord[]).filter(n => n.clusterId === c.id && n.kind !== 'worker');
  const on = nodes.filter(n => online(n, now));
  const prim = on.find(n => n.snapshot?.postgres?.is_in_recovery === false);
  // a site that replicates from another one: Patroni standby cluster (standby leader + standby_cluster), or a plain physical standby (every running
  // node in recovery, streaming from somewhere) registered as a cluster of its own
  const plain = !prim && on.length > 0 && on.every(n => n.snapshot?.postgres?.is_in_recovery === true && !n.snapshot?.patroni?.accessible) ? on.find(n => n.snapshot?.postgres?.wal_receiver) || null : null;
  const sl = on.find(n => n.snapshot?.patroni?.local_node?.role === 'standby_leader') || plain || undefined;
  const sc = nodes.map(n => n.snapshot?.patroni?.standby_cluster).find(x => x && x.host)
    || (plain?.snapshot?.postgres?.wal_receiver?.sender_host ? { host: plain.snapshot.postgres.wal_receiver.sender_host, port: plain.snapshot.postgres.wal_receiver.sender_port, primary_slot_name: plain.snapshot.postgres.wal_receiver.slot_name } : null);
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
    health: 'ok', problems: [], link: 'auto', declaredPrimary: c.geoLink?.primary || null, _sysid: sysid, _lsn: lsnToBig(pg.current_lsn),
  };
}

/** Every group of sites of the same database. Automatic: clusters sharing a system identifier (at least one standby site among them). Manual (geoLink set by an
 *  operator on the standby cluster): pairs clusters the agents cannot match (no agent / no telemetry yet / cluster added without agent) and documents intent;
 *  a manual link whose two sides report DIFFERENT system identifiers is kept but flagged (it cannot be a replica of that cluster). geoLink.none detaches a
 *  cluster from automatic pairing. Pure. */
export function geoGroups(st: any, now = Date.now()): GeoGroup[] {
  const cl = (st.clusters as any[]).filter(c => !c.isSandbox);
  const sites = cl.map(c => siteOf(st, c, now));
  const byId = new Map(sites.map(s => [s.clusterId, s]));
  const linkOf = (id: string) => cl.find(c => c.id === id)?.geoLink || null;
  // union-find over clusters: same sysid (unless detached), plus manual links
  const parent = new Map<string, string>(); const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const bySys = new Map<string, string>();
  for (const s of sites) {
    if (linkOf(s.clusterId)?.none || !s._sysid) continue;
    const o = bySys.get(s._sysid); if (o) join(s.clusterId, o); else bySys.set(s._sysid, s.clusterId);
  }
  const manual = new Set<string>();
  for (const s of sites) { const p = linkOf(s.clusterId)?.primary; if (p && byId.has(p) && p !== s.clusterId) { join(s.clusterId, p); manual.add(s.clusterId); } }
  const groups = new Map<string, typeof sites>();
  for (const s of sites) { if (linkOf(s.clusterId)?.none && !manual.has(s.clusterId)) continue; const r = find(s.clusterId); const l = groups.get(r) || []; l.push(s); groups.set(r, l); }
  const out: GeoGroup[] = [];
  for (const [, list] of groups) {
    const declared = list.some(s => manual.has(s.clusterId));
    // same system identifier alone is not geo-redundancy: a copy restored from a backup of the same cluster has it too. A group needs a standby site
    // (or a link set by an operator).
    const wasSiteC = (x: { clusterId: string }) => { const c = cl.find(k => k.id === x.clusterId); return !!(c?.geoStanza || c?.geoEndpoint) && !c?.geoLink?.none; };
    const splitBrain = list.filter(s => s.role === 'primary' && wasSiteC(s)).length >= 2;
    if (!declared && !splitBrain && !list.some(s => s.role === 'standby')) continue;
    const invalid = new Set<string>();
    for (const s of list) if (manual.has(s.clusterId)) {
      s.link = 'manual';
      if (s.role === 'unknown') s.role = 'standby';                               // declared by the operator, no telemetry to say otherwise
      const dp = list.find(x => x.clusterId === s.declaredPrimary);
      // declared as replica of ANOTHER database: keep the declaration visible (so it can be corrected) but never let it compete as a primary site
      if (dp && dp._sysid && s._sysid && dp._sysid !== s._sysid) { s.role = 'standby'; invalid.add(s.clusterId); }
    }
    const prims = list.filter(s => s.role === 'primary');
    const upHosts = new Set(list.filter(s => s.role === 'standby' && s.upstream).map(s => s.upstream!.host));
    // several writable clusters with the same identifier (e.g. a restored copy): the primary SITE is the one the standby sites point at / were linked to
    const prim = prims.find(s => list.some(x => x.declaredPrimary === s.clusterId)) || prims.find(s => s.endpoint && upHosts.has(s.endpoint.host))
      || prims.find(s => (Object.values(st.nodes) as NodeRecord[]).some(n => n.clusterId === s.clusterId && upHosts.has(String(n.name)))) || prims[0]
      || (declared ? list.find(s => list.some(x => x.declaredPrimary === s.clusterId) && s.role !== 'standby') : undefined);
    const others = prims.filter(s => s !== prim);
    const primNode = prim ? (Object.values(st.nodes) as NodeRecord[]).find(n => n.id === prim.leaderNodeId) : undefined;
    // the primary site's address as its standby sites use it: no need to type it, and it is what a later switchover back needs
    if (prim && !prim.endpoint) { const up = list.find(s => s.role === 'standby' && s.upstream)?.upstream; if (up) { prim.endpoint = { host: up.host, port: up.port }; prim.endpointSource = 'detected'; } }
    if (prim && prim.role === 'unknown') prim.role = 'primary';
    const sysid = list.map(s => s._sysid).find(Boolean) || 'manuale';
    for (const s of list) {
      if (s.role !== 'standby') continue;
      if (prim && prim._lsn !== null && s._lsn !== null) s.lagBytes = prim._lsn >= s._lsn ? Number(prim._lsn - s._lsn) : 0;
      const slotName = s.upstream?.slot;
      const sl = slotName ? (primNode?.snapshot?.postgres?.slots || []).find((x: any) => x.name === slotName) : null;
      s.slot = slotName ? { name: slotName, active: !!sl?.active, retainedBytes: sl?.retained_bytes ?? null } : null;
      const p: string[] = []; let h: Site['health'] = 'ok';
      const bad = (m: string) => { p.push(m); h = 'bad'; }; const warn = (m: string) => { p.push(m); if (h === 'ok') h = 'warn'; };
      const blind = manual.has(s.clusterId) && !s._sysid;                 // declared site with no agent telemetry: nothing to measure, not a failure
      if (blind || invalid.has(s.clusterId)) { /* see the manual-link note below */ }
      else if (!s.online) bad('il sito non ha un nodo raggiungibile');
      else if (prim && prim.timeline != null && s.timeline != null && s.timeline < prim.timeline && s.receiver?.status !== 'streaming')
        // the primary site failed over (new timeline) from a point this site had already passed: it cannot follow until Patroni rewinds it
        bad(`il sito primario è passato alla timeline ${prim.timeline} (failover) e questo sito, fermo alla timeline ${s.timeline}, non riesce a seguirlo: Patroni deve riallinearlo con pg_rewind (serve la regola pg_hba di replica locale e use_pg_rewind), altrimenti i membri vanno ricostruiti`);
      else if (!s.receiver || s.receiver.status !== 'streaming') bad(`non riceve WAL dal sito primario (ricevitore: ${s.receiver?.status || 'assente'})`);
      if (s.receiver?.silentSec != null && s.receiver.silentSec > 120) bad(`nessun messaggio dal sito primario da ${Math.round(s.receiver.silentSec)} s`);
      else if (s.receiver?.silentSec != null && s.receiver.silentSec > 30) warn(`ultimo messaggio dal sito primario ${Math.round(s.receiver.silentSec)} s fa`);
      if (invalid.has(s.clusterId)) s.lagBytes = null;
      if (s.lagBytes != null && s.lagBytes > 1024 * MB) bad(`indietro di ${Math.round(s.lagBytes / MB)} MB`);
      else if (s.lagBytes != null && s.lagBytes > 64 * MB) warn(`indietro di ${Math.round(s.lagBytes / MB)} MB`);
      if (s.slot && !s.slot.active) warn(`lo slot ${s.slot.name} sul sito primario non è attivo: il primario conserva i WAL (${s.slot.retainedBytes != null ? Math.round(s.slot.retainedBytes / MB) + ' MB' : '?'})`);
      if (s.slot?.retainedBytes != null && s.slot.retainedBytes > 8 * 1024 * MB) bad(`lo slot ${s.slot.name} trattiene ${Math.round(s.slot.retainedBytes / MB)} MB di WAL sul sito primario: rischio di disco pieno`);
      if (!prim && !invalid.has(s.clusterId)) warn('nessun sito primario visibile tra i cluster collegati');
      if (s.link === 'manual' && s.declaredPrimary) {
        const dp = list.find(x => x.clusterId === s.declaredPrimary);
        if (dp && dp._sysid && s._sysid && dp._sysid !== s._sysid) bad(`impostato come replica di ${dp.name}, ma è un altro database (identificativo di sistema diverso): non può ricevere i suoi dati`);
        if (!s._sysid) warn('relazione impostata a mano: senza agent su questo cluster lo stato della replica non è misurabile');
      }
      s.problems = p; s.health = h;
    }
    // other writable clusters with the same identifier are not sites of this pair (restored copies, clones): left out, said once on the primary
    // a writable cluster that WAS a site of this pair (it carries the pair's catalogue / address) is not a copy: it is the old primary come back after a
    // DR promotion, or a site promoted by hand -> two primary sites writing different data (split-brain). Copies/clones never were sites.
    const split = others.filter(wasSiteC);
    const copies = others.filter(o => !split.includes(o));
    if (prim && copies.length) { prim.problems.push(`${copies.map(o => o.name).join(', ')}: stesso database ma scrivibile e non collegato (copia ripristinata o clone): non fa parte della georidondanza`); if (prim.health === 'ok') prim.health = 'warn'; }
    if (prim && split.length) for (const x of [prim, ...split]) {
      x.problems.unshift(`DUE SITI PRIMARI: ${[prim, ...split].map(o => o.name).join(' e ')} accettano scritture separatamente (split-brain, es. il vecchio primario tornato dopo una promozione DR). Ferma le scritture su quello da scartare e ricostruiscilo come sito di replica`);
      x.health = 'bad';
    }
    const keep = list.filter(s => !copies.includes(s) || list.some(x => x.declaredPrimary === s.clusterId));
    if (keep.length < 2 && !keep.some(s => s.role === 'standby') && !split.length) continue;
    out.push({ sysid, sites: keep.map(({ _sysid, _lsn, ...rest }) => rest), primary: prim?.clusterId || null });
  }
  return out;
}

export function geoOf(st: any, clusterId: string) {
  for (const g of geoGroups(st)) { const me = g.sites.find(s => s.clusterId === clusterId); if (me) return { ...me, peers: g.sites.filter(s => s.clusterId !== clusterId), sysid: g.sysid }; }
  return null;
}

/** Stanza name the agent derives from a cluster key (pg_arca/engine/ctx.py _stanza_name): "patroni:geo-dc1" -> "patroni-geo-dc1". */
export const stanzaOf = (key: string) => key.replace(/:/g, '-').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);

/** One database = one backup catalogue, whichever site takes the backup: the sites of a geo group share a stanza (decided once, kept across switchovers):
 *  the one that already holds the most backups, else the primary site's own. Sent to the agents in the heartbeat answer. Pure: the caller applies it. */
export function geoStanzaPlan(d: any, clusterId: string): { ids: string[]; stanza: string } | null {
  const c = d.clusters.find((x: any) => x.id === clusterId);
  if (!c || c.isSandbox || c.geoStanza) return null;
  const g = geoGroups(d).find(x => x.sites.some(s => s.clusterId === clusterId));
  if (!g || g.sites.length < 2) return null;
  const sites = g.sites.map(s => d.clusters.find((x: any) => x.id === s.clusterId)).filter(Boolean);
  let pick = sites.map((x: any) => x.geoStanza).find(Boolean) as string | undefined;
  if (!pick) {
    const reported = (Object.values(d.nodes) as NodeRecord[]).filter(n => g.sites.some(s => s.clusterId === n.clusterId) && n.snapshot?.backup?.stanza && (n.snapshot.backup.sets || 0) > 0)
      .sort((a, b) => (b.snapshot!.backup.sets || 0) - (a.snapshot!.backup.sets || 0));
    pick = reported[0]?.snapshot?.backup?.stanza;
  }
  if (!pick && g.primary) { const key = (Object.values(d.nodes) as NodeRecord[]).find(n => n.clusterId === g.primary && n.clusterKey)?.clusterKey; if (key) pick = stanzaOf(key); }
  if (!pick || !/^[A-Za-z0-9_.-]{1,60}$/.test(pick)) return null;
  return { ids: sites.filter((x: any) => !x.geoStanza).map((x: any) => x.id), stanza: pick };
}

/** Parameters a hot standby must have at least as high as its primary: raising one on the primary SITE first stops the standby sites
 *  ("hot standby is not possible because ... = N is a lower setting than on the primary server"). Patroni keeps the members of ONE site in step, not the sites. */
export const STANDBY_MIN_PARAMS = ['max_connections', 'max_prepared_transactions', 'max_locks_per_transaction', 'max_wal_senders', 'max_worker_processes'];
export function geoParamGuard(st: any, clusterId: string, name: string, value: any): string | null {
  if (!STANDBY_MIN_PARAMS.includes(name) || value === null || value === undefined) return null;
  const v = Number(value); if (!Number.isFinite(v)) return null;
  const me = geoOf(st, clusterId); if (!me || me.role !== 'primary') return null;
  const low = me.peers.filter(p => p.role === 'standby').map(p => {
    const vals = (Object.values(st.nodes) as NodeRecord[]).filter(n => n.clusterId === p.clusterId).map(n => Number(n.snapshot?.postgres?.settings?.[name])).filter(Number.isFinite);
    return { name: p.name, cur: vals.length ? Math.min(...vals) : null };
  }).filter(x => x.cur !== null && x.cur < v);
  return low.length ? `${name} = ${v} sul sito primario supera il valore dei siti di replica (${low.map(x => `${x.name}: ${x.cur}`).join(', ')}): i loro standby si fermerebbero ("hot standby is not possible"). Alza prima ${name} sui siti di replica, poi qui.` : null;
}

/** Health findings for the briefing ("Oggi"): one per standby site in trouble. */
export function geoIssues(st: any, now = Date.now()) {
  const out: any[] = [];
  for (const g of geoGroups(st, now)) for (const s of g.sites) {
    if (s.health === 'ok' || (s.role !== 'standby' && !s.problems.some(p => p.startsWith('DUE SITI PRIMARI')))) continue;
    out.push({ key: `${s.clusterId}:geo_replication`, clusterId: s.clusterId, clusterName: s.name, environment: s.environment, severity: s.health === 'bad' ? 'critical' : 'warning', code: 'geo_replication',
      title: s.role === 'standby' ? `Sito di replica ${s.name}: ${s.problems[0]}` : `${s.name}: ${s.problems[0]}`,
      cause: s.role === 'standby' ? s.problems.join('; ') + '. In caso di disastro sul sito primario, i dati non ancora arrivati qui andrebbero persi.' : s.problems.join('; '), action: { label: 'Apri la georidondanza', page: 'geo' } });
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
    res.json({ groups: geoGroups(st).map(g => ({ ...g, stanza: g.sites.map(x => st.clusters.find((c: any) => c.id === x.clusterId)?.geoStanza).find(Boolean) || null })), jobs: Object.values(st.settings.geoJobs || {}).sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10) });
  });
  app.get('/api/clusters/:id/geo', (req: Request, res: Response) => res.json({ geo: geoOf(store.peek(), req.params.id) }));

  /** Primary / standby relationship set by an operator (when it cannot be detected, or to make intent explicit). primary: cluster id | null (back to
   *  automatic); none: true detaches the cluster from automatic pairing. Refuses self-links and cycles. */
  app.put('/api/clusters/:id/geo-link', async (req: Request, res: Response) => {
    const { primary, none } = req.body || {};
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    if (primary != null) {
      const p = st.clusters.find((x: any) => x.id === primary);
      if (!p || p.isSandbox || p.id === c.id) return res.status(400).json({ error: 'invalid_primary', message: 'Scegli un altro cluster collegato.' });
      let cur: any = p; const seen = new Set([c.id]);
      while (cur?.geoLink?.primary) { if (seen.has(cur.geoLink.primary)) return res.status(400).json({ error: 'cycle', message: `${p.name} risulta già replica di ${c.name}: la relazione sarebbe circolare.` }); seen.add(cur.id); cur = st.clusters.find((x: any) => x.id === cur.geoLink.primary); }
    }
    await store.mutate(d => { const x = d.clusters.find((y: any) => y.id === c.id); if (!x) return;
      x.geoLink = primary != null ? { primary: String(primary), at: nowIso(), by: actor(req) } : none ? { none: true, at: nowIso(), by: actor(req) } : undefined;
      ops.audit(d, { clusterId: c.id, actor: actor(req), action: 'geo.link', status: 'OK', details: x.geoLink || { auto: true } }); });
    res.json({ ok: true, geo: geoOf(store.peek(), c.id) });
  });

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

  /** Split-brain remedy: one of two writable sites becomes a standby site of the other (geo_demote with the other's address). Its writes since the fork are
   *  abandoned: Patroni rewinds or rebuilds its members from the chosen primary. Explicit confirmation, four-eyes on protected environments. */
  app.post('/api/geo/demote', async (req: Request, res: Response) => {
    const { clusterId, to, confirm } = req.body || {};
    const key = String(req.headers['idempotency-key'] || ''); if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    if (confirm !== 'DECLASSA') return res.status(400).json({ error: 'confirm_required', message: 'Scrivi DECLASSA per confermare.' });
    const st = store.peek(); const me = geoOf(st, clusterId); const target = st.clusters.find((c: any) => c.id === to);
    if (!me || !target || !me.peers.some(p => p.clusterId === to)) return res.status(409).json({ error: 'not_paired', message: 'I due cluster non risultano siti dello stesso database.' });
    if (me.role !== 'primary') return res.status(409).json({ error: 'not_primary', message: `${me.name} non accetta scritture: è già un sito di replica.` });
    const ep = target.geoEndpoint || geoOf(st, to)?.endpoint;
    if (!ep) return res.status(409).json({ error: 'endpoint_required', message: `Indica prima come raggiungere ${target.name} (indirizzo del suo leader).` });
    const params = { host: ep.host, port: ep.port, primary_slot_name: geoSlotFor(me.name), confirm: 'DECLASSA' };
    const cluster = st.clusters.find((c: any) => c.id === clusterId);
    if (requiresApproval(st, cluster, 'geo_demote', params)) {
      const r = await requestApproval(store, ops.audit, { cluster, type: 'geo_demote', params, key, actor: actor(req) } as any);
      return res.status(202).json({ approval: r, message: 'Operazione rischiosa su un ambiente protetto: serve l’approvazione di un altro amministratore.' });
    }
    try { const op = await submitTo(store, clusterId, 'geo_demote', params, key, actor(req)); res.status(202).json({ operation: op }); }
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
