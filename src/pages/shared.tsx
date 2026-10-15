import React, { useEffect, useState } from 'react';
import { Op, isTerminal, useQuery } from '../hooks';
import { openOpLog } from '../OpLog';
import { Badge, Banner, Button, CopyBlock, Progress, ago, bytes, dur, num } from '../ui';
import { itCheck } from '../i18n';
import { go } from '../router';

export const OP_LABEL: Record<string, string> = {
  pg_reload: 'Configuration reload', pg_timeline: 'Read the timeline', wal_conflicts: 'Divergent WAL copies', hba_restore: 'pg_hba restore of an earlier list', wal_switch: 'WAL segment switch', wal_retire_branch: 'Dead WAL branch retirement', checkpoint: 'Checkpoint', discovery_scan: 'Discovery', compat_check: 'PostgreSQL compatibility check', agent_config_get: 'Read agent settings', agent_config_set: 'Agent settings', offsite_get: 'Read offsite settings', offsite_set: 'Offsite copy settings', offsite_sync: 'Offsite copy sync', offsite_rehydrate: 'Download from the offsite copy', list_objects: 'Object list',
  pg_set_param: 'Parameter change', patroni_switchover: 'Switchover', patroni_failover: 'Failover', patroni_restart: 'Member restart', patroni_reinit: 'Replica reinitialization', archive_enable: 'Enable WAL archiving', patroni_reload: 'Patroni reload',
  patroni_pause: 'Maintenance mode', patroni_config_patch: 'Patroni configuration change', backup_run: 'Backup', backup_info: 'Backup storage info', backup_verify: 'Backup verification',
  backup_expire: 'Retention cleanup', backup_catalog: 'Backup catalog', restore_plan: 'Restore plan', restore_instance: 'Restore server', restore_database: 'Restore database',
  restore_object: 'Restore tables', wal_forensics: 'WAL analysis', hba_read: 'Read pg_hba', hba_plan: 'pg_hba check', hba_apply: 'pg_hba change', hba_rollback: 'pg_hba rollback', restore_promote: 'Put back into the database', restore_drill: 'Disaster recovery drill', restore_diff: 'Row-by-row comparison', restore_apply_rows: 'Put rows back', hba_expire: 'pg_hba rule expiry',
  ephemeral_preflight: 'Recovery host check', ephemeral_install: 'PostgreSQL binaries installation', destination_check: 'Backup destination check', destination_migrate: 'Backup migration', destination_drop_old: 'Removal of the previous location', pg_restart: 'PostgreSQL restart', restore_db_swap: 'Put the restored database in place', geo_failover: 'Standby site promotion (disaster recovery)', geo_promote: 'Site promotion', geo_demote: 'Site demotion to standby', geo_archive_fallback: 'Fallback to the standby site’s WAL archive', restored_stop: 'Stop the restored copy', restored_start: 'Start the restored copy', restored_resume: 'Finish the copy’s recovery', restored_keep: 'Restored copy lifetime', restored_drop: 'Delete the restored copy', restored_list: 'Restored copies', restore_kept_drop: 'Delete kept data', restore_kept_list: 'Data kept from replacements',
};
export const STATUS_LABEL: Record<string, string> = { sending: 'Sending…', queued: 'Queued', leased: 'Assigned', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', expired: 'Expired', cancelled: 'Cancelled' };
export const statusBadge = (s: string) => <Badge kind={s === 'succeeded' ? 'ok' : s === 'failed' ? 'bad' : s === 'running' || s === 'leased' ? 'info' : undefined}>{STATUS_LABEL[s] || s}</Badge>;
export const PHASE: Record<string, string> = { catalog: 'Reading the catalog', checkpoint: 'PostgreSQL checkpoint', summaries: 'Reading WAL summaries (changed blocks)', copy: 'Copying data', offsite: 'Uploading to the offsite copy', rehydrate: 'Downloading from the offsite copy', finalize: 'Finalizing the backup', wal: 'Waiting for WAL archiving', extract: 'Extracting files', starting: 'Starting the temporary instance', recovery: 'WAL replay', transfer: 'Transferring data', verify: 'Verifying chunks', 'restore-test': 'Test restore', scan: 'Scanning WAL', chunks: 'Copying chunks', sets: 'Copying backups', done: 'Final check', wal_flush: 'Archiving the latest WAL', prepare: 'Preparing', swap: 'Swapping' };

/** Throughput and time left of the current phase, measured in the browser between progress samples (same operation, same phase). */
const samples = new Map<string, { t: number; v: number; phase: string }>();
function rateOf(op: Op): string | null {
  const p = op.progress; if (!p || isTerminal(op.status)) return null;
  const [v, total, unit] = p.bytes_total ? [p.bytes || 0, p.bytes_total, 'B'] : p.segments_total ? [p.segments || 0, p.segments_total, 'seg'] : p.files_total ? [p.files || 0, p.files_total, 'f'] : [null, null, ''];
  if (v == null || !total) return null;
  const now = Date.now(); const k = op.id; const s0 = samples.get(k);
  if (!s0 || s0.phase !== p.phase || v < s0.v) { samples.set(k, { t: now, v, phase: p.phase }); return null; }
  const dt = (now - s0.t) / 1000; if (dt < 4 || v === s0.v) return null;
  const r = (v - s0.v) / dt; const left = (total - v) / r;
  const eta = left < 90 ? `${Math.max(1, Math.round(left))} s` : left < 5400 ? `${Math.round(left / 60)} min` : `${(left / 3600).toFixed(1)} h`;
  const rate = unit === 'B' ? `${bytes(r)}/s` : unit === 'seg' ? `${r.toFixed(1)} segments/s` : `${r.toFixed(0)} file/s`;
  return `${rate} · phase ends in about ${eta}`;
}

export function pctOf(p: any): number | null {
  if (!p) return null;
  if (p.bytes_total) return Math.round((p.bytes / p.bytes_total) * 100);
  if (p.files_total) return Math.round((p.files / p.files_total) * 100);
  if (p.segments_total) return Math.round(((p.segments || 0) / p.segments_total) * 100);
  return null;
}

const secs = (from: string | number, now: number) => Math.max(0, Math.round((now - (typeof from === 'number' ? from : Date.parse(from))) / 1000));
const elapsed = (s: number) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim() : `${(s / 3600).toFixed(1)} h`);
const sinceStatus = (op: Op, st: string) => [...(op.history || [])].reverse().find(h => h.status === st)?.at;
function useTick(on: boolean) { const [n, setN] = useState(Date.now()); useEffect(() => { if (!on) return; const t = setInterval(() => setN(Date.now()), 1000); return () => clearInterval(t); }, [on]); return n; }

