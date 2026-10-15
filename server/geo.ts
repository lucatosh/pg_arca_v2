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
import { startFailover, policyOf, watchOf, snooze, GEO_POLICY_DEFAULT } from './geodr';

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
  upstream?: { host: string; port: number; slot?: string; archive?: boolean } | null; // standby site: where it replicates from (+ archive fallback)
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
    upstream: sc ? { host: String(sc.host), port: Number(sc.port || 5432), slot: sc.primary_slot_name || undefined, archive: !!sc.restore_command } : null,
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
    // a pair the console already knows (it remembers its primary): kept while a site is down or after a failover left no standby yet
    const knownPair = (() => { const sid = list.map(s => s._sysid).find(Boolean); return !!sid && list.length > 1 && !!(st.settings?.geoLastPrimary || {})[sid]; })();
    if (!declared && !splitBrain && !knownPair && !list.some(s => s.role === 'standby')) continue;
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
    // after a DR failover the promoted site IS the primary, also while the old primary is back and still writable (it is about to be rejoined)
    const fo = (Object.values(st.settings?.geoFailovers || {}) as any[]).find(f => !f.rejoinedAt && list.some(s => s.clusterId === f.to) && list.some(s => s.clusterId === f.from));
    const prim = (fo ? prims.find(s => s.clusterId === fo.to) : undefined) || prims.find(s => list.some(x => x.declaredPrimary === s.clusterId)) || prims.find(s => s.endpoint && upHosts.has(s.endpoint.host))
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
      else if (!s.online) bad('the site has no reachable node');
      else if (prim && prim.timeline != null && s.timeline != null && s.timeline < prim.timeline && s.receiver?.status !== 'streaming')
        // the primary site failed over (new timeline) from a point this site had already passed: it cannot follow until Patroni rewinds it
        bad(`the primary site moved to timeline ${prim.timeline} (failover) and this site, stuck on timeline ${s.timeline}, cannot follow it: Patroni has to realign it with pg_rewind (this needs the local replication pg_hba rule and use_pg_rewind), otherwise the members must be reinitialized`);
      else if ((!s.receiver || s.receiver.status !== 'streaming') && s.upstream?.archive && ((s.replayDelaySec != null && s.replayDelaySec < 600) || (s.lagBytes != null && s.lagBytes < 64 * MB)))
        // the WAN is down but the archive fallback keeps it close: degraded, not lost
        warn(`streaming from the primary site interrupted (WAL receiver: ${s.receiver?.status || 'absent'}): catching up from the WAL archive${s.lagBytes != null ? `, ${Math.round(s.lagBytes / MB)} MB behind` : ''}`);
      else if (!s.receiver || s.receiver.status !== 'streaming') bad(`not receiving WAL from the primary site (WAL receiver: ${s.receiver?.status || 'absent'})`);
      if (s.upstream?.archive && s.receiver?.status !== 'streaming') { /* silence measured on the receiver is meaningless while it catches up from the archive */ }
      else if (s.receiver?.silentSec != null && s.receiver.silentSec > 120) bad(`no message from the primary site for ${Math.round(s.receiver.silentSec)} s`);
      else if (s.receiver?.silentSec != null && s.receiver.silentSec > 30) warn(`last message from the primary site ${Math.round(s.receiver.silentSec)} s ago`);
      if (invalid.has(s.clusterId)) s.lagBytes = null;
      if (s.lagBytes != null && s.lagBytes > 1024 * MB) bad(`${Math.round(s.lagBytes / MB)} MB behind`);
      else if (s.lagBytes != null && s.lagBytes > 64 * MB) warn(`${Math.round(s.lagBytes / MB)} MB behind`);
      if (s.slot && !s.slot.active) warn(`slot ${s.slot.name} on the primary site is not active: the primary retains WAL (${s.slot.retainedBytes != null ? Math.round(s.slot.retainedBytes / MB) + ' MB' : '?'})`);
      if (s.slot?.retainedBytes != null && s.slot.retainedBytes > 8 * 1024 * MB) bad(`slot ${s.slot.name} retains ${Math.round(s.slot.retainedBytes / MB)} MB of WAL on the primary site: risk of a full disk`);
      if (!prim && !invalid.has(s.clusterId)) warn('no primary site visible among the connected clusters');
      if (s.link === 'manual' && s.declaredPrimary) {
        const dp = list.find(x => x.clusterId === s.declaredPrimary);
        if (dp && dp._sysid && s._sysid && dp._sysid !== s._sysid) bad(`set as a standby of ${dp.name}, but it is a different database (different system identifier): it cannot receive its data`);
        if (!s._sysid) warn('relationship set by hand: without an agent on this cluster the replication state cannot be measured');
      }
      s.problems = p; s.health = h;
    }
    // other writable clusters with the same identifier are not sites of this pair (restored copies, clones): left out, said once on the primary
    // a writable cluster that WAS a site of this pair (it carries the pair's catalogue / address) is not a copy: it is the old primary come back after a
    // DR promotion, or a site promoted by hand -> two primary sites writing different data (split-brain). Copies/clones never were sites.
    const split = others.filter(wasSiteC);
    const copies = others.filter(o => !split.includes(o));
    if (prim && copies.length) { prim.problems.push(`${copies.map(o => o.name).join(', ')}: same database but writable and not linked (restored copy or clone): not part of the geo-redundancy`); if (prim.health === 'ok') prim.health = 'warn'; }
    if (prim && split.length) for (const x of [prim, ...split]) {
      x.problems.unshift(`TWO PRIMARY SITES: ${[prim, ...split].map(o => o.name).join(' and ')} accept writes separately (split-brain, e.g. the old primary back after a DR promotion). Stop writes on the one to discard and rebuild it as a standby site`);
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

/** Endpoints a site may be demoted under: its live peers, and the sites it was paired with in a recorded failover. A site whose PostgreSQL does not
 *  start (exactly when it must be rebuilt) has no system identifier to be grouped by, so the live group alone left it with no peer and
 *  "Demote with rebuild" was refused (seen on the lab after a rejoin interrupted by a console restart). */
export function knownPeerEndpoints(st: any, clusterId: string): { host: string; port: number }[] {
  const out: any[] = []; const me = geoOf(st, clusterId);
  for (const p of me?.peers || []) if (p.endpoint) out.push(p.endpoint);
  for (const f of Object.values(st.settings?.geoFailovers || {}) as any[]) {
    const other = f?.from === clusterId ? f.to : f?.to === clusterId ? f.from : null; if (!other) continue;
    const c = (st.clusters || []).find((x: any) => x.id === other); if (c?.geoEndpoint?.host) out.push(c.geoEndpoint);
  }
  return out;
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
  return low.length ? `${name} = ${v} on the primary site exceeds the value on the standby sites (${low.map(x => `${x.name}: ${x.cur}`).join(', ')}): their standbys would stop ("hot standby is not possible"). Raise ${name} on the standby sites first, then here.` : null;
}

/* ====================================================================================================================================================
 * DR readiness of a pair of sites: "if the primary site burns down now, does the standby site take over cleanly, and how much data is lost?"
 * Everything is derived from the agents' telemetry (no extra operation): the conditions a geo-redundant Patroni deployment silently depends on.
 * ==================================================================================================================================================== */
export interface ReadyCheck { id: string; level: 'ok' | 'warn' | 'bad' | 'info'; text: string; fix?: string; site?: string; clusterId?: string; action?: 'archive_fallback' | 'enable_rewind' }
export const GEO_RPO_DEFAULT_SEC = 60;
const DAY = 86400_000;
const major = (v: any) => { const m = /^(\d+)/.exec(String(v || '')); return m ? Number(m[1]) : null; };
export function geoReadiness(st: any, g: GeoGroup, now = Date.now()) {
  const checks: ReadyCheck[] = [];
  const add = (c: ReadyCheck) => checks.push(c);
  const nodesOf = (cid: string) => (Object.values(st.nodes) as NodeRecord[]).filter(n => n.clusterId === cid && n.kind !== 'worker');
  const lead = (site: Site) => (Object.values(st.nodes) as NodeRecord[]).find(n => n.id === site.leaderNodeId) || nodesOf(site.clusterId).find(n => online(n, now));
  const prim = g.sites.find(s => s.clusterId === g.primary);
  const rpoTarget = Number(st.settings.geoRpoSec) > 0 ? Number(st.settings.geoRpoSec) : GEO_RPO_DEFAULT_SEC;
  let rpo: number | null = null;
  if (!prim) { add({ id: 'primary', level: 'bad', text: 'no primary site visible' }); return { checks, status: 'not_ready' as const, rpoSec: null, rpoTargetSec: rpoTarget, lastTest: null }; }
  const pn = lead(prim); const pv: any = pn?.snapshot?.patroni || {}; const ppg: any = pn?.snapshot?.postgres || {};
  const primHosts = new Set(nodesOf(prim.clusterId).flatMap(n => [n.name, String(n.remoteIp || '').replace(/^::ffff:/, ''), ...((n.snapshot?.patroni?.members || []) as any[]).map(m => String(m.host || ''))]).filter(Boolean));
  for (const s of g.sites.filter(x => x.role === 'standby')) {
    const sn = lead(s); const sv: any = sn?.snapshot?.patroni || {}; const spg: any = sn?.snapshot?.postgres || {};
    const at = (t: string) => `${s.name}: ${t}`;
    // same major version (a standby of another major cannot replay the WAL)
    const a = major(ppg.version), b = major(spg.version);
    if (a && b && a !== b) add({ id: 'version', level: 'bad', site: s.name, text: at(`PostgreSQL ${b} vs ${a} on the primary site: physical replication requires the same major version`) });
    // the slot that keeps the WAL for this site must be PERMANENT (declared in the primary site's DCS), or it disappears at the primary site's first failover
    const slot = s.upstream?.slot;
    if (!slot) add({ id: 'slot', level: sv.standby_cluster?.restore_command ? 'info' : 'warn', site: s.name, text: at('replication without a slot: if it falls behind more than wal_keep_size, the WAL it needs is removed on the primary site'),
      fix: 'declare a permanent slot in the primary site’s DCS (slots: {name: {type: physical}}) and set it in standby_cluster.primary_slot_name' });
    else if (Array.isArray(pv.permanent_slots) && !pv.permanent_slots.includes(slot)) add({ id: 'slot', level: 'bad', site: s.name, text: at(`slot ${slot} exists only on the current leader of the primary site and is not permanent in its DCS: at the primary site’s first failover it disappears and this replication breaks`),
      fix: `add ${slot} to “slots” in the primary site’s dynamic configuration (patronictl edit-config)` });
    else add({ id: 'slot', level: 'ok', site: s.name, text: at(`slot ${slot} is permanent in the primary site’s DCS`) });
    // the standby site must follow the primary site's LEADER, not one node: a node name/IP stops working at the primary site's first failover
    if (s.upstream && primHosts.has(s.upstream.host)) add({ id: 'upstream', level: 'warn', site: s.name, text: at(`replicates from ${s.upstream.host}, a single node of the primary site: after a failover there, replication stops`),
      fix: 'point standby_cluster.host to an address that follows the leader (HAProxy, VIP, Patroni-managed DNS)' });
    else if (s.upstream) add({ id: 'upstream', level: 'ok', site: s.name, text: at(`replicates from ${s.upstream.host}:${s.upstream.port}, an address that follows the leader`) });
    // archive fallback: with restore_command the standby site can catch up from the WAL archive when streaming is not possible (slot lost, long WAN outage)
    if (sv.standby_cluster && !sv.standby_cluster.restore_command) add({ id: 'archive', level: 'warn', site: s.name, clusterId: s.clusterId, action: 'archive_fallback', text: at('no restore_command in standby_cluster: without streaming it cannot recover from the WAL archive'),
      fix: 'add standby_cluster.restore_command (e.g. pg-arca-wal get %f %p) to recover from the shared archive' });
    else if (sv.standby_cluster?.restore_command) add({ id: 'archive', level: 'ok', site: s.name, text: at('WAL archive fallback active (restore_command in standby_cluster)') });
    // after a promotion this site IS the database: without archiving there is no point-in-time restore any more (the shared archive stops at the failover)
    const am = String(spg.settings?.archive_mode ?? '').toLowerCase(); const ac = String(spg.settings?.archive_command ?? '');
    if (am && am !== 'on' && am !== 'always') add({ id: 'standby_archive', level: 'warn', site: s.name, clusterId: s.clusterId, text: at('WAL archiving is off: after a failover the new primary does not archive and point-in-time restores stop there'),
      fix: 'enable archiving on this site too (Protection → Backup → “Enable WAL archiving”: with Patroni it goes through its DCS), to the same archive as the primary site' });
    else if (am && !/pg-arca-wal|pg_arca/.test(ac)) add({ id: 'standby_archive', level: 'warn', site: s.name, clusterId: s.clusterId, text: at(`archive_command is not pg_arca’s (${ac.slice(0, 60) || 'empty'}): after a failover WAL does not reach the shared archive`) });
    else if (am) add({ id: 'standby_archive', level: 'ok', site: s.name, text: at('archiving ready: after a failover it continues into the same archive') });
    // parameters a hot standby needs at least as high as its primary
    for (const k of STANDBY_MIN_PARAMS) {
      const pvv = Number(ppg.settings?.[k]), svv = Number(spg.settings?.[k]);
      if (Number.isFinite(pvv) && Number.isFinite(svv) && svv < pvv) add({ id: 'param:' + k, level: 'bad', site: s.name, text: at(`${k} = ${svv}, lower than on the primary site (${pvv}): hot standby stops ("hot standby is not possible")`), fix: `raise ${k} on the standby site` });
    }
    // RPO: how much would be lost if the primary site vanished now
    const r = s.lagBytes === 0 ? 0 : (s.receiver?.status === 'streaming' && s.receiver.silentSec != null && s.receiver.silentSec < 10 && (s.lagBytes ?? 0) < 16 * MB) ? Math.round(s.receiver.silentSec) : (s.replayDelaySec ?? null);
    rpo = r === null ? rpo : Math.max(rpo ?? 0, r);
    if (r === null) add({ id: 'rpo', level: 'warn', site: s.name, text: at('data loss in a disaster cannot be measured (no replication data)') });
    else add({ id: 'rpo', level: r > rpoTarget ? (r > rpoTarget * 10 ? 'bad' : 'warn') : 'ok', site: s.name, text: at(`estimated loss in a disaster: ${r < 1 ? 'none' : `about ${r} s of transactions`} (target ${rpoTarget} s)${s.lagBytes ? ` · ${Math.round(s.lagBytes / MB)} MB to receive` : ''}`) });
    if (!s.endpoint) add({ id: 'endpoint', level: 'warn', site: s.name, text: at('the address other sites would reach it with is not set: needed for the planned switchover'), fix: 'set it in Geo-redundancy → “Address of …”' });
    // after a promotion this site must be able to rewind / re-follow
    if (sv.accessible && sv.use_pg_rewind !== true) add({ id: 'rewind', level: 'warn', site: s.name, clusterId: s.clusterId, action: 'enable_rewind', text: at('pg_rewind is off: when the old primary comes back its members must be fully reinitialized'), fix: 'postgresql.use_pg_rewind: true in the DCS' });
    if (spg.hba_patroni_local?.ok === false) add({ id: 'hba_local', level: 'bad', site: s.name, text: at('pg_hba does not allow Patroni local replication: after a failover the site stays stuck'), fix: spg.hba_patroni_local.suggest?.[0] });
  }
  if (!prim.endpoint) add({ id: 'endpoint', level: 'warn', site: prim.name, text: `${prim.name}: address for the other sites unknown (needed for the switchback)` });
  const pol = policyOf(st, g.sysid);
  if (pol.autoFailover) for (const s of g.sites.filter(x => x.role === 'standby')) {
    // after an automatic failover the old primary must follow THIS site by itself: its address is what makes that possible
    if (!s.endpoint) add({ id: 'dr_endpoint', level: 'bad', site: s.name, text: `${s.name}: automatic failover is on but the address the other sites reach it with is not set: after the failover ${prim.name} could not become its standby by itself`, fix: `set it in Geo-redundancy → “Address of ${s.name}”` });
    else add({ id: 'dr_endpoint', level: 'ok', site: s.name, text: `${s.name}: automatic failover on (confirmation ${pol.confirmSec} s, maximum loss ${pol.maxLossMB} MB)${pol.autoRejoin ? ', old primary rejoined automatically' : ''}` });
  }
  // the primary site must see the shared archive too (restore_command in postgresql.recovery_conf): when it comes back after a failover and promotes
  // itself it then picks a timeline number the other site has not used. Without it two timelines share a number: Patroni and pg_rewind cannot tell
  // them apart, the old site needs a full rebuild and the archiver of the new primary blocks on the history file.
  if (pv.accessible && !pv.standby_cluster && !pv.recovery_restore_command) add({ id: 'archive_primary', level: 'warn', site: prim.name, clusterId: prim.clusterId, action: 'archive_fallback',
    text: `${prim.name}: no restore_command (postgresql.recovery_conf): if it comes back after a failover it can reuse the other site’s timeline number, and then it must be fully rebuilt and archiving stalls`,
    fix: 'enable “Recovery from the archive” on the primary site too (restore_command in its DCS)' });
  else if (pv.accessible && !pv.standby_cluster) add({ id: 'archive_primary', level: 'ok', site: prim.name, text: `${prim.name}: sees the shared archive (restore_command): a promotion of it cannot reuse a timeline number` });
  if (pv.accessible && pv.use_pg_rewind !== true) add({ id: 'rewind', level: 'warn', site: prim.name, clusterId: prim.clusterId, action: 'enable_rewind', text: `${prim.name}: pg_rewind is off: an old primary cannot become a standby site without a rebuild`, fix: 'postgresql.use_pg_rewind: true in the DCS' });
  if (ppg.hba_patroni_local?.ok === false) add({ id: 'hba_local', level: 'bad', site: prim.name, text: `${prim.name}: pg_hba does not allow Patroni local replication`, fix: ppg.hba_patroni_local.suggest?.[0] });
  // the primary site's archiver: blocked, it stops the shared archive (and the DR site's fallback, and point-in-time restore) right there
  const parch: any = ppg.archiver;
  if (parch?.last_failed_time && (!parch.last_archived_time || Date.parse(parch.last_failed_time) > Date.parse(parch.last_archived_time)) && now - Date.parse(parch.last_failed_time) < 3600_000)
    add({ id: 'archiver', level: 'bad', site: prim.name, clusterId: prim.clusterId, text: `${prim.name}: WAL archiving is stuck on ${parch.last_failed_wal || '?'}: the shared archive (the standby site’s fallback and point-in-time restores) stopped there`,
      fix: 'open “Today” for the cause and the fix' });
  // backups: one catalogue for the database, recent, usable from the DR site too
  const sets = (nodesOf(prim.clusterId).map(n => n.snapshot?.backup?.recent_sets).find(x => Array.isArray(x) && x.length) || []) as any[];
  const lastOk = sets.filter(x => x.status === 'COMPLETE').map(x => Date.parse(x.start_time)).filter(Number.isFinite).sort().pop();
  if (!lastOk) add({ id: 'backup', level: 'warn', text: 'no full backup of the database: if both sites are lost there is nothing left to restore', fix: 'assign a backup policy to the pair' });
  else add({ id: 'backup', level: now - lastOk > 8 * DAY ? 'warn' : 'ok', text: `last backup ${Math.round((now - lastOk) / 3600_000)} h ago, catalog shared by the sites` });
  // the switchover has been TRIED: when, and how long it took (the RTO actually measured)
  const jobs = (Object.values(st.settings.geoJobs || {}) as any[]).filter(j => j.status === 'succeeded' && g.sites.some(x => x.clusterId === j.from) && g.sites.some(x => x.clusterId === j.to));
  const last = jobs.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))[0];
  const lastTest = last ? { at: last.finishedAt || last.createdAt, seconds: last.finishedAt ? Math.round((Date.parse(last.finishedAt) - Date.parse(last.createdAt)) / 1000) : null, from: last.fromName, to: last.toName } : null;
  if (!lastTest) add({ id: 'tested', level: 'info', text: 'switchover between the sites never tested from this console: a planned test measures the real changeover time' });
  else add({ id: 'tested', level: now - Date.parse(lastTest.at) > 180 * DAY ? 'info' : 'ok', text: `last switchover ${lastTest.from} → ${lastTest.to} ${Math.round((now - Date.parse(lastTest.at)) / DAY)} days ago${lastTest.seconds != null ? `, took ${lastTest.seconds} s` : ''}` });
  const status = checks.some(c => c.level === 'bad') ? 'not_ready' as const : checks.some(c => c.level === 'warn') ? 'degraded' as const : 'ready' as const;
  return { checks, status, rpoSec: rpo, rpoTargetSec: rpoTarget, lastTest };
}

