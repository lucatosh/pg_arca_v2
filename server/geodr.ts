/**
 * Disaster recovery between the sites of a geo-redundant pair: detecting the loss of the primary site, promoting the best standby site with every WAL that
 * can still be had, and bringing the old primary back as a standby of the new one when it returns.
 *
 *  - Loss of the primary site needs TWO independent witnesses for `confirmSec` seconds: the console hears no agent of the primary site, AND the standby site
 *    no longer receives WAL from it (its own WAL receiver, reported by its agent). A cut WAN (standby blind, primary alive for the console) or a console cut
 *    off from the primary site (standby still streaming) never promotes anything.
 *  - Failover = 1) the standby site catches up from the shared WAL archive too (restore_command in its standby_cluster: segments archived by the primary
 *    site that streaming did not deliver), and PostgreSQL replays everything received before promoting; 2) the data loss is estimated against the last
 *    position the primary site reported; automatic failover stops and asks a person when it exceeds `maxLossMB`; 3) the primary site is checked again
 *    (back during the catch-up -> nothing is promoted); 4) promotion through the standby site's DCS, with a permanent slot kept for the old primary.
 *  - The old primary site, back and still writable, is a second primary (split-brain): with `autoRejoin` it becomes at once a standby site of the new
 *    primary (standby_cluster in ITS DCS, Patroni rewinds it), and what it had written after the promotion point is reported (it is not in the new primary).
 * Automatic failover is OFF by default: a site-level failover is a business decision for many companies. Everything is recorded in settings.geoJobs.
 */
import { Store, NodeRecord, newId, nowIso } from './store';
import * as ops from './ops';
import { lsnToBig } from './view';
import { geoGroups, geoSlotFor, submitTo, waitOp, GeoGroup, Site } from './geo';

const MB = 1024 * 1024;
/** Waits of the failover (tests shorten them). */
export const GEO_DR_TIMING = { stableMs: 25_000, pollMs: 2000, maxCatchupMs: 180_000, rejoinPollMs: 3000 };
export interface GeoPolicy { autoFailover: boolean; confirmSec: number; maxLossMB: number; autoRejoin: boolean }
export const GEO_POLICY_DEFAULT: GeoPolicy = { autoFailover: false, confirmSec: 30, maxLossMB: 16, autoRejoin: true };
export const policyOf = (st: any, key: string): GeoPolicy => ({ ...GEO_POLICY_DEFAULT, ...((st.settings.geoPolicy || {})[key] || {}) });
const ONLINE_MS = 45_000;
const online = (n: NodeRecord, now = Date.now()) => !!n.lastSeen && now - Date.parse(n.lastSeen) < ONLINE_MS;

/** What the monitor sees right now, per pair (memory: rebuilt within seconds after a console restart). */
export interface Watch { key: string; primary: string | null; primaryName?: string; downSince: number | null; witnesses: { console: boolean; standby: boolean; standbyName?: string };
  lastSeenSec: number | null; candidate?: string | null; candidateName?: string; actInSec: number | null; snoozedUntil?: number | null; note?: string }
const watches = new Map<string, Watch>();
const snoozed = new Map<string, number>();
export const watchOf = (key: string) => watches.get(key) || null;
export const snooze = (key: string, minutes: number) => { snoozed.set(key, Date.now() + minutes * 60_000); const w = watches.get(key); if (w) w.snoozedUntil = snoozed.get(key)!; };