/** Where the operation is, in the same four steps for every operation of the product: sent to the console → taken by the agent → running → outcome. */
function Steps({ op }: { op: Op }) {
  const order = ['sending', 'queued', 'leased', 'running'];
  const at = op.status === 'sending' ? 0 : op.status === 'queued' ? 1 : op.status === 'leased' ? 2 : op.status === 'running' ? 3 : 4;
  const failedAt = op.status === 'failed' || op.status === 'cancelled' || op.status === 'expired' ? (sinceStatus(op, 'running') ? 3 : sinceStatus(op, 'leased') ? 2 : 1) : -1;
  const labels = ['Sent to the console', 'Picked up by the agent', 'Running', op.status === 'succeeded' ? 'Succeeded' : op.status === 'failed' ? 'Failed' : op.status === 'cancelled' ? 'Cancelled' : op.status === 'expired' ? 'Expired' : 'Outcome'];
  return <ol className="opsteps" aria-label="Progress">{labels.map((l, i) => {
    const cls = failedAt >= 0 && i === 3 ? 'bad' : failedAt >= 0 && i > failedAt ? 'skip' : i < at || (i === 3 && op.status === 'succeeded') ? 'done' : i === at && order[i] ? 'now' : '';
    return <li key={i} className={cls}>{l}</li>;
  })}</ol>;
}

