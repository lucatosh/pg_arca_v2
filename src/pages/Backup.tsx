import { BackupPlacement } from './Placement';
import { StrategyCard, useRecommended } from './Strategy';
import { RestartPg } from './RestartPg';
import { OffsiteCopy } from './AgentSettings';
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Confirm, CopyBlock, Empty, Field, Icon, Skeleton, bytes, dt, dur, ago, num, nof, setName } from '../ui';
import { Op, revalidate, toast, useOpRunner, useQuery, useDraft } from '../hooks';
import { OP_LABEL, OpPanel, Result } from './shared';

export const TYPE_LABEL: Record<string, string> = { full: 'Full', diff: 'Differential', incr: 'Incremental' };
export interface SetRow { id: string; type: 'full' | 'diff' | 'incr'; parent?: string; status: string; start_time?: string; stop_time?: string; duration_sec?: number; bytes_logical: number; bytes_written: number; reason?: string; timeline?: number }

/** Order sets as chains: newest full first, followed by the diffs / incrementals that depend on it. */
export function chains(sets: SetRow[]): { row: SetRow; depth: number }[] {
  const by = new Map(sets.map(s => [s.id, s]));
  const rootOf = (s: SetRow): string => { let c = s; const seen = new Set<string>(); while (c.parent && by.has(c.parent) && !seen.has(c.id)) { seen.add(c.id); c = by.get(c.parent)!; } return c.id; };
  const groups = new Map<string, SetRow[]>();
  for (const s of sets) { const r = rootOf(s); (groups.get(r) || groups.set(r, []).get(r)!).push(s); }
  const out: { row: SetRow; depth: number }[] = [];
  [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])).forEach(([r, list]) => {
    list.sort((a, b) => a.id.localeCompare(b.id)).forEach(s => out.push({ row: s, depth: s.id === r ? 0 : 1 }));
  });
  return out;
}

export interface Protection { kind: 'ok' | 'warn' | 'bad'; title: string; text: string }
export function protection(d: any): Protection {
  const bk = d.backup; const ar = d.archiver; const wal = d.wal; const pol = d.policy;
  if (d.archiveMode === 'off') return { kind: 'bad', title: 'WAL archiving is off', text: 'Without archived WAL you cannot restore to a point in time and backups are not consistent. Follow the instructions below.' };
  if (ar && ar.failed_count > 0 && ar.last_failed_time && (!ar.last_archived_time || ar.last_failed_time > ar.last_archived_time))
    return { kind: 'bad', title: 'WAL archiving is failing', text: `Last error on ${ar.last_failed_wal} (${ago(ar.last_failed_time)}). PostgreSQL’s disk keeps filling up until this is fixed.` };
  if (wal && wal.continuous === false) return { kind: 'bad', title: 'Gaps in the archived WAL', text: `${wal.gap_count || wal.gaps?.length} gaps: point-in-time recovery is not possible past the first gap. Take a new full backup.` };
  if (!bk?.sets) return { kind: 'warn', title: 'No valid backup', text: bk?.failed_sets ? 'There are only failed attempts: check the operation and try again.' : 'Take the first full backup.' };
  const maxH = pol?.enabled ? Math.max(pol.incrEveryHours || pol.fullEveryHours, 1) * 2 : 36;
  if (bk.last_backup_age_hours != null && bk.last_backup_age_hours > maxH) return { kind: 'warn', title: 'Last backup is old', text: `It dates from ${ago(bk.last_backup?.stop_time)}${pol?.enabled ? ', more than twice the scheduled interval' : ''}.` };
  if (!pol?.enabled) return { kind: 'warn', title: 'Backups succeed, but are not scheduled', text: 'Only manual backups run: schedule them so protection does not depend on someone remembering.' };
  return { kind: 'ok', title: 'Data protected', text: `Last backup ${ago(bk.last_backup?.stop_time)}, continuous WAL${wal?.last_segment ? ` up to ${wal.last_segment}` : ''}.` };
}

