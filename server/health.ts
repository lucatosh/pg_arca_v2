/**
 * Fleet health: a PURE evaluation of the persisted state (agent telemetry + operations journal + resolved policy) into a list of issues.
 * Every issue carries a plain-language cause and a suggested next step, so the briefing says what is wrong AND what to do.
 * No I/O here: the same function feeds the "Oggi" page, the notification dispatcher and the tests.
 */
import { resolvePolicy } from './policies';
import { sameWork, workKey } from './optypes';
import { lsnToBig } from './view';
import { classify } from './pgcompat';
import { geoIssues } from './geo';
import { resolveScoped } from './scoped';

export type Severity = 'critical' | 'warning' | 'info';
export interface Issue {
  key: string;                       // stable: <clusterId>:<code>[:<detail>] -> used to de-duplicate notifications
  clusterId: string; clusterName: string; environment: string; nodeId?: string; nodeName?: string;
  severity: Severity; code: string; title: string; cause: string; action?: { label: string; page?: string };
}
export const SEV_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

const ONLINE_MS = 45_000;
const GB = 1024 ** 3;
// never '0 hours' or '1 hours': minutes under two hours, then hours, then days
const hrs = (h: number) => (h >= 48 ? `${Math.round(h / 24)} days` : h >= 2 ? `${Math.round(h)} hours` : `${Math.max(1, Math.round(h * 60))} ${Math.max(1, Math.round(h * 60)) === 1 ? 'minute' : 'minutes'}`);
const bytesH = (b: number) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);
const ts = (s?: string) => (s ? Date.parse(s) : NaN);
/** Where PostgreSQL writes compared with the last archived segment: completed segments still waiting for the archiver (backlog) and the
 *  offset inside the segment being written. null when it cannot be told (no LSN, unknown name). */