const nodesOf = (st: any, cid: string) => (Object.values(st.nodes) as NodeRecord[]).filter(n => n.clusterId === cid && n.kind !== 'worker');
const groupKey = (g: GeoGroup) => g.sysid;
const step = (store: Store, id: string, text: string, status = 'running', extra: any = {}) => store.mutate(d => {
  const j = (d.settings.geoJobs ||= {})[id]; if (!j) return;
  j.steps.push({ at: nowIso(), text }); j.status = status; Object.assign(j, extra);
  if (j.steps.length > 60) j.steps.splice(0, j.steps.length - 60);
});
const running = (st: any) => Object.values(st.settings.geoJobs || {}).some((j: any) => j.status === 'running');
/** The last site known as primary of each pair, with its last reported position: when it disappears the pair still knows whom it lost and how far it was. */
function remember(store: Store, key: string, site: Site) {
  const st = store.peek(); const cur = (st.settings.geoLastPrimary || {})[key];
  const n = nodesOf(st, site.clusterId).filter(x => online(x)).find(x => x.snapshot?.postgres?.is_in_recovery === false);
  const lsn = n?.snapshot?.postgres?.current_lsn || site.lsn;
  if (cur && cur.clusterId === site.clusterId && cur.lsn === lsn && Date.now() - Date.parse(cur.at) < 60_000) return;
  return store.mutate(d => { (d.settings.geoLastPrimary ||= {})[key] = { clusterId: site.clusterId, name: site.name, lsn, timeline: site.timeline, at: nowIso() }; });
}

/** One monitor pass (every few seconds). */
export async function geoMonitorTick(store: Store, now = Date.now()) {
  const st = store.peek();
  for (const g of geoGroups(st, now)) {
    const key = groupKey(g); const pol = policyOf(st, key);
    // after a failover the primary of the pair is the promoted site, also while the old one is back and still writable (until it is rejoined)
    const fo = (st.settings.geoFailovers || {})[key];
    const want = fo && !fo.rejoinedAt ? fo.to : g.primary;
    const prim = g.sites.find(s => s.clusterId === want && s.role === 'primary' && s.online);
    if (prim) await remember(store, key, prim);
    await rejoinIfBack(store, g, pol, now);
    const last = (store.peek().settings.geoLastPrimary || {})[key];
    if (!last || prim) { watches.delete(key); continue; }
    // the primary site of this pair is not visible as a writable site: is it LOST, or is only one view of it gone?
    const ps = nodesOf(st, last.clusterId);
    const consoleBlind = ps.length > 0 && !ps.some(n => online(n, now));
    const seen = ps.map(n => Date.parse(n.lastSeen || '')).filter(Number.isFinite);
    const lastSeenSec = seen.length ? Math.round((now - Math.max(...seen)) / 1000) : null;
    const cands = g.sites.filter(s => s.clusterId !== last.clusterId && s.role === 'standby' && s.online);
    const blind = cands.filter(s => !s.receiver || s.receiver.status !== 'streaming' || (s.receiver.silentSec != null && s.receiver.silentSec > 30));
    const best = [...blind].sort((a, b) => Number((lsnToBig(b.lsn) ?? 0n) - (lsnToBig(a.lsn) ?? 0n)))[0] || null;
    const both = consoleBlind && !!best;
    const w: Watch = watches.get(key) || { key, primary: last.clusterId, primaryName: last.name, downSince: null, witnesses: { console: false, standby: false }, lastSeenSec: null, actInSec: null };
    w.primary = last.clusterId; w.primaryName = last.name; w.lastSeenSec = lastSeenSec;
    w.witnesses = { console: consoleBlind, standby: !!best, standbyName: best?.name };
    w.candidate = best?.clusterId || null; w.candidateName = best?.name;
    w.downSince = both ? (w.downSince ?? now) : null;
    w.snoozedUntil = (snoozed.get(key) || 0) > now ? snoozed.get(key)! : null;
    w.actInSec = w.downSince && pol.autoFailover ? Math.max(0, Math.ceil((w.downSince + pol.confirmSec * 1000 - now) / 1000)) : null;
    w.note = !cands.length ? 'no reachable standby site: nothing to promote' : !consoleBlind ? `${last.name} still answers the console: not a disaster (network between the sites?)` : !best ? `${cands.map(s => s.name).join(', ')} still receives WAL from ${last.name}` : undefined;
    watches.set(key, w);
    if (!both || !pol.autoFailover || w.snoozedUntil || running(store.peek())) continue;
    if (now - w.downSince! < pol.confirmSec * 1000) continue;
    const done = (store.peek().settings.geoFailovers || {})[key];
    if (done && done.from === last.clusterId && !done.rejoinedAt && Date.now() - Date.parse(done.at) < 3600_000) continue;   // already failed over away from it
    await startFailover(store, { key, from: last.clusterId, to: best!.clusterId, auto: true, actor: 'pg_arca (automatic failover)' });
  }
}