/** Health findings for the briefing ("Oggi"): one per standby site in trouble. */
export function geoIssues(st: any, now = Date.now()) {
  const out: any[] = [];
  for (const g of geoGroups(st, now)) {
    const w = watchOf(g.sysid); const f = (st.settings.geoFailovers || {})[g.sysid];
    const pc = st.clusters.find((c: any) => c.id === (w?.primary || g.primary)); const pol = policyOf(st, g.sysid);
    if (w?.downSince && pc) out.push({ key: `${pc.id}:geo_primary_lost`, clusterId: pc.id, clusterName: pc.name, environment: pc.environment, severity: 'critical', code: 'geo_primary_lost',
      title: `Primary site ${pc.name} unreachable${pol.autoFailover ? ' — automatic failover being prepared' : ' — a decision is needed'}`,
      cause: `The console cannot hear its nodes and ${w.witnesses.standbyName || 'the standby site'} no longer receives WAL. ${pol.autoFailover ? `Unless something changes, ${w.candidateName} is promoted in ${w.actInSec ?? 0} s.` : `If ${pc.name} is lost, promote ${w.candidateName}.`}`, action: { label: 'Open geo-redundancy', page: 'geo' } });
    if (f && !f.rejoinedAt) { const fc = st.clusters.find((c: any) => c.id === f.from);
      if (fc) out.push({ key: `${fc.id}:geo_failed_over`, clusterId: fc.id, clusterName: fc.name, environment: fc.environment, severity: 'warning', code: 'geo_failed_over',
        title: `${f.toName} is primary after a disaster recovery: ${f.fromName} is not its standby yet`, cause: f.rejoinError ? `Rejoin failed: ${f.rejoinError}` : `The pair is not protected until ${f.fromName} comes back as a standby site.`, action: { label: 'Open geo-redundancy', page: 'geo' } }); }
  }
  for (const g of geoGroups(st, now)) {                  // the pair would not survive the loss of the primary site cleanly: said once, on the primary site
    if (!g.primary) continue;
    const r = geoReadiness(st, g, now); const bad = r.checks.filter(c => c.level === 'bad');
    const pc = st.clusters.find((c: any) => c.id === g.primary);
    if (bad.length && pc) out.push({ key: `${pc.id}:geo_dr_readiness`, clusterId: pc.id, clusterName: pc.name, environment: pc.environment, severity: 'warning', code: 'geo_dr_readiness',
      title: `Geo-redundancy not ready for disaster recovery: ${bad[0].text}`, cause: bad.map(c => c.text + (c.fix ? ` (${c.fix})` : '')).join('; '), action: { label: 'Open geo-redundancy', page: 'geo' } });
  }
  for (const g of geoGroups(st, now)) for (const s of g.sites) {
    if (s.health === 'ok' || (s.role !== 'standby' && !s.problems.some(p => p.startsWith('TWO PRIMARY SITES')))) continue;
    out.push({ key: `${s.clusterId}:geo_replication`, clusterId: s.clusterId, clusterName: s.name, environment: s.environment, severity: s.health === 'bad' ? 'critical' : 'warning', code: 'geo_replication',
      title: s.role === 'standby' ? `Standby site ${s.name}: ${s.problems[0]}` : `${s.name}: ${s.problems[0]}`,
      cause: s.role === 'standby' ? s.problems.join('; ') + '. In a disaster on the primary site, the data not yet received here would be lost.' : s.problems.join('; '), action: { label: 'Open geo-redundancy', page: 'geo' } });
  }
  return out;
}