export function walPosition(pg: any, lastArchivedWal?: string | null): { backlog: number; offset: number; sameTimeline: boolean } | null {
  const m = /^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})$/i.exec(String(lastArchivedWal || '')); const cur = lsnToBig(pg?.current_lsn);
  if (!m || cur === null) return null;
  const segBytes = Number(pg?.settings?.wal_segment_size) > 0 ? Number(pg.settings.wal_segment_size) : 16 * 1048576;
  const segsPerLog = BigInt(Math.floor(0x100000000 / segBytes)); const archived = BigInt('0x' + m[2]) * segsPerLog + BigInt('0x' + m[3]);
  const curSeg = cur / BigInt(segBytes);
  return { backlog: Number(curSeg - archived - 1n), offset: Number(cur % BigInt(segBytes)), sameTimeline: Number(pg?.timeline) > 0 && parseInt(m[1], 16) === Number(pg.timeline) };
}
const durH = (s: number) => s >= 7200 ? `${(s / 3600).toFixed(1).replace(/\.0$/, '')} h` : s >= 120 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`;

export function evaluate(st: any, now = Date.now()): Issue[] {
  const out: Issue[] = [];
  for (const c of st.clusters as any[]) {
    if (c.isSandbox || c.source === 'direct') continue;
    const nodes = Object.values(st.nodes).filter((n: any) => n.clusterId === c.id) as any[];
    if (!nodes.length) continue;
    const add = (i: Omit<Issue, 'clusterId' | 'clusterName' | 'environment' | 'key'> & { detail?: string }) => {
      const { detail, ...rest } = i;
      out.push({ ...rest, key: `${c.id}:${i.code}${detail ? ':' + detail : ''}`, clusterId: c.id, clusterName: c.name, environment: c.environment });
    };
    const on = (n: any) => !!n.lastSeen && now - Date.parse(n.lastSeen) < ONLINE_MS;
    const online = nodes.filter(on);
    const primary = online.find(n => n.snapshot?.postgres?.is_in_recovery === false);
    const isProd = c.environment === 'prod';

    // geo DR site (Patroni standby cluster): no primary by design; its own findings (replication between sites) come from geo.ts
    const standbySite = !primary && online.some(n => n.snapshot?.patroni?.local_node?.role === 'standby_leader' || n.snapshot?.patroni?.standby_cluster);
    // every agent silent: say for how long. Days of silence is a server switched off or decommissioned more often than an outage still
    // going on (the lab kept five release-test clusters "critical: no reachable primary" for days): still reported, as a warning that
    // names both ways out (bring the agent back, or detach the cluster) instead of an urgent problem that never changes
    const lastNews = Math.max(0, ...nodes.map(n => ts(n.lastSeen)).filter(Number.isFinite));
    const silentFor = !online.length && lastNews ? now - lastNews : 0;
    // a node just enrolled has not reported yet: that is the normal first minute, not an outage (the e2e "connect a server" flow showed it urgent)
    const enrolled = Math.max(0, ...nodes.map(n => ts(n.enrolledAt)).filter(Number.isFinite));
    if (!primary && !standbySite && !lastNews && nodes.length && enrolled && now - enrolled < 15 * 60_000) add({ severity: 'info', code: 'no_primary', title: 'Waiting for the agent’s first report',
      cause: 'The server was added a moment ago: its status, backups and findings appear after the agent’s first report (usually within a minute).', action: { label: 'Open the cluster', page: 'cluster' } });
    else if (!primary && !standbySite) add(silentFor > 3 * 86400_000 && !isProd
      ? { severity: 'warning', code: 'no_primary', title: `No news from this cluster for ${hrs(silentFor / 3600_000)}`, cause: `No agent has reported since ${new Date(lastNews).toISOString().slice(0, 16).replace('T', ' ')} UTC. If the servers were switched off or decommissioned, detach the cluster (its backups stay in the repository); otherwise start pg-arca-agent on its nodes.`, action: { label: 'Open the cluster', page: 'cluster' } }
      : { severity: 'critical', code: 'no_primary', title: 'No reachable primary', cause: online.length ? 'The agents respond but no node reports the primary role.' : lastNews ? `No agent of the cluster has responded since ${new Date(lastNews).toISOString().slice(0, 16).replace('T', ' ')} UTC (${hrs(silentFor / 3600_000)}).` : 'The agent was installed but has never reported: check on the server that the pg-arca-agent service runs and can reach the console address (journalctl -u pg-arca-agent).', action: { label: 'Open the cluster', page: 'cluster' } });
    for (const n of nodes.filter(x => !on(x))) {
      if (!primary && online.length === 0 && !standbySite) break;                 // every node silent: one finding (no_primary) says it, not one per node
      add({ severity: 'warning', code: 'node_offline', detail: n.id, nodeId: n.id, nodeName: n.name, title: `Node ${n.name} is not responding`, cause: n.lastSeen ? `Last seen ${new Date(n.lastSeen).toISOString()}. Agent stopped, server down or network interrupted.` : 'This node has never sent data.' });
    }
    // two agent processes with the same identity (a manual run next to the service, a cloned VM): each would run the node's operations
    for (const n of nodes) if (n.duplicateAgentAt && now - Date.parse(n.duplicateAgentAt) < 15 * 60_000)
      add({ severity: 'critical', code: 'agent_duplicate', detail: n.id, nodeId: n.id, nodeName: n.name, title: `Two agents use the identity of ${n.name}`,
        cause: 'Heartbeats come from two agent processes with the same credentials: a second copy started by hand next to the service, or a cloned virtual machine. Both can receive this node\'s operations. Stop the extra process; on a cloned machine remove its credentials (/etc/pg-arca or the state directory) and enroll it as a new node.',
        action: { label: 'Open the nodes', page: 'nodes' } });
    // agents that talk to the console in clear or without checking its certificate: their token (which commands the node) and everything they send are readable on the network
    // one finding per cluster and kind (a lab with 14 agents in clear filled Today with 14 identical lines), naming the nodes
    for (const plain of [true, false]) {
      const ns = online.filter(x => x.tlsInsecure && /^http:\/\//.test(String(x.consoleUrl || '')) === plain);
      if (!ns.length) continue;
      const names = ns.map(n => n.name).join(', '); const one = ns.length === 1;
      add({ severity: isProd ? 'warning' : 'info', code: 'agent_insecure_transport', detail: plain ? 'plain' : 'noverify', nodeId: one ? ns[0].id : undefined, nodeName: one ? ns[0].name : undefined,
        title: plain ? (one ? `Agent of ${names} talks to the console without TLS` : `${ns.length} agents talk to the console without TLS (${names})`) : (one ? `Agent of ${names} does not verify the console certificate` : `${ns.length} agents do not verify the console certificate (${names})`),
        cause: plain ? `${one ? 'It reaches' : 'They reach'} the console at ${ns[0].consoleUrl}: the agent token (which can run operations on the node) and what it reports travel in clear. Give the console a certificate (PG_ARCA_TLS_CERT / PG_ARCA_TLS_KEY, or a reverse proxy) and point the agents at https:// (reinstall with the install command shown for the node).`
          : 'tls_insecure_skip_verify is on in their agent.conf: anyone on the path can impersonate the console and command the node. Install the console certificate chain on the node (tls_ca_file) and remove the flag.',
        action: { label: 'Open the nodes', page: 'nodes' } });
    }
    // Patroni members with no agent: if the nodes WITH an agent fail, nothing can run backups/restores/HBA changes there.
    const known = new Set(nodes.map((n: any) => n.name));
    const orphan = new Map<string, any>();
    for (const n of online) for (const m of (n.snapshot?.patroni?.members || [])) if (m?.name && !known.has(m.name) && !orphan.has(m.name)) orphan.set(m.name, m);
    for (const [name, m] of orphan) add({ severity: 'warning', code: 'node_without_agent', detail: name, nodeName: name, title: `Node ${name} has no agent`, cause: `Patroni sees it (${m.role || 'member'}, ${m.state || 'unknown state'}) but there is no agent: if the nodes with the agent stop, backups, restores and changes are not possible. Install the agent on every node of the cluster.`, action: { label: 'Connect the node', page: 'cluster' } });
    const pg = primary?.snapshot?.postgres || {};
    const pol = resolvePolicy(st, c).policy;

    // ---- tablespace created after the latest full backup: restores of this cluster are refused until a new full exists (the replay would hit the live path)
    {
      const bkx = primary?.snapshot?.backup;
      const fts: string[] | null = Array.isArray(bkx?.full_tablespace_oids) ? bkx.full_tablespace_oids.map(String) : null;
      const fresh = fts ? ((pg.tablespaces || []) as any[]).filter(t => !fts.includes(String(t.oid))) : [];
      if (fresh.length) add({ severity: 'warning', code: 'tablespace_after_full', detail: fresh.map(t => t.oid).join('-'), title: `New tablespace after the last full backup (${fresh.map(t => t.location).slice(0, 2).join(', ')})`,
        cause: 'A restore replays the tablespace creation on its real path: on this server that would be the live tablespace, so restores are blocked until there is a new full backup. The scheduler starts one; you can also take it right away.', action: { label: 'Take a full backup', page: 'backup' } });
    }
    // ---- a database still marked "restore in progress" while no restore is running: the restore was interrupted (agent restart, crash) and the copy is INCOMPLETE
    const busy = new Set((st.operations || []).filter((o: any) => o.clusterId === c.id && ['queued', 'leased', 'running'].includes(o.status) && o.type === 'restore_database').map((o: any) => o.params?.new_name));
    for (const d of (pg.databases || []) as any[]) {
      if (d?.restoring && !busy.has(d.name)) add({ severity: 'warning', code: 'restore_incomplete', detail: d.name, title: `Database ${d.name}: restore interrupted`,
        cause: 'The restore that was filling it did not complete: the content is incomplete. Drop it and run the restore again.', action: { label: 'Go to restore', page: 'restore' } });
    }

    // ---- backups
    const bk = (nodes.filter(n => n.snapshot?.backup?.configured).sort((a, b) => (b.snapshot.backup.sets || 0) - (a.snapshot.backup.sets || 0))[0] || primary)?.snapshot?.backup;
    const sets: any[] = (bk?.recent_sets || []).filter((s: any) => s.status === 'COMPLETE');
    const last = sets.length ? sets[sets.length - 1] : null;
    const lastMs = last ? ts(last.start_time) : NaN;
    const expectH = pol?.enabled ? Math.min(pol.fullEveryHours, pol.incrEveryHours || pol.fullEveryHours) : 0;
    if (!sets.length && standbySite) {
      // backups are taken on the primary site (same database, shared repository): nothing to report here
    } else if (!sets.length && !lastNews && !online.length) {
      // never reported yet: whether it has backups is unknown, not 'none' (the first report says)
    } else if (!sets.length) {
      add({ severity: isProd || pol?.enabled ? 'critical' : 'warning', code: 'no_backup', title: 'No backup yet', cause: pol?.enabled ? 'The policy is active but there is no successful backup yet: the data is not protected.' : isProd ? 'The cluster has neither a backup policy nor any backups: the data is not protected.' : 'Not a production cluster, so this is not urgent, but it has neither a backup policy nor any backups: its data is not protected.', action: { label: pol?.enabled ? 'See the backups' : 'Assign a policy', page: pol?.enabled ? 'backup' : 'strategy' } });
    } else if (expectH && Number.isFinite(lastMs) && now - lastMs > expectH * 3600_000 * 2) {
      const age = (now - lastMs) / 3600_000;
      add({ severity: age > expectH * 4 ? 'critical' : 'warning', code: 'backup_stale', title: `Last backup ${hrs(age)} ago`, cause: `The policy expects a backup every ${hrs(expectH)}: at least one is missing. Check the last error or whether the agent is offline.`, action: { label: 'See the backups', page: 'backup' } });
    }
    // backups exist but nothing schedules them: protection depends on someone remembering. Said where everyone looks (the badge, the list,
    // Today), not only inside the Backup tab (an independent review found a production cluster "Healthy" in that state)
    if (sets.length && !standbySite && !pol?.enabled) add({ severity: isProd ? 'warning' : 'info', code: 'no_schedule', title: 'Backups are not scheduled',
      cause: `Only manual backups run${Number.isFinite(lastMs) ? ` (the last one ${hrs((now - lastMs) / 3600_000)} ago)` : ''}: assign a backup policy so protection does not depend on someone remembering.`, action: { label: 'Schedule backups', page: 'backup' } });
    const failedSince = (bk?.last_failure && (!last || ts(bk.last_failure.start_time) > lastMs)) ? bk.last_failure : null;
    if (failedSince) add({ severity: 'warning', code: 'backup_failed', title: 'The last backup attempt failed', cause: String(failedSince.reason || 'Reason not reported.').slice(0, 300), action: { label: 'See the backups', page: 'backup' } });
    const lastVerify = (st.operations as any[]).filter(o => o.clusterId === c.id && o.type === 'backup_verify' && o.status === 'succeeded').map(o => ts(o.updatedAt)).sort().pop();
    // a verification that FAILED is a backup that may not restore: said where everyone looks, until the same verification succeeds
    const vFail = (st.operations as any[]).filter(o => o.clusterId === c.id && o.type === 'backup_verify' && o.status === 'failed' && now - ts(o.updatedAt) < 7 * 86400_000)
      .filter(o => !(st.operations as any[]).some(x => x.status === 'succeeded' && sameWork(x, o) && ts(x.updatedAt) > ts(o.updatedAt))).sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt))[0];
    if (vFail) add({ severity: isProd ? 'critical' : 'warning', code: 'verify_failed', title: 'A backup verification failed', cause: `${String(vFail.error?.message || vFail.error || 'No reason reported.').slice(0, 300)} (${hrs((now - ts(vFail.updatedAt)) / 3600_000)} ago). Until the same verification succeeds, that backup may not restore.`, action: { label: 'See the backups', page: 'backup' } });
    if (pol?.enabled && pol.verifyEveryHours && sets.length) {
      const base = Number.isFinite(lastVerify as number) ? (lastVerify as number) : lastMs;
      if (now - base > pol.verifyEveryHours * 3600_000 * 2) add({ severity: 'info', code: 'verify_stale', title: 'Backup verification overdue', cause: lastVerify ? `Last successful verification ${hrs((now - lastVerify) / 3600_000)} ago.` : 'No successful verification so far: an unverified backup is only a hope.', action: { label: 'See the backups', page: 'backup' } });
    }

    const drills = (st.operations as any[]).filter(o => o.clusterId === c.id && o.type === 'restore_drill' && o.status === 'succeeded');
    const lastDrill = drills.length ? drills[drills.length - 1] : null;
    // a drill the policy schedules that FAILED (and nothing succeeded since): restorability is in doubt - said, with the error
    const dFail = (st.operations as any[]).filter(o => o.clusterId === c.id && o.type === 'restore_drill' && o.status === 'failed' && (!lastDrill || o.updatedAt > lastDrill.updatedAt)).pop();
    if (dFail && sets.length && !standbySite) add({ severity: isProd ? 'warning' : 'info', code: 'drill_failed', title: 'The last disaster recovery drill failed',
      cause: `${String(dFail.error?.message || dFail.error || 'No reason reported.').split('\n')[0].slice(0, 240)} — until a drill succeeds, a full restore of this cluster is not proven to work.`, action: { label: 'See the backups', page: 'backup' } });
    const drillDays = pol?.enabled && pol.drillEveryDays ? pol.drillEveryDays : 0;
    const staleAfter = drillDays ? 2 * drillDays : 90;
    if (isProd && sets.length && !standbySite && !dFail && (!lastDrill || now - Date.parse(lastDrill.updatedAt) > staleAfter * 86400_000))
      add({ severity: drillDays && lastDrill ? 'warning' : 'info', code: 'drill_stale', title: lastDrill ? `Disaster recovery drill older than ${staleAfter} days` : 'Full restore never tested', cause: lastDrill ? 'A periodic drill confirms that restore still works and how long it takes.' : 'You do not know yet how long restoring the whole cluster would take: a drill measures it without touching production.', action: { label: 'See the backups', page: 'backup' } });

    // ---- PostgreSQL version: supported / legacy / end-of-life, and binaries of another major (the agent knows which binaries it uses)
    const seenVer = new Set<string>();
    for (const n of online) {
      const pgn = n.snapshot?.postgres || {};
      const cmp = pgn.compat || (() => { const k = classify(pgn.version); return k ? { label: k.label, problems: k.problems.map(p => ({ severity: p.severity, code: p.code, text: p.text })), tool_problems: [] } : null; })();
      if (!cmp) continue;
      for (const p of (cmp.problems || []) as any[]) {
        const code = 'pg_' + p.code;
        if (seenVer.has(code + cmp.label)) continue;                     // same major on several nodes: one issue per cluster
        seenVer.add(code + cmp.label);
        add({ severity: p.severity, code, detail: String(cmp.label), title: p.code === 'eol' ? `PostgreSQL ${cmp.label} is end-of-life` : p.code === 'unsupported' ? `PostgreSQL ${cmp.label} is not supported` : p.code === 'legacy' ? `PostgreSQL ${cmp.label} in legacy mode` : `PostgreSQL ${cmp.label} not verified yet`, cause: String(p.text || '') });
      }
      for (const t of (cmp.tool_problems || []) as any[])
        add({ severity: t.severity, code: 'pg_' + t.code, detail: n.id, nodeId: n.id, nodeName: n.name, title: `${n.name}: PostgreSQL binaries do not match the server`, cause: String(t.text || '') });
    }

    // ---- WAL / archiving
    const wal = (primary || nodes[0])?.snapshot?.wal;
    if (wal && wal.gap_count > 0 && !standbySite) add({ severity: 'critical', code: 'wal_gap', title: `WAL archive with ${wal.gap_count === 1 ? 'a gap' : `${wal.gap_count} gaps`}`, cause: 'WAL segments are missing: point-in-time recovery past the gap is not possible. Take a new full backup right away.', action: { label: 'See restore', page: 'restore' } });
    // the standby site of a geo pair shares the primary site's archive: its findings are the primary's, said once there
    if (wal && wal.conflicts > 0 && !standbySite) add({ severity: wal.conflicts_newest && now - wal.conflicts_newest * 1000 > 7 * 86400_000 ? 'warning' : 'critical', code: 'wal_conflict', title: `${wal.conflicts} ${wal.conflicts === 1 ? 'divergent WAL copy' : 'divergent WAL copies'} in quarantine`,
      cause: 'Two servers archived different content under the same name (possible split-brain: two primaries at once, or two promotions to the same timeline number). The archive kept the first copy and set the others aside. Check which server was the right primary, then mark the copies as reviewed (they are kept).',
      action: { label: 'Review', page: 'backup' } });
    // copies a failover left behind (the old primary's tail of a timeline it left, partial segments): the agent proved the current history never
    // reads them, so they are not a split-brain signal. Informational, with the one-click way to file them away
    else if (wal && wal.conflicts_off_history > 0 && !standbySite) add({ severity: 'info', code: 'wal_leftovers', title: `${wal.conflicts_off_history} WAL ${wal.conflicts_off_history === 1 ? 'copy' : 'copies'} left behind by a failover`,
      cause: 'Kept in the archive’s quarantine. Recovery along the current timeline does not read them (the old primary’s tail of a timeline it left, whose successor copy is archived, or partial segments); only a restore that deliberately follows the old timeline would. File them away from the Backup tab once seen.',
      action: { label: 'Review', page: 'backup' } });
    const arch = pg.archiver;
    if (arch?.last_failed_time && (!arch.last_archived_time || ts(arch.last_failed_time) > ts(arch.last_archived_time)) && now - ts(arch.last_failed_time) < 3600_000 * 6)
      if (/\.history$/.test(String(arch.last_failed_wal || '')) && /PGA-WAL-03[13]/.test(String(pg.archive_error?.error || '')))
        // two servers promoted themselves to the same timeline number: the archiver waits forever on this history file
        add({ severity: 'critical', code: 'archiver_history_conflict', title: `Archiving stuck: timeline history ${arch.last_failed_wal} already exists with different content`,
          cause: `Two servers promoted themselves to the same timeline number (split-brain between sites, or a promotion without access to the shared archive). PostgreSQL archives nothing after this file: WAL piles up and point-in-time restores stop here. The current primary is the right one: on its Backup tab, “Retire the dead branch” of that timeline sets the other server’s copies aside (nothing is deleted) and archiving resumes by itself. To prevent it: “Recovery from the archive” (restore_command) on both sites, in Geo-redundancy.`,
          action: { label: 'See the backups', page: 'backup' } });
      else {
        // a divergent copy (two servers on the same timeline number) blocks PostgreSQL's archiver on that segment for ever: name the way out
        const why = String(pg.archive_error?.error || ''); const tl = /^[0-9A-F]{24}$/i.test(String(arch.last_failed_wal || '')) ? parseInt(String(arch.last_failed_wal).slice(0, 8), 16) : null;
        const divergent = /PGA-WAL-03[13]/.test(why);
        add({ severity: 'critical', code: 'archiver_failing', title: 'WAL archiving is failing', cause: `Last failed segment: ${arch.last_failed_wal || '?'}${why ? ` — reason: ${why}` : ''}. Until this is fixed, WAL piles up on the server and the disk fills up.${divergent ? ` The archive already holds another server's copy of this ${tl ? `timeline ${tl} ` : ''}file (two servers used the same timeline number): PostgreSQL retries it for ever and archives nothing after it. If this server is the right primary, retire the dead branch${tl ? ` of timeline ${tl}` : ''} in Backup → divergent WAL copies: the archive's copies are set aside (nothing is deleted), this server's take their place and archiving resumes.` : ''}`,
          action: { label: divergent ? 'Retire the dead branch' : 'See the backups', page: 'backup' } });
      }
    // ---- asynchronous archiving: segments parked in the local spool are NOT in the archive (not restorable, lost with the host). The archive refusing
    // a segment is invisible to pg_stat_archiver in this mode: the pusher's own error is what says it
    const sp = wal?.spool;
    if (sp && (sp.pending > 0 || sp.last_error)) {
      const oldest = Number(sp.oldest_age_sec) || 0;
      if (sp.last_error) add({ severity: 'critical', code: 'wal_spool_failing', title: `WAL archiving is failing (${sp.pending} segments wait in the local spool)`,
        cause: `The agent cannot push ${sp.last_error.segment || 'a segment'} into the archive: ${String(sp.last_error.error || '').slice(0, 300)}. PostgreSQL believes they are archived (asynchronous mode): until this is fixed they are only on this host.`, action: { label: 'See the backups', page: 'backup' } });
      else if (sp.pending >= 64 || oldest > 900) add({ severity: sp.pending >= 256 || oldest > 3600 ? 'critical' : 'warning', code: 'wal_spool_behind', title: `${sp.pending} WAL segments wait in the local spool (oldest ${hrs(oldest / 3600)})`,
        cause: 'Asynchronous archiving: the pusher is slower than the WAL rate. These segments are not in the archive yet: not restorable from it, and lost if this host is lost. Check the archive destination speed and the node load.', action: { label: 'See the backups', page: 'backup' } });
      else if (sp.alive === false) add({ severity: 'warning', code: 'wal_spool_behind', title: `${sp.pending} WAL segments wait in the local spool and the pusher is not running`, cause: 'The agent process that pushes the spool into the archive does not report a heartbeat: restart pg-arca-agent on this node. Meanwhile archive_command archives synchronously (nothing new is spooled).', action: { label: 'See the backups', page: 'backup' } });
    }
    // ---- archiver lag: segments written but not archived yet. archive_command slower than the WAL rate (slow share, zlib fallback) piles WAL up on the
    // primary and widens the recovery point; pg_stat_archiver only shows failures, so the backlog is computed from the current LSN
    if (arch?.last_archived_wal && pg.current_lsn && pg.settings) {
      const segBytes = Number(pg.settings.wal_segment_size) > 0 ? Number(pg.settings.wal_segment_size) : 16 * 1048576;
      const cur = lsnToBig(pg.current_lsn); const m = /^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})$/i.exec(String(arch.last_archived_wal));
      if (cur !== null && m) {
        const segsPerLog = BigInt(Math.floor(0x100000000 / segBytes));
        const archivedSeg = BigInt('0x' + m[2]) * segsPerLog + BigInt('0x' + m[3]);
        const curSeg = cur / BigInt(segBytes);
        const behind = Number(curSeg - archivedSeg - 1n);                             // the segment being written does not count
        if (behind >= 16) add({ severity: behind >= 128 ? 'critical' : 'warning', code: 'archiver_lag', title: `WAL archiving is ${behind} segments behind (${bytesH(behind * segBytes)})`,
          cause: `The archiver has not caught up with what PostgreSQL writes: archive_command is slower than the WAL rate (slow destination, zlib instead of zstd, a saturated node). Until it catches up these segments sit in pg_wal (disk) and are not restorable from the archive (recovery point). If it keeps growing: faster destination, python3-zstandard on the node, or less WAL (wal_compression=on).`, action: { label: 'See the backups', page: 'backup' } });
      }
    }
    // ---- recovery objectives declared in the policy: measured recovery point / estimated recovery time above them, or a configuration that cannot meet them
    if (pol?.enabled && (pol.rpoTargetMinutes || pol.rtoTargetMinutes) && primary) {
      const ob = objectives(st, c.id, now)!;
      if (ob.targets.rpoSeconds && ob.rpo.seconds != null && ob.rpo.state !== 'ok') {
        const t = Number(pg.settings?.archive_timeout) || 0, tgt = ob.targets.rpoSeconds, mins = Math.round(tgt / 60);
        const setting = `Set archive_timeout = ${tgt} s on the cluster (through the DCS on Patroni); the cost is one ${bytesH(Number(pg.settings?.wal_segment_size) || 16 * 1048576)} segment every ${mins} min when idle.`;
        if (ob.rpo.state === 'bad') add({ severity: 'critical', code: 'rpo_target', title: `Recovery point above the ${mins} min objective`,
          cause: `${ob.rpo.text} Data written in the last ${Math.round(ob.rpo.seconds / 60)} minutes would be lost with the primary. ${t > tgt ? setting : 'The archiver is late: see the WAL archiving findings of this cluster.'}`,
          action: t > tgt ? { label: 'Open the parameters', page: 'params' } : { label: 'See the backups', page: 'backup' } });
        else add({ severity: 'warning', code: 'rpo_target', title: `The ${mins} min recovery point objective is not guaranteed`,
          cause: `archive_timeout is not set: a segment with little traffic can stay on the primary longer than the ${mins} min objective. ${setting}`, action: { label: 'Open the parameters', page: 'params' } });
      }
      if (ob.targets.rtoSeconds && ob.rto.state === 'bad' && ob.rto.estimateSeconds != null)
        add({ severity: 'warning', code: 'rto_target', title: `Recovery time above the ${durH(ob.targets.rtoSeconds)} objective`,
          cause: `${ob.rto.text} A faster restore host (CPU, disks, network to the repository), python3-zstandard on the nodes, or a smaller database would bring it down; otherwise the objective should be renegotiated before it is needed.`, action: { label: 'See the backups', page: 'backup' } });
    }
    if (pol?.enabled && pg.settings && pg.settings.archive_mode === 'off') add({ severity: 'warning', code: 'archive_off', title: 'archive_mode is off', cause: 'The backup policy is active but PostgreSQL does not archive WAL: no point-in-time recovery.', action: { label: 'See the backups', page: 'backup' } });

    // ---- shared storage: a switchover/failover moves archiving to another node. If every node writes to ITS OWN local repo / WAL archive, the archive splits and PITR breaks silently.
    if (online.length >= 2) {
      for (const [field, what] of [['wal_id', 'The WAL archive'], ['repo_id', 'The backup repository']] as const) {
        const ids = new Map<string, string[]>();
        for (const n of online) { const v = n.snapshot?.storage?.[field]; if (v) ids.set(v, [...(ids.get(v) || []), n.name]); }
        if (ids.size >= 2) add({ severity: 'warning', code: field === 'wal_id' ? 'wal_not_shared' : 'repo_not_shared', title: `${what} is not shared between the nodes`, cause: `Each node writes into its own directory (${[...ids.values()].map(v => v.join(', ')).join(' | ')}). After a switchover or a failover, WAL and backups end up on another node and point-in-time recovery breaks silently. Mount the same shared storage (NFS, CephFS, shared volume…) at the same path on every node and set it in the agent settings.`, action: { label: 'Agent paths', page: 'nodes' } });
      }
    }

    // ---- replication / slots / connections / disk
    for (const n of online) {
      const dn = (n.snapshot?.postgres?.replication || []) as any[];
      for (const r of dn) {
        const lag = Number(r.replay_lag_bytes) || 0;
        if (lag > 64 * 1048576) add({ severity: lag > GB ? 'critical' : 'warning', code: 'repl_lag', detail: String(r.application_name), nodeId: n.id, nodeName: n.name, title: `Replica ${r.application_name} lagging by ${bytesH(lag)}`, cause: 'The replica is not catching up: slow network, saturated disk or long queries on the replica.', action: { label: 'Open the cluster', page: 'cluster' } });
      }
      for (const s of (n.snapshot?.postgres?.slots || []) as any[]) {
        const kept = Number(s.retained_bytes) || 0;
        if (!s.active && kept > GB) add({ severity: kept > 10 * GB ? 'critical' : 'warning', code: 'slot_stale', detail: String(s.name), nodeId: n.id, nodeName: n.name, title: `Inactive slot “${s.name}” retains ${bytesH(kept)} of WAL`, cause: 'Nothing is consuming this slot: PostgreSQL keeps all WAL and the disk fills up. If the replica is no longer needed, drop the slot.', action: { label: 'Open the cluster', page: 'cluster' } });
      }
      const conn = n.snapshot?.postgres?.connections;
      if (conn?.max && conn.used / conn.max > 0.85) add({ severity: conn.used / conn.max > 0.95 ? 'critical' : 'warning', code: 'connections', detail: n.id, nodeId: n.id, nodeName: n.name, title: `Connections at ${Math.round(conn.used / conn.max * 100)}% on ${n.name}`, cause: `${conn.used} of ${conn.max}: new connections will be refused. Consider a pooler or reviewing idle sessions.`, action: { label: 'Open the cluster', page: 'cluster' } });
      for (const [label, d] of Object.entries((n.snapshot?.system?.disks || {}) as Record<string, any>)) {
        if (!d?.total_bytes) continue;
        const free = d.free_bytes / d.total_bytes;
        if (free < 0.15) add({ severity: free < 0.07 ? 'critical' : 'warning', code: 'disk', detail: `${n.id}:${label}`, nodeId: n.id, nodeName: n.name, title: `Disk ${label} almost full on ${n.name} (${Math.round(free * 100)}% free)`, cause: label === 'repo' ? 'The backup repository is running out of space: reduce retention or grow the volume.' : label === 'wal_archive' ? 'The WAL archive is running out of space: check the backup retention.' : 'If the data disk fills up, PostgreSQL stops.', action: { label: 'Open the cluster', page: 'cluster' } });
      }
      const pv = n.snapshot?.patroni; const ps = n.snapshot?.postgres?.settings || {};
      if (pv?.accessible && (pv.members?.length || 0) + (pv.standby_cluster ? 1 : 0) >= 2 && !out.some(x => x.key === `${c.id}:patroni_rewind:dcs`)) {
        const hints = ps.wal_log_hints === 'on' || ps.data_checksums === 'on' || n.snapshot?.postgres?.checksums === true;
        if (pv.use_pg_rewind === false || pv.use_pg_rewind == null) add({ severity: 'warning', code: 'patroni_rewind', detail: 'dcs', nodeId: n.id, nodeName: n.name, title: 'Patroni without pg_rewind (use_pg_rewind off)',
          cause: 'After a failover the old leader, or a replica that got ahead, cannot be realigned and Patroni rebuilds it by copying all the data (or it stays stuck). Enable postgresql.use_pg_rewind in the dynamic configuration (patronictl edit-config).', action: { label: 'Open high availability', page: 'ha' } });
        else if (pv.use_pg_rewind === true && ps.wal_log_hints !== undefined && !hints) add({ severity: 'warning', code: 'patroni_rewind', detail: 'dcs', nodeId: n.id, nodeName: n.name, title: 'pg_rewind enabled but unusable',
          cause: 'pg_rewind requires wal_log_hints = on or data checksums: neither is active, so after a failover the realignment fails. Set wal_log_hints = on (restart required).', action: { label: 'Open parameters', page: 'params' } });
      }
      const plc = n.snapshot?.postgres?.hba_patroni_local;
      if (plc && plc.ok === false && !out.some(x => x.key === `${c.id}:patroni_local_replication:hba`)) add({ severity: 'warning', code: 'patroni_local_replication', detail: 'hba', nodeId: n.id, nodeName: n.name,
        title: 'pg_hba does not allow Patroni’s local replication connection',
        cause: `Patroni reads the replicas’ timeline through a local replication connection (127.0.0.1, user ${plc.denied.join(', ')}), which pg_hba rejects. After a failover a replica (or a whole standby site) that got ahead of the new leader is not realigned with pg_rewind and stays stuck. Rule to add: ${plc.suggest[0] || ''}.`,
        action: { label: 'Open the access rules', page: 'hba' } });
      if (n.snapshot?.postgres?.pending_restart?.length) add({ severity: 'info', code: 'pending_restart', detail: n.id, nodeId: n.id, nodeName: n.name, title: `${n.name}: restart pending`, cause: `Parameters changed but not active yet: ${n.snapshot.postgres.pending_restart.slice(0, 5).join(', ')}.` });
      // ---- PostgreSQL 17+: with summarize_wal the incrementals read only the changed relation files instead of the whole data directory
      if (!n.snapshot?.postgres?.is_in_recovery && ps.summarize_wal === 'off' && pol?.enabled && pol.incrEveryHours && !out.some(x => x.key === `${c.id}:summarize_wal_off:dcs`))
        add({ severity: 'info', code: 'summarize_wal_off', detail: 'dcs', nodeId: n.id, nodeName: n.name, title: 'Incremental backups read the whole data directory (summarize_wal is off)',
          cause: 'PostgreSQL 17 can keep WAL summaries: with summarize_wal = on an incremental backup reads only the relation files that changed since the parent backup instead of every page of the cluster (same mechanism as pg_basebackup --incremental). Set summarize_wal = on (reload is enough; on Patroni through the dynamic configuration); the first incremental after that still scans everything, the next ones do not.', action: { label: 'Open parameters', page: 'params' } });
      // ---- offsite copy (S3): configured on this node but failing or behind -> the "copy outside the building" is not current
      const off = n.snapshot?.offsite;
      if (off?.configured && off.enabled) {
        const lastOk = Number(off.last_ok) ? Number(off.last_ok) * 1000 : NaN;
        const behindH = Number.isFinite(lastOk) ? (now - lastOk) / 3600_000 : Infinity;
        if (off.last_error || behindH > 6) add({ severity: behindH > 48 || !Number.isFinite(lastOk) ? 'critical' : 'warning', code: 'offsite_behind', detail: n.id, nodeId: n.id, nodeName: n.name,
          title: off.last_error ? `${n.name}: the offsite copy is failing` : `${n.name}: the offsite copy is ${hrs(behindH)} behind`,
          cause: `${off.last_error ? `Last error: ${String(off.last_error).slice(0, 200)}. ` : ''}${Number.isFinite(lastOk) ? `Last successful sync ${hrs(behindH)} ago` : 'No successful sync so far'}${off.pending ? `; ${off.pending} objects waiting` : ''}. Bucket ${off.bucket} at ${off.endpoint}: check the credentials, the network path and the bucket policy on this node (Status → Nodes → Offsite copy).`, action: { label: 'Open the nodes', page: 'nodes' } });
      }
      // ---- compression: without python zstandard the agent compresses backup chunks with zlib (measured 5-10x slower per core); without the zstd binary WAL is archived uncompressed
      const tc = n.snapshot?.toolchain;
      if (tc && typeof tc === 'object' && 'python_zstandard' in tc) {
        if (!tc.python_zstandard) add({ severity: pol?.enabled ? 'warning' : 'info', code: 'no_zstd_python', detail: n.id, nodeId: n.id, nodeName: n.name, title: `${n.name}: backups run without zstd (5-10x slower)`,
          cause: `The Python module zstandard is not installed on this node, so backup chunks are compressed with zlib: a full backup takes several times longer and uses more CPU${tc.zstd ? '' : ' (WAL segments fall back to gzip too: the zstd command is missing as well)'}. Install python3-zstandard (Debian/Ubuntu: apt install python3-zstandard; RHEL family: dnf install python3-zstandard, from EPEL on older releases) and restart pg-arca-agent. Existing backups stay readable.` });
      }
    }
  }
  for (const i of geoIssues(st, now)) out.push(i);
  // ---- operational machines: a recovery host that is down or full stops every restore that depends on it
  const centralUsers = (id: string) => Object.entries(((st.settings?.scoped || {}).ephemeral || {}) as Record<string, any>).filter(([, v]) => v?.placement === 'central' && v?.centralNode === id).map(([k]) => k);
  for (const n of Object.values(st.nodes || {}) as any[]) {
    if (n.kind !== 'worker') continue;
    const users = centralUsers(n.id);
    const add = (i: Omit<Issue, 'clusterId' | 'clusterName' | 'environment' | 'key'> & { detail?: string }) => {
      const { detail, ...rest } = i;
      out.push({ ...rest, key: `worker:${n.id}:${i.code}${detail ? ':' + detail : ''}`, clusterId: `worker:${n.id}`, clusterName: n.name, environment: '', nodeId: n.id, nodeName: n.name });
    };
    const isOn = !!n.lastSeen && now - Date.parse(n.lastSeen) < ONLINE_MS;
    if (!isOn) add({ severity: users.length ? 'critical' : 'warning', code: 'worker_offline', title: `Worker host ${n.name} unreachable`, cause: users.length ? `It is the restore node for ${users.length} configuration levels: until it is back, those restores cannot start.` : 'The agent has not responded for more than 45 seconds.', action: { label: 'Open the host' } });
    const w = n.snapshot?.worker || {};
    for (const m of (w.mounts || []) as any[]) {
      if (!m.total_bytes) continue;
      const free = m.free_bytes / m.total_bytes;
      if (free < 0.15) add({ severity: free < 0.07 ? 'critical' : 'warning', code: 'worker_disk', detail: m.mount, title: `${n.name}: ${m.mount} almost full (${Math.round(free * 100)}% free)`, cause: m.remote ? 'A network share used for backups is running out of space.' : 'Restores or backups run on this host: without space they fail.', action: { label: 'Open the host' } });
    }
    if (users.length && Array.isArray(w.pg_installations)) {
      const have = new Set((w.pg_installations as any[]).map(i => Number(i.major)));
      // only the clusters that really restore HERE (their effective configuration says central + this machine): another cluster's version is not this machine's business
      const need = new Map<number, string[]>();
      for (const c of st.clusters as any[]) {
        const m = parseInt(String(c.pgVersion || ''), 10);
        if (!m || c.isSandbox) continue;
        let eff: any; try { eff = resolveScoped(st, 'ephemeral', c).value; } catch { continue; }
        if (eff.placement !== 'central' || eff.centralNode !== n.id) continue;
        need.set(m, [...(need.get(m) || []), c.name]);
      }
      const missing = [...need.keys()].filter(m => !have.has(m)).sort((a, b) => a - b);
      if (missing.length) add({ severity: 'warning', code: 'worker_pg_missing', title: `${n.name}: PostgreSQL ${missing.join(', ')} binaries are missing`,
        cause: `It is the restore node of ${missing.map(m => `${(need.get(m) || []).slice(0, 3).join(', ')} (PostgreSQL ${m})`).join('; ')}: it cannot restore their backups until you install the binaries (one click from the host page).`, action: { label: 'Open the host' } });
    }
  }
  return out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.clusterName.localeCompare(b.clusterName));
}