/** Starts a DR failover (automatic or asked by an operator). */
export async function startFailover(store: Store, a: { key: string; from: string; to: string; auto: boolean; actor: string }): Promise<{ code: number; body: any }> {
  const st = store.peek();
  if (running(st)) return { code: 409, body: { error: 'busy', message: 'A site role change is already running.' } };
  const from = st.clusters.find((c: any) => c.id === a.from), to = st.clusters.find((c: any) => c.id === a.to);
  if (!from || !to) return { code: 404, body: { error: 'cluster_not_found' } };
  const id = newId('geo');
  await store.mutate(d => { (d.settings.geoJobs ||= {})[id] = { id, type: a.auto ? 'failover_auto' : 'failover', from: a.from, to: a.to, fromName: from.name, toName: to.name, createdBy: a.actor, createdAt: nowIso(), status: 'running', steps: [] };
    ops.audit(d, { clusterId: a.to, actor: a.actor, action: a.auto ? 'geo.failover.auto' : 'geo.failover', status: 'STARTED', details: { from: from.name, to: to.name } }); });
  runFailover(store, id, a).catch(() => undefined);
  return { code: 202, body: { job: store.peek().settings.geoJobs[id] } };
}

const siteNow = (store: Store, cid: string) => geoGroups(store.peek()).flatMap(x => x.sites).find(s => s.clusterId === cid) || null;