export function BackupTab({ c }: { c: any }) {
  const key = `/api/clusters/${encodeURIComponent(c.id)}/backups`;
  const agentic = c.source !== 'direct' && !c.isSandbox;
  const q = useQuery<any>(agentic ? key : null, { interval: 5000 });
  const rec = useRecommended(c, () => q.refresh());
  const reg = useQuery<{ nodes: any[] }>(agentic ? '/api/nodes' : null, { interval: 15000 });
  if (c.isSandbox) return <Banner kind="info" title="Not available on the demo cluster">Connect a real cluster with the agent to run backups.</Banner>;
  if (c.source === 'direct') return <Card><Empty icon="shield" title="The agent is required">Backup and restore run on the database server. Install the agent on a node of this cluster: the console cannot read data files through a plain SQL connection.</Empty></Card>;
  if (q.loading || !q.data) return <div className="stack"><Skeleton h={60} /><Skeleton h={200} /></div>;
  const d = q.data;
  if (!d.agent) return <Card><Empty icon="shield" title="No agent on this cluster">Connect a node from the Nodes tab.</Empty></Card>;
  const v = protection(d); const sets: SetRow[] = d.backup?.recent_sets || [];
  const done = sets.filter(s => s.status === 'COMPLETE');
  return <div className="stack-l">
    {/* one banner, with the way out on it: "not scheduled" carries the button that schedules (a review found the problem said twice and the fix hidden behind a small gear) */}
    <Banner kind={v.kind} title={v.title} actions={!d.policy?.enabled || d.policySource?.scope === 'none' ? (rec.sug && !d.policySource?.disabled ? <Button sm kind="primary" icon="shield" busy={rec.busy} onClick={rec.assign}>Schedule with “{rec.sug.name}” (recommended)</Button> : null) : undefined}>{v.text}</Banner>
    {d.archiveMode === 'off' ? <ArchiveSetup c={c} refresh={q.refresh} /> : null}
    <RunCard c={c} hasFull={done.some(s => s.type === 'full')} running={d.running || []} refresh={q.refresh} />
    <div className="grid g2"><StrategyCard c={c} policy={d.policySource?.scope === 'none' || d.policySource?.disabled ? null : d.policy} source={d.policySource} onSaved={q.refresh} /><HealthCard c={c} d={d} refresh={q.refresh} /></div>
    <SetsCard sets={sets} d={d} />
    {(() => { const ns = (reg.data?.nodes || []).filter((n: any) => n.clusterId === c.id && n.kind !== 'worker'); return ns.length ? <OffsiteCopy clusterId={c.id} nodes={ns.map((n: any) => ({ id: n.id, name: n.name, online: n.online }))} /> : null; })()}
  </div>;
}

function ArchiveSetup({ c, refresh }: { c: any; refresh: () => void }) {
  const r = useOpRunner(c.id, refresh, `archive:${c.id}`); const [ask, setAsk] = useState(false); const [manual, setManual] = useDraft(`archive:${c.id}:manual`, false);
  const res = r.op?.status === 'succeeded' ? r.op.result : null;
  return <Card title="Enable WAL archiving"><div className="stack">
    <p>Needed for point-in-time recovery (PITR) and consistent backups. The agent sets <code>archive_mode</code>, <code>archive_command</code> and, if needed, <code>wal_level</code> and <code>wal_log_hints</code>{c.haState?.managedByPatroni ? ' through the Patroni configuration (all members)' : ' with ALTER SYSTEM'}. The restart is never done automatically: you start it, from here or however you prefer.</p>
    <div className="row wrap"><Button kind="primary" icon="play" busy={r.busy} onClick={() => setAsk(true)}>Enable WAL archiving</Button><Button sm onClick={() => setManual(m => !m)}>{manual ? 'Hide' : 'I prefer to do it by hand'}</Button></div>
    {(r.op || r.error) ? <OpPanel op={r.op} error={r.error} cancel={r.cancel} label="Enabling WAL archiving" /> : null}
    {res ? <Banner kind={res.restart_required ? 'warn' : 'ok'} title={res.already_enabled ? 'Already enabled' : res.restart_required ? 'Settings saved: a restart is needed' : 'Archiving enabled'}>{res.already_enabled ? 'No change needed.' : !res.restart_required ? 'Applied with a reload: archiving is active.' : c.haState?.managedByPatroni ? 'The settings are in the Patroni DCS: restart every member (replicas first, then the leader) from the High availability tab → Restart.' : 'archive_mode and wal_level take effect only after a PostgreSQL restart.'}{!c.haState?.managedByPatroni && res.restart_required ? <div style={{ marginTop: 8 }}><RestartPg c={c} label="Restart now" onDone={refresh} /></div> : null}</Banner> : null}
    {manual ? <><p className="small muted">Add to <code>postgresql.conf</code> on the primary and restart PostgreSQL:</p>
      <CopyBlock text={`wal_level = replica\narchive_mode = on\narchive_command = '/usr/local/bin/pg-arca-wal archive %p %f'\nfull_page_writes = on`} />
      <p className="small muted">The path <code>/usr/local/bin/pg-arca-wal</code> is the one of the standard installation: check with <code>command -v pg-arca-wal</code> where it is on your nodes (it must be the same on all of them); if the agent does not use <code>/etc/pg-arca/agent.conf</code>, prefix <code>env PG_ARCA_CONF=/path/agent.conf</code>. “Enable WAL archiving” above builds the right command by itself. With Patroni, apply the same settings with <code>patronictl edit-config</code>. Incremental backups also need <code>data_checksums</code> or <code>wal_log_hints = on</code>.</p></> : null}
    {ask ? <Confirm title="Enable WAL archiving?" confirmLabel="Enable" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); r.run('archive_enable', {}); }}>
      <p>The PostgreSQL parameters listed above will be changed. If another archiving tool is already configured, the operation stops without touching it. A restart is needed afterwards.</p></Confirm> : null}
  </div></Card>;
}