const pick = (st: any, clusterId: string) => {
  const nodes = (Object.values(st.nodes) as NodeRecord[]).filter(n => n.clusterId === clusterId && online(n));
  return nodes.find(n => n.snapshot?.patroni?.accessible && (n.snapshot?.postgres?.is_in_recovery === false || n.snapshot?.patroni?.local_node?.role === 'standby_leader')) || nodes.find(n => n.snapshot?.patroni?.accessible);
};

export async function submitTo(store: Store, clusterId: string, type: string, params: any, key: string, actor: string) {
  const st = store.peek(); const n = pick(st, clusterId);
  if (!n) throw Object.assign(new Error('no node of the site with a reachable Patroni'), { status: 409 });
  const c = conflictFor(st.operations, clusterId, type, params, actor);
  if (c) throw Object.assign(new Error(c.message), { status: 409, body: c });
  const { op } = await ops.submit(store, { type, clusterId, nodeId: n.id, params, idempotencyKey: key, createdBy: actor, ttlSeconds: 300 });
  return op;
}
export async function waitOp(store: Store, id: string, timeoutMs: number) {
  const t0 = Date.now();
  for (;;) {
    const o = store.peek().operations.find(x => x.id === id);
    if (o && ops.isTerminal(o.status)) return o;
    if (Date.now() - t0 > timeoutMs) throw new Error('operation not finished in time');
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
    if (!g) throw new Error('the two clusters are not sites of the same database');
    const from = g.sites.find(s => s.clusterId === job.from)!, to = g.sites.find(s => s.clusterId === job.to)!;
    if (from.role !== 'primary') throw new Error(`${from.name} is not the primary site`);
    if (to.role !== 'standby' || to.health === 'bad') throw new Error(`${to.name} is not a healthy standby site: ${to.problems.join('; ') || to.role}`);
    if ((to.lagBytes ?? 0) > 16 * MB) throw new Error(`${to.name} is ${Math.round((to.lagBytes || 0) / MB)} MB behind: wait until it catches up`);
    const slot = geoSlotFor(from.name);
    await step(`1/4 ${from.name} becomes a standby site of ${to.name} (${job.toEndpoint.host}:${job.toEndpoint.port}): writes on ${from.name} stop`);
    // the slot the target site used on this one is useless once it is primary (and a standby site must not hold WAL for nobody): dropped in the same DCS change
    const drop = to.upstream?.slot && /^[a-z0-9_]{1,63}$/.test(to.upstream.slot) && to.upstream.slot !== slot ? [to.upstream.slot] : [];
    const d = await submitTo(store, job.from, 'geo_demote', { host: job.toEndpoint.host, port: job.toEndpoint.port, primary_slot_name: slot, drop_slots: drop, confirm: 'DEMOTE' }, `geo:${job.id}:demote`, job.actor);
    const dr = await waitOp(store, d.id, 240_000);
    if (dr.status !== 'succeeded') throw new Error(`demotion of ${from.name} failed: ${dr.error || dr.status}`);
    await step(`2/4 waiting for ${to.name} to receive and replay everything ${from.name} wrote`);
    const fromLsn = lsnToBig(store.peek().nodes[dr.nodeId!]?.snapshot?.postgres?.current_lsn) ?? 0n;
    const t0 = Date.now(); let ok = false;
    while (Date.now() - t0 < 120_000) {
      const t = geoGroups(store.peek()).flatMap(x => x.sites).find(s => s.clusterId === job.to);
      const tl = lsnToBig(t?.lsn || null);
      if (tl !== null && tl >= fromLsn) { ok = true; break; }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!ok) throw new Error(`${to.name} did not reach the position of ${from.name} within 2 minutes: it is NOT promoted (${from.name} stays a standby site, no data lost: you can go back by promoting ${from.name})`);
    await step(`3/4 promoting ${to.name} (slot ${slot} created for ${from.name})`);
    const p = await submitTo(store, job.to, 'geo_promote', { confirm: 'PROMOTE', slot_for_peer: slot }, `geo:${job.id}:promote`, job.actor);
    const pr = await waitOp(store, p.id, 240_000);
    if (pr.status !== 'succeeded') throw new Error(`promotion of ${to.name} failed: ${pr.error || pr.status}`);
    submitTo(store, job.to, 'geo_archive_fallback', { enable: true }, `geo:${job.id}:archive-primary`, job.actor).catch(() => undefined);   // keeps seeing the shared archive (timeline numbers)
    await step(`4/4 completed: ${to.name} is the primary site, ${from.name} replicates from it`, 'succeeded', { finishedAt: nowIso() });
    await store.mutate(d2 => ops.audit(d2, { clusterId: job.to, actor: job.actor, action: 'geo.switchover', status: 'OK', details: { from: job.from, to: job.to } }));
  } catch (e: any) {
    await step(`stopped: ${e.message}`, "failed", { finishedAt: nowIso(), error: e.message });
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
  if (!target.geoEndpoint) return { code: 409, body: { error: 'endpoint_required', message: `First set how ${src.name} reaches ${target.name} (address and port of its leader, for example the site’s HAProxy or VIP).` } };
  if (Object.values(st.settings.geoJobs || {}).some((j: any) => j.status === 'running')) return { code: 409, body: { error: 'busy', message: 'A switchover between sites is already running.' } };
  const id = newId('geo');
  await store.mutate(d => { (d.settings.geoJobs ||= {})[id] = { id, type: 'switchover', from, to, fromName: src.name, toName: target.name, createdBy: actor, createdAt: nowIso(), status: 'running', steps: [] }; });
  runSwitchover(store, { id, from, to, toEndpoint: target.geoEndpoint, actor }).catch(() => undefined);
  return { code: 202, body: { job: store.peek().settings.geoJobs[id] } };
}

export function mountGeoRoutes(app: any, store: Store) {
  const actor = (req: Request) => (req as any).actor || 'admin';
  app.get('/api/geo', (_req: Request, res: Response) => {
    const st = store.peek();
    res.json({ rpoTargetSec: Number(st.settings.geoRpoSec) > 0 ? Number(st.settings.geoRpoSec) : GEO_RPO_DEFAULT_SEC,
      groups: geoGroups(st).map(g => ({ ...g, stanza: g.sites.map(x => st.clusters.find((c: any) => c.id === x.clusterId)?.geoStanza).find(Boolean) || null, readiness: geoReadiness(st, g),
        policy: policyOf(st, g.sysid), watch: watchOf(g.sysid), failover: (st.settings.geoFailovers || {})[g.sysid] || null, lastPrimary: (st.settings.geoLastPrimary || {})[g.sysid] || null })), jobs: Object.values(st.settings.geoJobs || {}).sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 10) });
  });
  app.get('/api/clusters/:id/geo', (req: Request, res: Response) => res.json({ geo: geoOf(store.peek(), req.params.id) }));
  /** RPO objective of the geo pairs (seconds of transactions it is acceptable to lose if the primary site is lost). */
  app.put('/api/geo/settings', async (req: Request, res: Response) => {
    const v = Number(req.body?.rpoSec);
    if (!Number.isInteger(v) || v < 1 || v > 86400) return res.status(400).json({ error: 'invalid_rpo', message: 'The RPO target must be between 1 second and 24 hours.' });
    await store.mutate(d => { d.settings.geoRpoSec = v; ops.audit(d, { actor: actor(req), action: 'geo.settings', status: 'OK', details: { rpoSec: v } } as any); });
    res.json({ ok: true, rpoSec: v });
  });

  /** DR policy of a pair (key = its system identifier): automatic failover between sites (off by default), how long the primary site must be lost, the most
   *  data an AUTOMATIC failover may lose, automatic rejoin of the old primary. Admin only. */
  app.put('/api/geo/policy/:key', async (req: Request, res: Response) => {
    if ((req as any).role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Only an administrator can change the disaster recovery policy.' });
    const b = req.body || {}; const key = String(req.params.key);
    if (!geoGroups(store.peek()).some(g => g.sysid === key)) return res.status(404).json({ error: 'pair_not_found' });
    const p = { ...GEO_POLICY_DEFAULT, ...(store.peek().settings.geoPolicy?.[key] || {}) };
    if (b.autoFailover !== undefined) p.autoFailover = !!b.autoFailover;
    if (b.autoRejoin !== undefined) p.autoRejoin = !!b.autoRejoin;
    if (b.confirmSec !== undefined) { const v = Number(b.confirmSec); if (!(Number.isInteger(v) && v >= 10 && v <= 3600)) return res.status(400).json({ error: 'invalid', message: 'Confirmation wait between 10 seconds and 1 hour.' }); p.confirmSec = v; }
    if (b.maxLossMB !== undefined) { const v = Number(b.maxLossMB); if (!(v >= 0 && v <= 1_000_000)) return res.status(400).json({ error: 'invalid', message: 'Maximum loss: a number of MB (0 = no loss accepted).' }); p.maxLossMB = v; }
    await store.mutate(d => { (d.settings.geoPolicy ||= {})[key] = p; ops.audit(d, { actor: actor(req), action: 'geo.policy', status: 'OK', details: { key, ...p } } as any); });
    res.json({ ok: true, policy: p });
  });
  /** "False alarm": no automatic failover for this pair for the next minutes (the operator is looking at it). */
  app.post('/api/geo/snooze/:key', (req: Request, res: Response) => { const m = Math.max(1, Math.min(240, Number(req.body?.minutes) || 30)); snooze(String(req.params.key), m); res.json({ ok: true, minutes: m }); });

  /** Primary / standby relationship set by an operator (when it cannot be detected, or to make intent explicit). primary: cluster id | null (back to
   *  automatic); none: true detaches the cluster from automatic pairing. Refuses self-links and cycles. */
  app.put('/api/clusters/:id/geo-link', async (req: Request, res: Response) => {
    const { primary, none } = req.body || {};
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    if (primary != null) {
      const p = st.clusters.find((x: any) => x.id === primary);
      if (!p || p.isSandbox || p.id === c.id) return res.status(400).json({ error: 'invalid_primary', message: 'Choose another connected cluster.' });
      let cur: any = p; const seen = new Set([c.id]);
      while (cur?.geoLink?.primary) { if (seen.has(cur.geoLink.primary)) return res.status(400).json({ error: 'cycle', message: `${p.name} is already a standby of ${c.name}: the relationship would be circular.` }); seen.add(cur.id); cur = st.clusters.find((x: any) => x.id === cur.geoLink.primary); }
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
    if (confirm !== 'PROMOTE' && confirm !== 'PROMUOVI') return res.status(400).json({ error: 'confirm_required', message: 'Type PROMOTE to confirm.' });
    const st = store.peek(); const me = geoOf(st, clusterId);
    if (!me || me.role !== 'standby') return res.status(409).json({ error: 'not_a_standby_site', message: 'This cluster is not a standby site.' });
    const alive = me.peers.find(p => p.role === 'primary' && p.online);
    if (alive && primaryLost !== true) return res.status(409).json({ error: 'primary_site_alive', message: `Primary site ${alive.name} is still running and accepts writes: promoting ${me.name} now would create two primaries with diverging data. Use the planned switchover, or confirm that ${alive.name} is lost.`, primary: alive.name });
    const cluster = st.clusters.find((c: any) => c.id === clusterId);
    // the site it replicated from: the visible primary, else the last primary the pair knew (the lost one)
    const grp = geoGroups(st).find(g => g.sites.some(s => s.clusterId === clusterId));
    const lostId = me.peers.find(p => p.role === 'primary')?.clusterId || (grp ? (st.settings.geoLastPrimary || {})[grp.sysid]?.clusterId : null) || me.peers[0]?.clusterId;
    if (!grp || !lostId) return res.status(409).json({ error: 'no_peer', message: 'Unknown which site it replicated from: declare the relationship in Geo-redundancy.' });
    const params = { from: lostId, to: clusterId, key: grp.sysid };
    if (requiresApproval(st, cluster, 'geo_promote', params)) {
      const r = await requestApproval(store, ops.audit, { cluster, type: 'geo_failover', params, key, actor: actor(req) } as any);
      return res.status(202).json({ approval: r, message: 'Risky operation in a protected environment: another administrator must approve it.' });
    }
    // same path as the automatic failover: catch-up from the archive, loss estimate, promotion, slot for the old primary, rejoin when it returns
    const r = await startFailover(store, { key: grp.sysid, from: lostId, to: clusterId, auto: false, actor: actor(req) });
    res.status(r.code).json(r.body);
  });

  /** Split-brain remedy: one of two writable sites becomes a standby site of the other (geo_demote with the other's address). Its writes since the fork are
   *  abandoned: Patroni rewinds or rebuilds its members from the chosen primary. Explicit confirmation, four-eyes on protected environments. */
  app.post('/api/geo/demote', async (req: Request, res: Response) => {
    const { clusterId, to, confirm } = req.body || {};
    const key = String(req.headers['idempotency-key'] || ''); if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    if (confirm !== 'DEMOTE' && confirm !== 'DECLASSA') return res.status(400).json({ error: 'confirm_required', message: 'Type DEMOTE to confirm.' });
    const st = store.peek(); const me = geoOf(st, clusterId); const target = st.clusters.find((c: any) => c.id === to);
    if (!me || !target || !me.peers.some(p => p.clusterId === to)) return res.status(409).json({ error: 'not_paired', message: 'The two clusters are not sites of the same database.' });
    if (me.role !== 'primary') return res.status(409).json({ error: 'not_primary', message: `${me.name} does not accept writes: it is already a standby site.` });
    const ep = target.geoEndpoint || geoOf(st, to)?.endpoint;
    if (!ep) return res.status(409).json({ error: 'endpoint_required', message: `First set how to reach ${target.name} (the address of its leader).` });
    const params = { host: ep.host, port: ep.port, primary_slot_name: geoSlotFor(me.name), confirm: 'DEMOTE' };
    const cluster = st.clusters.find((c: any) => c.id === clusterId);
    if (requiresApproval(st, cluster, 'geo_demote', params)) {
      const r = await requestApproval(store, ops.audit, { cluster, type: 'geo_demote', params, key, actor: actor(req) } as any);
      return res.status(202).json({ approval: r, message: 'Risky operation in a protected environment: another administrator must approve it.' });
    }
    try { const op = await submitTo(store, clusterId, 'geo_demote', params, key, actor(req)); res.status(202).json({ operation: op }); }
    catch (e: any) { res.status(e.status || 500).json(e.body || { error: 'failed', message: e.message }); }
  });

  /** Planned switchover between sites (both alive): demote the primary site, wait, promote the standby site. Four-eyes approval on protected environments. */
  app.post('/api/geo/switchover', async (req: Request, res: Response) => {
    const { from, to, confirm } = req.body || {};
    if (confirm !== 'SWITCHOVER') return res.status(400).json({ error: 'confirm_required', message: 'Type SWITCHOVER to confirm.' });
    const st = store.peek(); const target = st.clusters.find((c: any) => c.id === to);
    if (target && requiresApproval(st, target, 'geo_switchover', {})) {
      const key = String(req.headers['idempotency-key'] || `geo-sw-${from}-${to}-${Date.now()}`);
      const r = await requestApproval(store, ops.audit, { cluster: target, type: 'geo_switchover', params: { from, to }, key, actor: actor(req) } as any);
      return res.status(202).json({ approval: r, message: 'Switchover between sites in a protected environment: another administrator must approve it.' });
    }
    const r = await startSwitchover(store, from, to, actor(req));
    res.status(r.code).json(r.body);
  });
}