async function runFailover(store: Store, id: string, a: { key: string; from: string; to: string; auto: boolean; actor: string }) {
  const t0 = Date.now();
  try {
    const st = store.peek(); const pol = policyOf(st, a.key);
    const last = (st.settings.geoLastPrimary || {})[a.key];
    const fromName = st.clusters.find((c: any) => c.id === a.from)?.name || a.from, toName = st.clusters.find((c: any) => c.id === a.to)?.name || a.to;
    const lastLsn = last?.clusterId === a.from ? lsnToBig(last.lsn) : null;
    // the primary site coming back during the procedure cancels it - unless an operator promoted while it was still visible (stated as lost)
    const wasUp = nodesOf(st, a.from).some(n => online(n));
    const isBack = () => !wasUp && nodesOf(store.peek(), a.from).some(n => online(n)) && siteNow(store, a.from)?.role === 'primary';
    await step(store, id, `1/5 ${fromName} is not responding${a.auto ? ' to the console or to ' + toName : ''}: ${toName} is brought to the most advanced point possible${last?.lsn ? ` (last known position of ${fromName}: ${last.lsn}, ${last.at.slice(11, 19)})` : ''}`);
    // WAL that the primary site ARCHIVED but streaming did not deliver: the standby site reads it from the shared archive
    const s0 = siteNow(store, a.to);
    if (s0 && !s0.upstream?.archive) {
      await step(store, id, `2/5 ${toName} also reads from the shared WAL archive (restore_command in its standby_cluster) the segments streaming did not deliver`);
      try { const o = await submitTo(store, a.to, 'geo_archive_fallback', { enable: true }, `geo:${id}:archive`, a.actor); const r = await waitOp(store, o.id, 120_000);
        if (r.status !== 'succeeded') await step(store, id, `   archive fallback not enabled (${r.error || r.status}): continuing with what streaming delivered`); }
      catch (e: any) { await step(store, id, `   archive fallback not enabled (${e.message}): continuing with what streaming delivered`); }
    } else await step(store, id, `2/5 ${toName} already reads from the shared WAL archive what streaming did not deliver`);
    // wait until the replay stops advancing (everything received / archived has been applied), at most 3 minutes
    let prev: bigint | null = null, stableSince = Date.now(); const tw = Date.now();
    while (Date.now() - tw < GEO_DR_TIMING.maxCatchupMs) {
      const s = siteNow(store, a.to); const l = lsnToBig(s?.lsn || null);
      if (l !== null && prev !== null && l === prev) { if (Date.now() - stableSince > GEO_DR_TIMING.stableMs) break; } else { stableSince = Date.now(); prev = l; }
      // the primary site came back during the catch-up: no failover (it is not lost)
      if (isBack()) throw new Error(`${fromName} became reachable again while waiting: failover cancelled, nothing changed`);
      await new Promise(r => setTimeout(r, GEO_DR_TIMING.pollMs));
    }
    const s1 = siteNow(store, a.to); const got = lsnToBig(s1?.lsn || null);
    const loss = lastLsn !== null && got !== null ? (lastLsn > got ? Number(lastLsn - got) : 0) : null;
    await step(store, id, `3/5 ${toName} is at ${s1?.lsn || '?'}: ${loss === null ? 'loss cannot be estimated (last position of the primary unknown)' : loss === 0 ? 'no data missing compared with the last known position of the primary' : `about ${(loss / MB).toFixed(1)} MB of WAL missing compared with the last known position of the primary (the transactions in it are lost)`}`, 'running', { lossBytes: loss });
    if (a.auto && loss !== null && loss > pol.maxLossMB * MB)
      throw Object.assign(new Error(`estimated loss of ${(loss / MB).toFixed(1)} MB exceeds the automatic failover limit (${pol.maxLossMB} MB): a decision is needed — promote ${toName} by hand if ${fromName} is really lost`), { held: true });
    if (isBack()) throw new Error(`${fromName} is reachable again: failover cancelled, nothing changed`);
    await step(store, id, `4/5 promoting ${toName} through its DCS (permanent slot ${geoSlotFor(fromName)} for when ${fromName} comes back)`);
    const p = await submitTo(store, a.to, 'geo_promote', { confirm: 'PROMOTE', slot_for_peer: geoSlotFor(fromName) }, `geo:${id}:promote`, a.actor);
    const pr = await waitOp(store, p.id, 240_000);
    if (pr.status !== 'succeeded') throw new Error(`promotion of ${toName} failed: ${pr.error || pr.status}`);
    // the new primary keeps seeing the shared archive (restore_command in its DCS): a later promotion of either site never re-uses a timeline number
    submitTo(store, a.to, 'geo_archive_fallback', { enable: true }, `geo:${id}:archive-primary`, a.actor).catch(() => undefined);
    const fork = (pr.result as any)?.timeline ? { timeline: (pr.result as any).timeline } : {};
    await store.mutate(d => { (d.settings.geoFailovers ||= {})[a.key] = { from: a.from, to: a.to, fromName, toName, at: nowIso(), forkLsn: s1?.lsn || null, lossBytes: loss, auto: a.auto, jobId: id, ...fork };
      ops.audit(d, { clusterId: a.to, actor: a.actor, action: a.auto ? 'geo.failover.auto' : 'geo.failover', status: 'OK', details: { from: fromName, to: toName, lossBytes: loss } }); });
    await step(store, id, `5/5 ${toName} is the primary site (in ${Math.round((Date.now() - t0) / 1000)} s). ${policyOf(store.peek(), a.key).autoRejoin ? `When ${fromName} comes back, pg_arca turns it into a standby site of ${toName} by itself.` : `When ${fromName} comes back it must NOT accept writes: rejoin it as a standby site from the Geo-redundancy page.`}`, 'succeeded', { finishedAt: nowIso() });
  } catch (e: any) {
    await step(store, id, `${e.held ? 'waiting for a decision' : 'stopped'}: ${e.message}`, e.held ? 'held' : 'failed', { finishedAt: nowIso(), error: e.message });
    await store.mutate(d => ops.audit(d, { clusterId: a.to, actor: a.actor, action: 'geo.failover', status: 'FAILED', details: { error: e.message } }));
  }
}