function RunCard({ c, hasFull, running, refresh }: { c: any; hasFull: boolean; running: Op[]; refresh: () => void }) {
  const [type, setType] = useDraft<'full' | 'diff' | 'incr'>(`backup:${c.id}:type`, hasFull ? 'incr' : 'full'); const [fast, setFast] = useDraft(`backup:${c.id}:fast`, true); const [from, setFrom] = useDraft(`backup:${c.id}:from`, ''); const reg = useQuery<{ nodes: any[] }>('/api/nodes', { interval: 10000 }); const mine = (reg.data?.nodes || []).filter(n => n.clusterId === c.id && n.online);
  // a backup from a replica waits for the segments the PRIMARY archives: with a local (not shared) archive on each node they never arrive. Say it before starting.
  const dest = useQuery<any>(`/api/clusters/${encodeURIComponent(c.id)}/destination`).data;
  const fromNode = mine.find(n => n.id === from); const fromReplica = !!fromNode && /replica|standby|secondary/i.test(String(fromNode.role || ''));
  const walShared = dest?.destination ? dest.destination.type !== 'local' : false;
  const walPaths = new Set((dest?.nodes || []).map((n: any) => n.wal_path).filter(Boolean)); const sameWalPath = walPaths.size === 1 && (dest?.nodes || []).length > 1;
  useEffect(() => { if (!hasFull) setType('full'); }, [hasFull]);
  const r = useOpRunner(c.id, () => { refresh(); revalidate(`/api/operations?clusterId=${encodeURIComponent(c.id)}`); }, `backup:${c.id}:run`);
  const other = running.filter(o => o.id !== r.op?.id && o.type !== 'backup_info');
  const cancelOther = async (id: string) => { try { await api('POST', `/api/operations/${id}/cancel`); refresh(); } catch (e: any) { toast(e.message, 'bad'); } };
  const active = r.busy || other.length > 0;
  const hint = { full: 'Copies everything. The starting point of every chain.', diff: 'Only what changed since the last full backup.', incr: 'Only the pages changed since the last backup: fast and small.' }[type];
  return <Card title="Run a backup">
    <div className="stack">
      <div className="row wrap"><div className="seg" role="group" aria-label="Backup type">{(['full', 'diff', 'incr'] as const).map(t => <button key={t} aria-pressed={type === t} disabled={active || (t !== 'full' && !hasFull)} onClick={() => { setType(t); r.reset(); }}>{TYPE_LABEL[t]}</button>)}</div>
        <Button kind="primary" icon="play" busy={r.busy} disabled={active} onClick={() => r.run('backup_run', { type, start_fast: fast }, { nodeId: from || undefined })}>Start backup</Button><span className="small muted">{hint}</span></div>
      {fromReplica && !walShared && !sameWalPath ? <Banner kind="warn" title="This replica may not see the WAL the primary archives">The backup waits for the segments the primary archives. The cluster has no shared destination (NFS/SMB) configured, so each node most likely writes to its own local directory: the wait would fail within a minute. Run the backup from the primary, or set one shared archive for every node in Storage &amp; recovery → Backup destination.</Banner> : null}
      {mine.length > 1 ? <label className="row small" style={{ gap: 8 }}>Run from <select className="input" style={{ width: 'auto' }} value={from} onChange={e => setFrom(e.target.value)}><option value="">automatic (primary)</option>{mine.map(n => <option key={n.id} value={n.id}>{n.name}{n.role ? ` — ${n.role}` : ''}</option>)}</select><span className="muted">— from a replica the primary carries no load; the console asks it to switch the WAL segment by itself.</span></label> : null}
      <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={fast} onChange={e => setFast(e.target.checked)} /> Immediate checkpoint <span className="muted">— the backup starts right away; when off, PostgreSQL spreads the checkpoint and the start can take a few minutes (less I/O).</span></label>
      {!hasFull ? <p className="small muted">The first backup must be a full backup.</p> : null}
      {(r.op || r.error) ? <><OpPanel op={r.op} error={r.error} cancel={r.cancel} />{r.op?.status === 'succeeded' ? <Banner kind="ok" title={`${setName(r.op.result?.set)} completed`}>{bytes(r.op.result?.bytes_logical)} read, {bytes(r.op.result?.bytes_written)} written to the repository in {dur(r.op.result?.duration_sec)}{r.op.result?.chunks_dedup ? `; ${num(r.op.result.chunks_dedup)} chunks already present (deduplication)` : ''}.</Banner> : null}</> : null}
      {other.map(o => <div key={o.id} className="stack"><OpPanel op={o} cancel={() => cancelOther(o.id)} /></div>)}
    </div></Card>;
}