/** An operation refused by a check BEFORE it changed anything: what the operator asked could not or should not be done (not a product failure). */
export function isRefusal(err: string, type = ''): boolean {
  if (/^refused\b|would lock out|refused before touching|lock.?out/i.test(err)) return true;
  if (/^PGA-(SEC-030|GEN-03[0-4]|GEN-065|GEN-08[0-8]|GEN-09[34]|PITR-00[12]|PITR-016|RST-03[1-3]|RST-04[01]|WAL-022|INS-002)\b/.test(err)) return true;
  return type === 'restore_plan';                                              // a plan that says "no" is its answer, not a failure
}

/** "Is this cluster protected?" answered in one place, for the cluster list, the cluster header and Today (an independent UX review found the
 *  answer spread over five screens with contradicting colours). state: ok | warn | bad | none (not backed up by this console: demo, direct
 *  connection, a standby site whose backups are taken on its primary). The words are built by the page (relative times stay current). */
export function protectionOf(st: any, clusterId: string, issues: Issue[], now = Date.now()) {
  const c = (st.clusters as any[]).find(x => x.id === clusterId);
  if (!c || c.isSandbox || c.source === 'direct') return { state: 'none' as const, reason: 'not_managed' };
  const nodes = Object.values(st.nodes || {}).filter((n: any) => n.clusterId === clusterId) as any[];
  const bk = (nodes.filter(n => n.snapshot?.backup?.configured).sort((a, b) => (b.snapshot.backup.sets || 0) - (a.snapshot.backup.sets || 0))[0])?.snapshot?.backup;
  const sets: any[] = (bk?.recent_sets || []).filter((s: any) => s.status === 'COMPLETE');
  const at = (s: any) => s ? (s.stop_time || s.start_time || null) : null;
  const lastBackupAt = at(sets[sets.length - 1]); const fulls = sets.filter(s => s.type === 'full'); const lastFullAt = at(fulls[fulls.length - 1]);
  const ob = objectives(st, clusterId, now);
  const offs = nodes.map(n => n.snapshot?.offsite).filter((o: any) => o?.configured && o.enabled);
  const offLast = Math.max(0, ...offs.map((o: any) => Number(o.last_ok) || 0));
  const mine = issues.filter(i => i.clusterId === clusterId);
  const KEY = new Set(['no_backup', 'no_schedule', 'verify_failed', 'backup_stale', 'backup_failed', 'archiver_failing', 'archive_off', 'rpo_target', 'wal_gap', 'wal_spool_failing', 'offsite_behind', 'archiver_lag', 'tablespace_after_full', 'restore_incomplete']);
  const relevant = mine.filter(i => KEY.has(i.code));
  const standbySite = !sets.length && nodes.some(n => n.snapshot?.patroni?.local_node?.role === 'standby_leader');
  const state = standbySite ? 'none' as const
    : !sets.length || relevant.some(i => i.severity === 'critical') || ob?.rpo.state === 'bad' ? 'bad' as const
    : relevant.some(i => i.severity === 'warning') || ob?.rpo.state === 'warn' ? 'warn' as const : 'ok' as const;
  return { state, reason: standbySite ? 'standby_site' : undefined, lastBackupAt, lastFullAt, backups: sets.length,
    rpoSeconds: ob?.rpo.seconds ?? null, rpoState: ob?.rpo.state || 'unknown', archiving: ob?.rpo.state === 'bad' && ob?.rpo.seconds == null ? (/off/.test(ob.rpo.text) ? 'off' : 'failing') : 'ok',
    rtoSeconds: ob?.rto.estimateSeconds ?? null, offsiteAt: offs.length ? (offLast ? new Date(offLast * 1000).toISOString() : null) : undefined,
    problems: relevant.slice(0, 3).map(i => ({ code: i.code, severity: i.severity, title: i.title })) };
}