/** The old primary site is back after a failover (writable: a second primary) -> it becomes a standby site of the new primary, through its own DCS. */
async function rejoinIfBack(store: Store, g: GeoGroup, pol: GeoPolicy, now = Date.now()) {
  const st = store.peek(); const f = (st.settings.geoFailovers || {})[groupKey(g)];
  if (!f || f.rejoinedAt || f.rejoinJob || (f.rejoinFailedAt && Date.now() - Date.parse(f.rejoinFailedAt) < 300_000)) return;   // a failed attempt is retried after 5 minutes
  const old = g.sites.find(s => s.clusterId === f.from); const neu = g.sites.find(s => s.clusterId === f.to);
  // FENCING: the moment any node of the old site answers again with its Patroni API reachable, it is demoted - also while its PostgreSQL is
  // still starting (site role unknown). Waiting for it to be "primary and writable" first is exactly the split-brain window seen on the lab
  // (hy-mi back at 13:12:10, promoted itself at 13:12:42, demoted by the console only at 13:13:47).
  const back = nodesOf(st, f.from).some(n => online(n, now) && n.snapshot?.patroni?.accessible);
  if (!old || !neu || !(old.online || back)) return;
  if (old.role === 'standby') {                  // already following someone (rejoined by hand, or by an earlier pass): done
    if (old.receiver?.status === 'streaming') await store.mutate(d => { const x = (d.settings.geoFailovers || {})[groupKey(g)]; if (x) x.rejoinedAt = nowIso(); });
    return;
  }
  if (!pol.autoRejoin || running(st)) return;
  const ep = st.clusters.find((c: any) => c.id === f.to)?.geoEndpoint || neu.endpoint;
  const id = newId('geo');
  await store.mutate(d => { const x = (d.settings.geoFailovers || {})[groupKey(g)]; if (x) x.rejoinJob = id;
    (d.settings.geoJobs ||= {})[id] = { id, type: 'rejoin', from: f.from, to: f.to, fromName: old.name, toName: neu.name, createdBy: 'pg_arca (automatic rejoin)', createdAt: nowIso(), status: 'running', steps: [] }; });
  runRejoin(store, g, id, f, old, neu, ep).catch(() => undefined);           // in the background: the monitor keeps watching the other pairs meanwhile
}

/** Timeline history entries [(parent timeline, switch point)] of a history file's text. */
export function parseHistory(text: string | null | undefined): [number, string][] {
  return String(text || '').split('\n').map(l => /^\s*(\d+)\s+([0-9A-Fa-f]+\/[0-9A-Fa-f]+)/.exec(l)).filter(Boolean).map(m => [Number(m![1]), m![2].toUpperCase()] as [number, string]);
}
/** Same timeline NUMBER, different history: the old primary promoted itself while it could not see the new primary's history file. Patroni compares
 *  only the numbers (same number = no rewind), so the old site would follow the new primary with a hole in its data. Unknown history = not concluded. */
export function sameTimelineDiverged(a: any, b: any): boolean {
  if (!a || !b || !(Number(a.timeline) > 1) || Number(a.timeline) !== Number(b.timeline) || a.history == null || b.history == null) return false;
  return JSON.stringify(parseHistory(a.history)) !== JSON.stringify(parseHistory(b.history));
}
async function timelines(store: Store, id: string, tag: string, oldId: string, nid: string) {
  const one = async (cid: string, k: string) => { try { const o = await submitTo(store, cid, 'pg_timeline', {}, `geo:${id}:tl-${tag}-${k}`, 'pg_arca'); const r = await waitOp(store, o.id, 60_000); return r.status === 'succeeded' ? r.result : null; } catch { return null; } };
  return { o: await one(oldId, 'old'), n: await one(nid, 'new') };
}