/** Divergent WAL copies the archive refused and kept aside: what they are, and 'reviewed' once a person has looked (they stay in conflicts/reviewed/). */
function WalConflicts({ c, count, offHistory = 0, refresh }: { c: any; count: number; offHistory?: number; refresh: () => void }) {
  const ls = useOpRunner(c.id, undefined, `walconf:${c.id}`); const ack = useOpRunner(c.id, () => { refresh(); ls.run('wal_conflicts', {}); }); const [ask, setAsk] = useState(false);
  const list: any[] = ls.op?.status === 'succeeded' ? ls.op.result.conflicts || [] : [];
  const ret = useOpRunner(c.id, () => { refresh(); ls.run('wal_conflicts', {}); }); const [retire, setRetire] = useState<number | null>(null);
  // only a copy on the shared history makes a timeline a candidate for "retire the dead branch"; the leftovers of a failover never do
  const tls = [...new Set(list.filter(x => x.kind !== 'off_history').map(x => x.timeline).filter((t: any) => Number.isInteger(t)))] as number[];
  const primaryTl = c.activeTimeline || c.haState?.activeTimeline;
  return <Banner kind={count ? 'bad' : 'info'} title={count ? `${count} ${count === 1 ? 'divergent WAL copy' : 'divergent WAL copies'} in quarantine${offHistory ? ` (and ${offHistory} left behind by a failover)` : ''}` : `${nof(offHistory, 'WAL copy', 'WAL copies')} left behind by a failover, kept in quarantine`}>
    {count ? <p className="small">Two servers archived different content under the same name for a part of the history that recovery reads: the archive kept the first copy and set the others aside. This happens with two primaries at once or with two promotions to the same timeline number (split-brain between sites).</p> : null}
    {offHistory ? <p className="small">{count ? 'The others are' : 'These are'} copies that recovery along the current timeline never reads: the old primary’s tail of a timeline it left at a failover, or partial segments. They are harmless and kept; file them away once seen.</p> : null}
    {list.length ? <div className="tablewrap"><table className="t small"><thead><tr><th>Segment / history</th><th>Needed by the current history?</th><th>Copy set aside</th><th>When</th></tr></thead><tbody>
      {[...list].sort((a, b) => (a.kind === 'off_history' ? 1 : 0) - (b.kind === 'off_history' ? 1 : 0)).map(x => <tr key={x.file}><td className="mono">{x.name}</td><td>{x.kind === 'off_history' ? <Badge title={x.why}>No: failover leftover</Badge> : <Badge kind="bad" title={x.kind ? undefined : 'An agent older than this console does not classify the copies'}>{x.kind ? 'Yes: divergent' : 'Not classified'}</Badge>}</td><td className="mono">{x.file}</td><td>{ago(new Date(x.at * 1000).toISOString())}</td></tr>)}</tbody></table></div> : null}
    {tls.length ? <p className="small" style={{ marginTop: 6 }}>If the current primary{primaryTl ? ` (timeline ${primaryTl})` : ''} is the right server, retire the dead branch: the archive’s copies of that timeline that differ from the primary’s are set aside in <code>conflicts/dead-branch-…/</code> (nothing is deleted), the primary’s copies take their place and WAL archiving resumes by itself.</p> : null}
    <div className="row wrap gap-s" style={{ marginTop: 6 }}>{!list.length ? <Button sm busy={ls.busy} onClick={() => ls.run('wal_conflicts', {})}>Show the copies</Button> : null}
      {tls.map(t => <Button key={t} sm kind="danger" busy={ret.busy} onClick={() => setRetire(t)}>Retire the dead branch of timeline {t}</Button>)}
      {offHistory ? <Button sm kind={count ? undefined : 'primary'} busy={ack.busy} onClick={() => ack.run('wal_conflicts', { reviewed: true, kind: 'off_history' })}>File away the failover leftovers</Button> : null}
      {count ? <Button sm busy={ack.busy} onClick={() => setAsk(true)}>Mark all as reviewed</Button> : null}</div>
    {ret.op?.status === 'succeeded' ? <Banner kind="ok" title={`Timeline ${ret.op.result?.timeline}: ${nof((ret.op.result?.retired || []).length, 'object')} set aside, ${(ret.op.result?.promoted || []).length} promoted`}>{ret.op.result?.verified_against_primary ? 'Each promoted copy was byte-identical to the primary’s own WAL file.' : 'Run on a node that is not the primary: the newest quarantined copy was promoted without a byte-level proof.'}{(ret.op.result?.skipped || []).length ? ` Skipped: ${ret.op.result.skipped.map((x: any) => `${x.name} (${x.why})`).join('; ')}` : ''}</Banner> : null}
    {(ls.op?.status === 'failed' || ack.op?.status === 'failed' || ret.op?.status === 'failed') ? <OpPanel op={ls.op?.status === 'failed' ? ls.op : ack.op?.status === 'failed' ? ack.op : ret.op} /> : null}
    {retire !== null ? <Confirm title={`Retire the dead branch of timeline ${retire}?`} confirmLabel="Retire" danger requireText="RETIRE" onClose={() => setRetire(null)} onConfirm={() => { const t = retire; setRetire(null); ret.run('wal_retire_branch', { timeline: t, confirm: 'RETIRE' }); }}>
      <p>Only do this if the <strong>current primary</strong> is the server whose history must survive. Its refused copies (in quarantine) replace the stored ones that differ; the stored ones are kept in <code>conflicts/dead-branch-{String(retire).padStart(8, '0').toUpperCase()}/</code>. Objects both servers wrote identically stay as they are.</p>
      {primaryTl && primaryTl < retire ? <Banner kind="warn" title={`The primary is on timeline ${primaryTl}, older than ${retire}`}>Retiring a branch newer than the primary’s own timeline means the other server went further: make sure this is really the server to keep.</Banner> : null}</Confirm> : null}
    {ask ? <Confirm title="Mark the copies as reviewed?" confirmLabel="Mark" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); ack.run('wal_conflicts', { reviewed: true }); }}>
      <p>The copies stay in <code>conflicts/reviewed/</code> in the archive; the warning goes away. Do this after verifying which server was the right primary.</p></Confirm> : null}
  </Banner>;
}