export function briefing(st: any, now = Date.now()) {
  const issues = evaluate(st, now);
  const counts = { critical: 0, warning: 0, info: 0 } as Record<Severity, number>;
  for (const i of issues) counts[i.severity]++;
  const since = now - 24 * 3600_000;
  const recentOps = (st.operations as any[]).filter(o => Date.parse(o.updatedAt) >= since);
  const clusters = (st.clusters as any[]).filter(c => !c.isSandbox && c.source !== 'direct').map(c => {
    const mine = issues.filter(i => i.clusterId === c.id);
    const dr = (st.operations as any[]).filter(o => o.clusterId === c.id && o.type === 'restore_drill' && o.status === 'succeeded').pop();
    return { id: c.id, name: c.name, environment: c.environment, folder: c.folder || '', issues: mine.length, worst: mine[0]?.severity || 'ok', rto: dr?.result?.rto_seconds != null ? { seconds: dr.result.rto_seconds, at: dr.updatedAt, bytes: dr.result.data_bytes } : null,
      protection: protectionOf(st, c.id, issues, now) };
  });
  return {
    generatedAt: new Date(now).toISOString(), status: counts.critical ? 'critical' : counts.warning ? 'warning' : 'ok', counts, issues, clusters,
    // a safety check that said NO before touching anything (lock-out, wrong target, name taken, plan that cannot work) is not a failure of the product:
    // counted apart, so the number that matters ("something broke") is not drowned
    last24h: (() => {
      const failed = recentOps.filter(o => o.status === 'failed');
      const refusal = (o: any) => isRefusal(String(o.error?.message || o.error || ''), o.type);
      const real = failed.filter(o => !refusal(o));
      // the same failure repeated (a scheduled backup hitting one broken destination all day) is ONE line with a count, and a failure followed by a
      // success of the same operation on the same cluster is resolved: the headline counts what is still broken (the lab read '78 failed operations')
      const errOf = (o: any) => String(o.error?.message || o.error || '');
      const okAfter = (o: any) => recentOps.some(x => x.status === 'succeeded' && sameWork(x, o) && String(x.updatedAt) > String(o.updatedAt));
      const groups = new Map<string, any>();
      for (const o of real) { const k = `${o.type}|${o.clusterId}|${o.type === 'backup_run' ? '' : o.nodeId}|${workKey(o.params)}|${errOf(o).replace(/[0-9A-F]{24}|\d{8}-\d{6}[FDI]?|\d+/g, '#').slice(0, 120)}`; const g = groups.get(k);
        if (g) { g.count++; if (String(o.updatedAt) > String(g.at)) { g.at = o.updatedAt; g.id = o.id; g.error = errOf(o).slice(0, 200); } }
        else groups.set(k, { id: o.id, type: o.type, clusterId: o.clusterId, nodeId: o.nodeId, params: o.params, at: o.updatedAt, first: o.updatedAt, error: errOf(o).slice(0, 200), count: 1 }); }
      const glist = [...groups.values()].map(({ params, nodeId, ...g }) => ({ ...g, resolved: okAfter({ ...g, params, nodeId, updatedAt: g.at }) })).sort((a, b) => Number(a.resolved) - Number(b.resolved) || String(b.at).localeCompare(String(a.at)));
      return { operations: recentOps.length, failed: real.length, unresolved: real.filter(o => !okAfter(o)).length, refused: failed.length - real.length, backups: recentOps.filter(o => o.type === 'backup_run' && o.status === 'succeeded').length,
        failures: glist.slice(0, 8),
        refusals: failed.filter(refusal).slice(-5).reverse().map(o => ({ id: o.id, type: o.type, clusterId: o.clusterId, at: o.updatedAt, error: String(o.error?.message || o.error || '').slice(0, 200) })) };
    })(),
  };
}