async function runRejoin(store: Store, g: GeoGroup, id: string, f: any, old: Site, neu: Site, ep: { host: string; port: number } | null | undefined) {
  try {
    const div = old.lsn && f.forkLsn ? (() => { const a = lsnToBig(old.lsn), b = lsnToBig(f.forkLsn); return a !== null && b !== null && a > b ? Number(a - b) : 0; })() : null;
    await step(store, id, old.role === 'primary'
      ? `1/3 ${old.name} is back and accepts writes, but the primary is now ${neu.name}: it becomes its standby site right away${div ? ` (it had written about ${(div / MB).toFixed(1)} MB of WAL past the promotion point: that data is not in ${neu.name} and is discarded by pg_rewind; it stays in the WAL archive for analysis)` : ''}`
      : `1/3 ${old.name} is back (its PostgreSQL is not up yet): fenced as a standby site of ${neu.name} now, before Patroni there can promote it`, 'running', { divergedBytes: div });
    if (!ep) throw new Error(`address of ${neu.name} for the other sites not set: set it in Geo-redundancy, then “Demote ${old.name}”`);
    // the old site may have promoted itself to the SAME timeline number when it came back: then Patroni would not rewind it (see sameTimelineDiverged)
    // (only when it IS primary: a site whose PostgreSQL is not up cannot have promoted itself yet, and a fence must not wait a minute for pg_controldata)
    const t1 = old.role === 'primary' ? await timelines(store, id, 'pre', f.from, f.to) : { o: null, n: null };
    const force = sameTimelineDiverged(t1.o, t1.n);
    if (force) await step(store, id, `1b ${old.name} promoted itself when it came back, on the SAME timeline ${t1.o.timeline} as ${neu.name} but with a different history: Patroni (and pg_rewind) compare only the number and it would follow ${neu.name} with a hole in the data. It is rebuilt from ${neu.name}: Patroni in maintenance mode, its data directory is set aside (.pgarca-diverged-…), then it is cloned again`);
    // a fenced site is still starting PostgreSQL: give Patroni more time to bring up the standby leader (the DCS write itself is immediate)
    const o = await submitTo(store, f.from, 'geo_demote', { host: ep.host, port: ep.port, primary_slot_name: geoSlotFor(old.name), confirm: 'DEMOTE', ...(force ? { force_rewind: true } : {}), ...(old.role !== 'primary' ? { timeout: 600 } : {}) }, `geo:${id}:demote`, 'pg_arca (automatic rejoin)');
    const r = await waitOp(store, o.id, 300_000);
    if (r.status !== 'succeeded') throw new Error(`demotion of ${old.name} failed: ${r.error || r.status}`);
    await step(store, id, `2/3 ${old.name} is a standby site of ${neu.name} (${ep.host}:${ep.port}): waiting for it to receive WAL`);
    const t0 = Date.now(); let ok = false;
    while (Date.now() - t0 < 300_000) { const s = siteNow(store, f.from); if (s?.role === 'standby' && s.receiver?.status === 'streaming') { ok = true; break; } await new Promise(r2 => setTimeout(r2, GEO_DR_TIMING.rejoinPollMs)); }
    if (!ok) throw new Error(`${old.name} is not receiving WAL from ${neu.name} after 5 minutes: pg_rewind probably failed (check use_pg_rewind and the local replication pg_hba rule) and the members must be reinitialized`);
    // streaming is not enough: it must follow the new primary's HISTORY (same timeline, same switch points), or it is replaying from the wrong place
    const t2 = await timelines(store, id, 'post', f.from, f.to);
    if (sameTimelineDiverged(t2.o, t2.n)) throw new Error(`${old.name} receives WAL from ${neu.name} but its history of timeline ${t2.o.timeline} differs: the data ${neu.name} wrote after the failover does not reach it. It must be rebuilt from ${neu.name} (Demote with rebuild, or patronictl reinit of the members)`);
    await store.mutate(d => { const x = (d.settings.geoFailovers || {})[groupKey(g)]; if (x) x.rejoinedAt = nowIso(); ops.audit(d, { clusterId: f.from, actor: 'pg_arca', action: 'geo.rejoin', status: 'OK', details: { to: neu.name } }); });
    await step(store, id, `3/3 ${old.name} receives WAL from ${neu.name}: the pair is protected again (a planned switchover can bring the primary back to ${old.name})`, 'succeeded', { finishedAt: nowIso() });
  } catch (e: any) {
    await step(store, id, `stopped: ${e.message}`, 'failed', { finishedAt: nowIso(), error: e.message });
    await store.mutate(d => { const x = (d.settings.geoFailovers || {})[groupKey(g)]; if (x) { delete x.rejoinJob; x.rejoinFailedAt = nowIso(); x.rejoinError = e.message; } });
  }
}

export function startGeoMonitor(store: Store, everyMs = 5000) {
  let busy = false;
  const t = setInterval(() => { if (busy) return; busy = true; geoMonitorTick(store).catch(e => console.error('[geo-monitor]', e.message)).finally(() => { busy = false; }); }, everyMs);
  t.unref?.();
  return t;
}