function HealthCard({ c, d, refresh }: { c: any; d: any; refresh: () => void }) {
  const r = useOpRunner(c.id, refresh, `backup:${c.id}:health`); const [kind, setKind] = useDraft(`backup:${c.id}:health:kind`, '');
  const [ask, setAsk] = useState(false);
  const run = (k: string, type: string, params: any) => { setKind(k); r.run(type, params); };
  const bk = d.backup; const res = r.op?.result;
  return <Card title="Backup storage">
    <div className="stack">
      {c.source !== 'direct' && !c.isSandbox ? <BackupPlacement clusterId={c.id} /> : null}
      {c.source !== 'direct' && !c.isSandbox ? <Objectives clusterId={c.id} /> : null}
      <dl className="kv small"><dt>Valid backups</dt><dd>{bk?.sets ?? 0}{bk?.failed_sets ? ` (+${bk.failed_sets} failed)` : ''}</dd><dt>Space used</dt><dd>{bytes(bk?.stored_bytes)} {bk?.dedup_ratio ? <span className="muted">— {bk.dedup_ratio}× from deduplication and compression</span> : null}</dd>
        <dt>Archived WAL</dt><dd>{num(d.wal?.total_segments)} segments, {d.wal?.continuous === false ? <Badge kind="bad">with gaps</Badge> : <Badge kind="ok">continuous</Badge>}</dd>
        <dt>Encryption</dt><dd>{bk?.encryption ? <><Badge kind="ok">On</Badge> <span className="muted">AES-256-GCM · key {bk.encryption.key_id.slice(0, 8)}</span></> : <span className="muted" title="Backups are encrypted when the repository is created with encryption_key_file set in the agent configuration">Off</span>}</dd>
        <dt>Archiver</dt><dd>{d.archiver ? `${num(d.archiver.archived_count)} ok, ${num(d.archiver.failed_count)} errors` : '—'}</dd></dl>
      {d.wal?.conflicts > 0 || d.wal?.conflicts_off_history > 0 ? <WalConflicts c={c} count={d.wal.conflicts || 0} offHistory={d.wal.conflicts_off_history || 0} refresh={refresh} /> : null}
      <div className="row wrap"><Button sm disabled={r.busy} onClick={() => run('verify', 'backup_verify', {})}>Quick verify</Button><Button sm disabled={r.busy} onClick={() => run('deep', 'backup_verify', { deep: true })}>Deep verify</Button>
        <Button sm disabled={r.busy || !bk?.sets} onClick={() => run('test', 'backup_verify', { restore_test: true })} title="Actually restores the latest backup into a temporary instance">Test restore</Button>
        <Button sm disabled={r.busy || !bk?.sets} onClick={() => run('drill', 'restore_drill', {})} title="Restores the whole cluster into a temporary directory, starts it, checks every database and measures the time">Disaster recovery drill</Button>
        <Button sm disabled={r.busy || !bk?.sets} onClick={() => run('dry', 'backup_expire', { dry_run: true, retention_full: d.policy.retentionFull })}>Preview cleanup</Button></div>
      {(r.op || r.error) ? <><OpPanel op={r.op} error={r.error} cancel={r.cancel} label={kind === 'drill' ? 'Disaster recovery drill' : kind === 'test' ? 'Test restore' : kind === 'dry' ? 'Preview cleanup' : kind === 'deep' ? 'Deep verify' : 'Verify'} />
        {r.op?.status === 'succeeded' && kind === 'drill' ? <Banner kind="ok" title={`Cluster restored in ${res.rto_seconds >= 120 ? Math.round(res.rto_seconds / 60) + ' minutes' : Math.round(res.rto_seconds) + ' seconds'}`}>{bytes(res.data_bytes)} at {res.throughput_mb_s} MB/s; {(res.databases_checked || []).length} databases checked. This time was measured on this server with this data volume: use it as a reference for your recovery time objective (RTO).</Banner> : null}
        {r.op?.status === 'succeeded' && kind !== 'dry' && kind !== 'drill' ? (res?.ok ? <Banner kind="ok" title="Repository intact">{res.chunks_checked ? `${num(res.chunks_checked)} chunks checked.` : 'Structural checks passed.'}{res.restore_test ? ' The latest backup was actually restored and PostgreSQL completed recovery.' : ''}</Banner> : <Banner kind="bad" title="Problems found"><ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{(res?.problems || []).slice(0, 8).map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></Banner>) : null}
        {r.op?.status === 'succeeded' && kind === 'dry' ? <><Banner kind={res.delete_sets?.length ? 'warn' : 'ok'} title={res.delete_sets?.length ? `The cleanup would delete ${res.delete_sets.length} backups` : 'Nothing to delete'}>{res.delete_sets?.length ? res.delete_sets.join(', ') : `You are already within the ${res.retention_full} retained chains.`}</Banner>
          {res.delete_sets?.length ? <div><Button kind="danger" sm onClick={() => setAsk(true)}>Delete now…</Button></div> : null}</> : null}
        {kind === 'expire' && r.op?.status === 'succeeded' ? <Banner kind="ok" title="Cleanup completed">{bytes(res.bytes_freed)} freed, {num(res.wal_removed)} WAL segments removed.</Banner> : null}</> : null}
    </div>
    {ask ? <Confirm danger title="Delete the expired backups?" confirmLabel="Delete" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); run('expire', 'backup_expire', { retention_full: d.policy.retentionFull }); }}>
      <p>The listed backups and the WAL no longer needed will be deleted from the repository. This cannot be undone.</p></Confirm> : null}
  </Card>;
}