/**
 * Recovery objectives of one cluster, from what the console knows right now:
 *  - RPO: how much could be lost if the primary vanished this second = what is not in the WAL archive yet: the time since the last archived segment,
 *    plus up to archive_timeout for the segment being written (a failing archiver makes it unbounded);
 *  - RTO: the last disaster-recovery drill measured a whole-cluster restore (seconds, bytes); scaled to today's size it is the best estimate there is.
 */
export function objectives(st: any, clusterId: string, now = Date.now()) {
  const c = (st.clusters as any[]).find(x => x.id === clusterId);
  if (!c) return null;
  const nodes = Object.values(st.nodes || {}).filter((n: any) => n.clusterId === clusterId) as any[];
  const online = nodes.filter(n => n.lastSeen && now - Date.parse(n.lastSeen) < ONLINE_MS);
  const primary = online.find(n => n.snapshot?.postgres?.is_in_recovery === false);
  const pg = primary?.snapshot?.postgres || {};
  const arch = pg.archiver || {};
  const sizeBytes = ((pg.databases || []) as any[]).reduce((a, d) => a + (Number(d?.size) || 0), 0);
  const timeout = Number(pg.settings?.archive_timeout) || 0;
  const pol = resolvePolicy(st, c).policy;
  const rpoTarget = pol?.enabled ? (Number(pol.rpoTargetMinutes) || 0) * 60 : 0, rtoTarget = pol?.enabled ? (Number(pol.rtoTargetMinutes) || 0) * 60 : 0;
  const dur = durH;
  const lastArch = ts(arch.last_archived_time);
  const failing = !!arch.last_failed_time && (!arch.last_archived_time || ts(arch.last_failed_time) > lastArch);
  let rpo: { seconds: number | null; state: 'ok' | 'warn' | 'bad' | 'unknown'; text: string; openSegment?: boolean };
  if (!primary) rpo = { seconds: null, state: 'unknown', text: 'No reachable primary: the recovery point cannot be measured.' };
  else if (pg.settings?.archive_mode === 'off') rpo = { seconds: null, state: 'bad', text: 'WAL archiving is off: only the backups themselves can be recovered (no point-in-time recovery).' };
  else if (failing) rpo = { seconds: null, state: 'bad', text: `WAL archiving is failing since ${new Date(arch.last_failed_time).toISOString().slice(0, 16).replace('T', ' ')}: everything written since then is at risk.` };
  else if (!Number.isFinite(lastArch)) rpo = { seconds: null, state: 'warn', text: 'Nothing archived yet.' };
  else {
    const since = Math.max(0, (now - lastArch) / 1000);
    const spoolAge = Number(primary?.snapshot?.wal?.spool?.oldest_age_sec) || 0;          // asynchronous archiving: what waits in the local spool is not archived yet
    // How old is the oldest WAL byte not archived yet? "since the last archived segment" is only an upper bound, and on an IDLE cluster it
    // grows for ever (a lab cluster with archive_timeout 60 s showed "4.2 h at risk": nothing had been written). The current LSN decides:
    //  - a COMPLETED segment not archived yet (backlog): it has waited since the last archive at least -> `since`
    //  - only the segment being written, and archive_timeout set: PostgreSQL switches it at most archive_timeout after its first write
    //    -> archive_timeout (the archiver is not failing: checked above)
    //  - only the segment being written, exactly at its start: nothing written since the switch -> nothing at risk
    //  - only the segment being written, no archive_timeout: its first write may be as old as the last archive -> `since` (open segment)
    // the precise bound only when the last archived segment is the one right before the current one ON THE SAME TIMELINE: a negative backlog
    // (a stale name from another branch) or a timeline switch falls back to the long bound (independent review: a hung archiver read as 'ok')
    const p0 = walPosition(pg, arch.last_archived_wal); const pos = p0 && p0.backlog === 0 && p0.sameTimeline ? p0 : null;
    const snapAge = primary?.lastSeen ? Math.max(0, (now - Date.parse(primary.lastSeen)) / 1000) : 0;   // the LSN is as old as the snapshot
    const bound = (pos && pos.backlog <= 0 ? (pos.offset === 0 ? Math.round(snapAge) : timeout ? Math.min(timeout, since) : since) : Math.max(since, timeout || 0)) + spoolAge;
    rpo = { seconds: Math.round(bound), state: bound <= Math.max(timeout, 60) * 2 ? 'ok' : bound <= 3600 ? 'warn' : 'bad', openSegment: !timeout && !(pos && pos.backlog <= 0 && pos.offset === 0),
      text: pos && pos.backlog <= 0 && pos.offset === 0 && !spoolAge ? `Nothing has been written since the last archived segment (archived ${dur(since)} ago): no transaction is waiting to be archived.` : `Last WAL segment archived ${dur(since)} ago.${spoolAge ? ` ${primary.snapshot.wal.spool.pending} segments are still waiting in the local spool.` : ''}${timeout ? ` archive_timeout (${timeout} s) bounds the wait.` : ' archive_timeout is not set: with little traffic the segment being written can wait a long time before it is archived.'}` };
    if (rpoTarget) {
      if (bound > rpoTarget) { rpo.state = 'bad'; rpo.text += ` Above the ${dur(rpoTarget)} objective${timeout > rpoTarget ? `: archive_timeout (${timeout} s) alone is above it; set archive_timeout = ${rpoTarget} s` : ''}.`; }
      else if (!timeout) { rpo.state = 'warn'; rpo.text += ` The ${dur(rpoTarget)} objective is not guaranteed: archive_timeout is not set, so a segment with little traffic can wait longer; set archive_timeout = ${rpoTarget} s.`; }
      else rpo.text += ` Within the ${dur(rpoTarget)} objective.`;
    }
  }
  const drills = (st.operations as any[]).filter(o => o.clusterId === clusterId && o.type === 'restore_drill' && o.status === 'succeeded' && Number(o.result?.rto_seconds) > 0).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const d = drills[drills.length - 1];
  let rto: { estimateSeconds: number | null; state: 'ok' | 'unknown' | 'stale' | 'bad'; text: string; drill: null | { at: string; seconds: number; bytes: number; mbs: number } };
  if (!d) rto = { estimateSeconds: null, state: 'unknown', text: `Never measured: run a disaster recovery drill to know how long a whole-cluster restore takes here${rtoTarget ? ` (the objective is ${dur(rtoTarget)})` : ''}.`, drill: null };
  else {
    const r = d.result; const bytes = Number(r.data_bytes) || 0; const secs = Number(r.rto_seconds);
    const est = bytes > 0 && sizeBytes > 0 ? Math.round(secs * Math.max(1, sizeBytes / bytes)) : Math.round(secs);
    const ageDays = (now - Date.parse(d.updatedAt)) / 86400_000;
    rto = { estimateSeconds: est, state: ageDays > 90 ? 'stale' : 'ok', drill: { at: d.updatedAt, seconds: secs, bytes, mbs: Number(r.throughput_mb_s) || 0 },
      text: `About ${dur(est)} for today's ${bytesH(sizeBytes)} (drill of ${d.updatedAt.slice(0, 10)}: ${dur(secs)} for ${bytesH(bytes)}${ageDays > 90 ? '; older than 90 days, run a new one' : ''}). Plus the WAL to replay up to the chosen point.` };
    if (rtoTarget) { if (est > rtoTarget) { rto.state = 'bad'; rto.text += ` Above the ${dur(rtoTarget)} objective.`; } else rto.text += ` Within the ${dur(rtoTarget)} objective.`; }
  }
  return { rpo, rto, sizeBytes, archiveTimeoutSec: timeout || null, targets: { rpoSeconds: rpoTarget || null, rtoSeconds: rtoTarget || null } };
}