/** Live view of one operation: steps, phase, progress, elapsed time, who is executing it, cancel, and on failure where and why. Result rendering is up to the caller. */
export function OpPanel({ op, error, cancel, label }: { op: Op | null; error?: string | null; cancel?: () => void; label?: string }) {
  const live = !!op && !isTerminal(op.status);
  const now = useTick(live);
  const nodes = useQuery<{ nodes: any[] }>(op?.nodeId && (op.status === 'queued' || op.status === 'failed' || op.status === 'expired') ? '/api/nodes' : null, { interval: op?.status === 'queued' ? 5000 : 0 });
  if (!op && !error) return null;
  if (!op) return <Banner kind="bad" title={/not responding/.test(error || '') ? 'The console is not responding: operation not sent' : 'Operation not started'}>{itCheck(error)}{hintFor(error) ? <p className="small" style={{ marginTop: 8 }}>{hintFor(error)}</p> : null}</Banner>;
  const done = isTerminal(op.status); const p = op.progress; const pct = pctOf(p);
  const speed = rateOf(op);
  const node = (nodes.data?.nodes || []).find(n => n.id === op.nodeId);
  const runningSince = sinceStatus(op, 'running') || sinceStatus(op, 'leased');
  const phase = p?.phase ? PHASE[p.phase] || p.phase : '';
  let what: React.ReactNode;
  if (op.status === 'sending') { const s = secs(op.createdAt, now); what = s < 6 ? 'Sending the request to the console…' : `The console has not answered yet (${elapsed(s)}): retrying automatically. If the request already got through, it will not run twice.`; }
  else if (op.status === 'queued') {
    const s = secs(op.createdAt, now);
    what = node && !node.online ? <>The agent on <strong>{node.name}</strong> has not checked in for {ago(node.lastSeen, now).replace(/ ago$/, '')}: the operation starts when it comes back online (or expires without doing anything).</>
      : s < 8 ? `Waiting for the agent${node ? ` on ${node.name}` : ''} to pick it up…`
      : <>Queued for {elapsed(s)}{node ? <> on the agent of <strong>{node.name}</strong></> : null}: the agent runs data operations one at a time, so this one starts as soon as the current one ends (see “Activity”).</>;
  }
  else if (op.status === 'leased') what = 'The agent picked it up and is starting…';
  else if (!done) what = <>{phase || 'In progress…'}{runningSince ? ` — for ${elapsed(secs(runningSince, now))}` : ''}
    {p?.phase === 'checkpoint' ? `${p.fast ? '' : ' (spread checkpoint: on a busy server it can take a few minutes; cancelling interrupts it)'}` : ''}{p?.files_total ? ` — ${num(p.files)} / ${num(p.files_total)} file` : ''}{p?.bytes_total ? `, ${bytes(p.bytes)} / ${bytes(p.bytes_total)}` : ''}{p?.chunks ? ` — ${num(p.chunks)}${p.chunks_total ? ` / ${num(p.chunks_total)}` : ''} chunks verified` : ''}{p?.segments_total ? ` — ${num(p.segments)} / ${num(p.segments_total)} segments` : ''}{p?.msg ? ` — ${p.msg}` : ''}</>;
  const total = done && op.createdAt ? secs(op.createdAt, Date.parse(op.updatedAt)) : null;
  return <div className="stack oppanel">
    <div className="row wrap"><strong>{label || OP_LABEL[op.type] || op.type}</strong>{statusBadge(op.status)}
      {op.cancelRequested && !done ? <Badge kind="warn">Cancellation requested…</Badge> : null}
      <div className="grow" />
      {op.id ? <Button sm kind="ghost" icon="logs" onClick={() => openOpLog(op.id, label || OP_LABEL[op.type])}>Log</Button> : null}
      {!done && cancel && op.id && !op.cancelRequested ? <Button sm kind="danger" icon="stop" onClick={cancel}>Cancel</Button> : null}</div>
    <Steps op={op} />
    {!done ? <>
      {op.status === 'running' ? <Progress pct={pct} /> : null}{speed ? <div className="small faint">{speed}</div> : null}
      <div className="small muted" aria-live="polite">{what}</div></> : null}
    {op.status === 'failed' ? <Banner kind="bad" title={`Failed${p?.phase ? ` during “${phase}”` : ''}${node ? ` on ${node.name}` : ''}${total != null ? ` after ${elapsed(total)}` : ''}`}>
      <span style={{ whiteSpace: 'pre-wrap' }}>{itCheck(op.error || error)}</span>{hintFor(op.error || error) ? <p className="small" style={{ marginTop: 8 }}>{hintFor(op.error || error)}</p> : null}
      <p className="small" style={{ marginTop: 8 }}>The full log (what the agent did, step by step) is behind the “Log” button above.</p></Banner> : null}
    {op.status === 'expired' ? <Banner kind="warn" title="No agent picked up the operation">{node ? <>The agent on <strong>{node.name}</strong> {node.online ? 'was busy' : `is offline (last seen ${ago(node.lastSeen)})`}. </> : 'The node is offline or busy. '}Nothing was executed: you can retry.</Banner> : null}
    {op.status === 'cancelled' ? <Banner kind="warn" title="Operation cancelled">Any partial data has been removed.</Banner> : null}
    {error && op.status !== 'failed' ? <Banner kind="warn">{error}</Banner> : null}
  </div>;
}