function SetsCard({ sets, d }: { sets: SetRow[]; d: any }) {
  const rows = useMemo(() => chains(sets), [sets]);
  if (!sets.length) return <Card title="Backup"><Empty icon="shield" title="No backups yet">The first full backup creates the starting point for every restore.</Empty></Card>;
  return <Card title="Backups in the repository" pad={false}><div className="tablewrap"><table className="t sets"><thead><tr><th>Backup</th><th>Type</th><th>Status</th><th>Started</th><th className="num">Duration</th><th className="num">Data</th><th className="num">Written</th></tr></thead><tbody>
    {rows.map(({ row: s, depth }) => <tr key={s.id} className={depth ? 'd1' : 'chainrow'}>
      <td title={s.id}><span className="nowrap">{dt(s.start_time)}</span><div className="mono faint" style={{ fontSize: 11 }}>{s.id}</div></td><td>{TYPE_LABEL[s.type]}</td>
      <td>{s.status === 'COMPLETE' ? <Badge kind="ok">Valid</Badge> : s.status === 'FAILED' || s.status === 'UNRECOVERABLE' ? <Badge kind="bad" title={s.reason}>{s.status === 'FAILED' ? 'Failed' : 'Unrecoverable'}</Badge> : <Badge kind="info">{s.status === 'PENDING_WAL' ? 'Waiting for WAL' : s.status === 'EXPIRING' ? 'Being deleted' : 'Running'}</Badge>}</td>
      <td>{ago(s.start_time)}</td><td className="num">{dur(s.duration_sec)}</td><td className="num">{bytes(s.bytes_logical)}</td><td className="num">{bytes(s.bytes_written)}</td></tr>)}
  </tbody></table></div></Card>;
}

/** What would be lost right now (RPO) and how long a whole-cluster restore would take (RTO): the two numbers an auditor asks first. */
function Objectives({ clusterId }: { clusterId: string }) {
  const q = useQuery<{ rpo: { seconds: number | null; state: string; text: string; openSegment?: boolean }; rto: { estimateSeconds: number | null; state: string; text: string; drill: any }; targets?: { rpoSeconds: number | null; rtoSeconds: number | null } }>(`/api/clusters/${encodeURIComponent(clusterId)}/objectives`, { interval: 30000 });
  const o = q.data; if (!o) return null;
  const badge = (st: string) => st === 'ok' ? <Badge kind="ok">OK</Badge> : st === 'bad' ? <Badge kind="bad">At risk</Badge> : st === 'warn' || st === 'stale' ? <Badge kind="warn">{st === 'stale' ? 'Outdated' : 'Check'}</Badge> : <Badge>Unknown</Badge>;
  const dur = (s: number | null) => s == null ? '—' : s >= 7200 ? `${(s / 3600).toFixed(1).replace(/\.0$/, '')} h` : s >= 120 ? `${Math.round(s / 60)} min` : s < 1 ? 'under 1 s' : `${s} s`;
  return <div className="objectives" data-testid="objectives"><dl className="kv small">
    {/* the answer first (how much data, how long), the explanation on its own line below: a review found the value lost in one long sentence */}
    <dt title="Recovery point objective: the transactions that would be lost if the server were lost now">Data at risk (RPO)</dt><dd><strong>{o.rpo.seconds == null ? (o.rpo.state === 'bad' ? 'unbounded' : '—') : o.rpo.seconds < 1 ? 'under 1 s' : `up to ${dur(o.rpo.seconds)}`}</strong>{o.targets?.rpoSeconds ? <span className="muted"> / objective {dur(o.targets.rpoSeconds)}</span> : null} {badge(o.rpo.state)}<span className="muted small" style={{ display: 'block' }}>{o.rpo.text}</span></dd>
    <dt title="Recovery time objective: how long restoring the whole cluster takes">Time to restore all (RTO)</dt><dd><strong>{o.rto.estimateSeconds == null ? 'not measured' : `≈ ${dur(o.rto.estimateSeconds)}`}</strong>{o.targets?.rtoSeconds ? <span className="muted"> / objective {dur(o.targets.rtoSeconds)}</span> : null} {badge(o.rto.state)}<span className="muted small" style={{ display: 'block' }}>{o.rto.text}</span></dd>
  </dl></div>;
}