export const Result = ({ op }: { op: Op | null }) => op?.status === 'succeeded' && op.result ? <>{op.result.warning ? <div className="banner warn" role="status" style={{ marginTop: 8 }}><div className="grow small">{String(op.result.warning)}</div></div> : null}{op.result.pending_restart || op.result.restart_required ? <div className="small" style={{ color: 'var(--warn)', marginTop: 6 }}>The new value takes effect after a restart (Patroni: “Restart” on the High availability tab).</div> : null}<details><summary className="small muted" style={{ cursor: 'pointer' }}>Technical details</summary><pre className="out">{JSON.stringify(op.result, null, 2)}</pre></details></> : null;
export { dur };


/** Plain-language next step for the most common refusals (the raw message stays visible above). */
export function hintFor(msg?: string | null): string {
  const m = String(msg || '');
  if (/pg_arca console .* is not responding/.test(m)) return 'Check that the console service is running on the server and that this browser can reach it (same address as before, VPN, proxy). Once it is reachable, press the same button again: the request carries an ID, so it cannot run twice.';
  if (/is not healthy/.test(m)) return 'The selected replica is not healthy (it is not replicating). Pick another one in state “running”, or fix that replica first: Patroni cannot promote it.';
  if (/no healthy replica/.test(m)) return 'No replica is healthy: until one is back to “running” there is no node to move the primary to. Check the Patroni logs of the failing nodes.';
  if (/stale request/.test(m)) return 'The primary has changed in the meantime. Refresh the page and try again.';
  if (/Patroni is not configured|not reachable|unreachable/.test(m)) return 'The agent on this node cannot reach the Patroni REST API. Check the URL under Nodes → Paths and discovery (usually http://127.0.0.1:8008) and that Patroni is running.';
  if (/PGA-GEN-096/.test(m)) return 'After the swap some rows would reference rows that do not exist (foreign key): nothing was changed. Restore the related tables to the same point in time too, or restore them “next to the originals” and recover the rows you need. If you know this is fine you can proceed: those foreign keys will stay NOT VALID.';
  if (/NOT confirmed/.test(m)) return 'Patroni accepted the request but the change was not confirmed in time: check the member states and the Patroni logs.';
  return '';
}


/** The agent install command, with the variant for a console whose TLS certificate is private / self-signed (the node pins the console's certificate). */
export function InstallCommand({ r, nodeName }: { r: { installCommand: string; installCommandPrivateCa?: string }; nodeName?: string }) {
  const [priv, setPriv] = React.useState(false);
  const withNode = (cmd: string) => (nodeName ? cmd.replace('sudo PG_ARCA_URL=', `sudo PG_ARCA_NODE_NAME=${nodeName} PG_ARCA_URL=`) : cmd);
  const cmd = withNode(priv && r.installCommandPrivateCa ? r.installCommandPrivateCa : r.installCommand);
  return <div className="stack-s">
    <CopyBlock text={cmd} />
    {r.installCommandPrivateCa ? <label className="check small"><input type="checkbox" checked={priv} onChange={e => setPriv(e.target.checked)} /><span>The console uses a private or self-signed certificate <span className="muted">— the command first fetches the console’s certificate and pins it for the download and for the agent (PG_ARCA_TLS_CA)</span></span></label> : null}
  </div>;
}

/** The two views of the activity log, one page in the navigation: what ran (operations) and who changed what (the audit trail). */
export function ActivitySwitch({ at }: { at: 'history' | 'audit' }) {
  return <div className="seg" role="tablist" aria-label="Activity log view">
    <button role="tab" aria-pressed={at === 'history'} aria-selected={at === 'history'} onClick={() => go('history')}>Operations</button>
    <button role="tab" aria-pressed={at === 'audit'} aria-selected={at === 'audit'} onClick={() => go('audit')}>Who changed what</button></div>;
}
