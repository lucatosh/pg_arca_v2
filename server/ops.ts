import { PHASE } from './phases';
import fs from 'fs';
import path from 'path';
/**
 * Operation journal & state machine.
 *
 * Every state-changing action on a cluster/node is an Operation:
 *   queued -> leased -> running -> succeeded | failed        (+ expired | cancelled)
 *
 *  - IDEMPOTENT submit: the same idempotencyKey always returns the same Operation
 *    (client retries, double clicks, proxy retries never execute twice).
 *  - AT-LEAST-ONCE delivery with lease: an agent that dies mid-operation lets the lease
 *    lapse and the op is redelivered (max attempts), and the agent de-duplicates by op id
 *    using its own on-disk journal, which makes execution effectively-once.
 *  - SERIALIZED per cluster: at most one mutating operation per cluster is in flight.
 *  - MONOTONIC transitions: terminal states are final; repeating a report is a no-op.
 *  - EXPIRING: a queued op past its TTL is never run late (a switchover requested an hour
 *    ago while the agent was offline must not fire when it reconnects).
 */
import { laneOf, OP_SPECS } from './optypes';
/** How long a queued operation may wait for its agent. A restore waits in the data lane behind a backup that can take hours, and the console tells the
 *  operator it "starts as soon as the current one ends": 12 hours, not the 15 minutes of everything else (independent review). */
// ...except a restore that OVERWRITES live data (production put back in place, a database replaced, tables / rows put back): fired hours later it would
// throw away every write made since the request (independent review). Those keep the 15 minutes: the operator asks again when the lane is free.
export const overwritesLive = (type: string, p: any = {}): boolean => (type === 'restore_instance' && !!p?.replace_production) || (type === 'restore_database' && !!p?.replace_original) || (type === 'restore_object' && !!p?.finish);
export const defaultTtl = (type: string, params: any = {}): number => (type.startsWith('restore_') && OP_SPECS[type]?.lane === 'data' && !overwritesLive(type, params) ? 12 * 3600 : 900);
import { Store, Operation, OpStatus, AppState, newId, nowIso, loadSecretKey, encrypt, decrypt } from './store';

export const MAX_ATTEMPTS = 5;
const TERMINAL: OpStatus[] = ['succeeded', 'failed', 'expired', 'cancelled'];
export const isTerminal = (s: OpStatus) => TERMINAL.includes(s);

export const DEFAULT_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 90;
const HARD_CAP_TERMINAL = 5000;                      // whatever the retention: the state file must stay small
/** How long finished operations stay in the history. */
export function retentionDays(settings: any): number {
  const n = Number(settings?.activity?.retentionDays);
  return Number.isFinite(n) && n >= 1 && n <= MAX_RETENTION_DAYS ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}
/** Drop finished operations past the retention (and beyond the hard cap). Never touches queued/leased/running ones. Returns how many were removed. */
const EVIDENCE = ['restore_drill', 'backup_verify'];
export function pruneOps(draft: AppState, now = Date.now()): number {
  const cut = now - retentionDays(draft.settings) * 86_400_000;
  const before = draft.operations.length;
  // evidence outlives the history: the latest successful drill (the measured restore time, "restore tested") and verification of each
  // cluster stay whatever their age - pruned after 7 days, every production cluster read "Full restore never tested" a week after its drill
  const evidence = new Set<string>(); const seen = new Set<string>();
  for (let i = draft.operations.length - 1; i >= 0; i--) { const o = draft.operations[i];
    if (o.status === 'succeeded' && EVIDENCE.includes(o.type) && !seen.has(o.clusterId + ':' + o.type)) { seen.add(o.clusterId + ':' + o.type); evidence.add(o.id); } }
  let kept = draft.operations.filter(o => !isTerminal(o.status) || evidence.has(o.id) || Date.parse(o.updatedAt || o.createdAt) >= cut);
  const terms = kept.filter(o => isTerminal(o.status));
  if (terms.length > HARD_CAP_TERMINAL) {
    const drop = new Set(terms.slice(0, terms.length - HARD_CAP_TERMINAL).map(o => o.id));
    kept = kept.filter(o => !drop.has(o.id));
  }
  if (kept.length !== before) { const ids = new Set(kept.map(o => o.id)); dropResultFiles(draft.operations.filter(o => !ids.has(o.id))); draft.operations = kept; }
  return before - kept.length;
}
export const prunable = (st: AppState, now = Date.now()) => {
  const cut = now - retentionDays(st.settings) * 86_400_000;
  const old = st.operations.filter(o => isTerminal(o.status) && Date.parse(o.updatedAt || o.createdAt) < cut);
  if (!old.length) return false;
  // only evidence left among the old ones: nothing to prune (otherwise every tick would rewrite the state for nothing)
  return old.some(o => !(o.status === 'succeeded' && EVIDENCE.includes(o.type)) || st.operations.some(x => x !== o && x.clusterId === o.clusterId && x.type === o.type && x.status === 'succeeded' && (x.updatedAt || '') > (o.updatedAt || '')));
};

export interface SubmitInput {
  type: string;
  clusterId: string;
  nodeId?: string;
  params?: Record<string, any>;
  idempotencyKey?: string;
  createdBy?: string;
  ttlSeconds?: number;
}

export const OP_LOG_MAX = 400;
/** One human line for a progress report: the agent's own `msg` if any, otherwise the phase with its counters. */
const hb = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GiB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KiB` : `${n} B`;
export function progressLine(p: any): string {
  if (!p || typeof p !== 'object') return '';
  const bits: string[] = [];
  // read by people in the operation log: the phase in words, sizes in KiB/MiB/GiB with a percentage, units in the plural when they are
  // (the log used to show "copy · 100000000/400000000 byte" and an Italian "segmenti")
  if (p.phase) bits.push(PHASE[String(p.phase)] || String(p.phase));
  if (p.msg) bits.push(String(p.msg).slice(0, 300));
  const pct = (a: number, b: number) => (b > 0 ? ` (${Math.min(100, Math.floor((100 * a) / b))}%)` : '');
  if (p.files_total) bits.push(`${p.files ?? 0} of ${p.files_total} ${p.files_total === 1 ? 'file' : 'files'}${pct(Number(p.files) || 0, Number(p.files_total))}`);
  if (p.bytes_total) bits.push(`${hb(Number(p.bytes) || 0)} of ${hb(Number(p.bytes_total))}${pct(Number(p.bytes) || 0, Number(p.bytes_total))}`);
  if (p.chunks) bits.push(`${p.chunks} ${p.chunks === 1 ? 'chunk' : 'chunks'}`);
  if (p.segments_total) bits.push(`${p.segments ?? 0} of ${p.segments_total} WAL ${p.segments_total === 1 ? 'segment' : 'segments'}`);
  if (p.elapsed_sec != null) bits.push(`${p.elapsed_sec} s`);
  return bits.join(' · ');
}
/** Append what the agent just reported to the operation's log: a new line when the phase or the message changes, otherwise a counters snapshot at most every 15 s. */
export function logProgress(op: Operation, p: any, now = Date.now()) {
  const text = progressLine(p); if (!text) return;
  const log = (op.log ||= []);
  const last = log[log.length - 1];
  const key = (x: any) => `${x?.phase || ''}|${x?.msg || ''}`;
  const changed = !last || last.k !== key(p);
  if (!changed && now - Date.parse(last!.at) < 15_000) return;
  log.push({ at: new Date(now).toISOString(), text, k: key(p) });
  if (log.length > OP_LOG_MAX) log.splice(0, log.length - OP_LOG_MAX);
}
/** Status transitions + agent log, oldest first (what the operator sees in the operation log window). */
export function opTimeline(op: Operation): { at: string; text: string; kind: 'status' | 'log' }[] {
  const st = op.history.map(h => ({ at: h.at, text: `${h.status}${h.note ? ': ' + h.note : ''}`, kind: 'status' as const }));
  const lg = (op.log || []).map(l => ({ at: l.at, text: l.text, kind: 'log' as const }));
  return [...st, ...lg].sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Large results (catalog of a database with thousands of tables, WAL forensics with details, restore diffs) do not belong in the state file, which is
 * rewritten on every commit: above RESULT_INLINE_MAX bytes the result goes to <data>/results/<op>.json and the operation keeps a small summary (its scalar
 * fields, so checks like `result.ok` keep working). GET /api/operations/:id puts the full result back.
 */
export const RESULT_INLINE_MAX = 192 * 1024;
let resultsDir: string | null = null;
export function setResultsDir(dir: string | null) { resultsDir = dir; if (dir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
function setResult(op: Operation, result: any) {
  if (result === undefined || !resultsDir) { op.result = result; return; }
  let text: string;
  try { text = JSON.stringify(result); } catch { op.result = result; return; }
  if (text.length <= RESULT_INLINE_MAX) { op.result = result; return; }
  const file = `${op.id}.json`;
  fs.writeFileSync(path.join(resultsDir, file), text, { mode: 0o600 });
  const small: Record<string, any> = {};
  if (result && typeof result === 'object' && !Array.isArray(result)) for (const [k, v] of Object.entries(result)) if (v === null || ['number', 'boolean'].includes(typeof v) || (typeof v === 'string' && v.length <= 200)) small[k] = v;
  op.result = { ...small, _offloaded: { bytes: text.length } };
  (op as any).resultRef = file;
}
/** The operation as the API returns it: with its full result, also when that lives in a side file. */
export function withResult(op: Operation): Operation {
  const ref = (op as any).resultRef;
  if (!ref || !resultsDir) return redactOp(op);
  try { return redactOp({ ...op, result: JSON.parse(fs.readFileSync(path.join(resultsDir, path.basename(ref)), 'utf8')) }); }
  catch { return redactOp(op); }                            // file gone: the summary is what is left
}
function dropResultFiles(ops: Operation[]) {
  if (!resultsDir) return;
  for (const o of ops) { const ref = (o as any).resultRef; if (ref) { try { fs.unlinkSync(path.join(resultsDir, path.basename(ref))); } catch { /* already gone */ } } }
}

/** Credentials that travel in operation parameters (object-storage keys of offsite_set, the password of an explicit delivery address). An operation
 *  record lives for days in the state file, its snapshots and backups, and is readable by every role: these fields are stored encrypted with the
 *  console key (sealParams, at submission), handed to the agent in clear (unsealParams, at lease) and never returned by the API (redactParams). */
const SECRET_FIELDS: [string, string][] = [['offsite', 'access_key'], ['offsite', 'secret_key'], ['into', 'password']];
const SEALED = 'sealed:';
const mapSecrets = (params: any, f: (v: string) => string): any => {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  let out = params;
  for (const [a, b] of SECRET_FIELDS) {
    const v = out?.[a]?.[b];
    if (typeof v === 'string' && v !== '') out = { ...out, [a]: { ...out[a], [b]: f(v) } };
  }
  return out;
};
export function sealParams(dir: string, params: any): any { return mapSecrets(params, v => (v.startsWith(SEALED) ? v : SEALED + encrypt(loadSecretKey(dir), v))); }
export function unsealParams(dir: string, params: any): any { return mapSecrets(params, v => { if (!v.startsWith(SEALED)) return v; try { return decrypt(loadSecretKey(dir), v.slice(SEALED.length)); } catch { return ''; } }); }
export function redactParams(params: any): any { return mapSecrets(params, () => '•••'); }
export const redactOp = <T extends { params?: any }>(op: T): T => (op && op.params ? { ...op, params: redactParams(op.params) } : op);

function push(op: Operation, status: OpStatus, note?: string) {
  op.status = status;
  op.updatedAt = nowIso();
  op.history.push({ at: op.updatedAt, status, note });
  if (op.history.length > 50) op.history.splice(1, op.history.length - 50);
}

export function audit(draft: AppState, e: { clusterId?: string; actor: string; action: string; status: string; details?: any }) {
  draft.audit.push({ id: newId('aud'), timestamp: nowIso(), ...e });
  if (draft.audit.length > 5000) draft.audit.splice(0, draft.audit.length - 5000);
}

const stable = (v: any): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** Idempotent. Returns {op, created}. Same key + different request (type, cluster or params) is a conflict, never a silent replay. */
export function submit(store: Store, input: SubmitInput): Promise<{ op: Operation; created: boolean }> {
  return store.mutate(draft => {
    const key = input.idempotencyKey || newId('auto');
    const existing = draft.operations.find(o => o.idempotencyKey === key);
    if (existing) {
      if (existing.type !== input.type || existing.clusterId !== input.clusterId || stable(redactParams(existing.params)) !== stable(redactParams(input.params || {}))) {
        throw Object.assign(new Error('idempotency key reused with a different request'), { code: 'IDEMPOTENCY_CONFLICT' });
      }
      return { op: existing, created: false };
    }
    const ts = nowIso();
    const op: Operation = {
      id: newId('op'), idempotencyKey: key, type: input.type, clusterId: input.clusterId, nodeId: input.nodeId,
      params: sealParams(store.dir, input.params || {}), status: 'queued', createdAt: ts, updatedAt: ts,
      createdBy: input.createdBy || 'admin', attempts: 0, ttlSeconds: input.ttlSeconds ?? defaultTtl(input.type, input.params),
      history: [{ at: ts, status: 'queued' }],
    };
    draft.operations.push(op);
    audit(draft, { clusterId: op.clusterId, actor: op.createdBy, action: `op.submit:${op.type}`, status: 'queued', details: { opId: op.id, nodeId: op.nodeId } });
    pruneOps(draft);                         // bounded journal: terminal operations older than the retention (default 7 days, settings.activity.retentionDays) are dropped
    return { op, created: true };
  });
}

/** The agent process on a node restarted (new start time in its heartbeat): what it had leased or was running died with the old process.
 *  Hand it back at once instead of waiting for the lease to expire (2 minutes, with nobody executing). The agent's own journal decides on redelivery:
 *  retry-safe operations run again, the others are reported as 'interrupted, not repeated'. Returns how many were requeued. */
export function requeueOnRestart(draft: any, nodeId: string): number {
  let n = 0;
  for (const op of draft.operations) {
    if (op.nodeId !== nodeId || (op.status !== 'leased' && op.status !== 'running')) continue;
    push(op, 'queued', 'agent restarted: redelivered'); op.leaseUntil = undefined; op.progress = undefined; n++;
  }
  return n;
}

/** Remember a node removed by an administrator (bounded): its agent is told 'node_deleted' and announces itself again right away. */
export function tombstone(d: any, id: string) {
  const t = ((d.settings as any).revokedNodes ||= {}); t[id] = new Date().toISOString();
  const keys = Object.keys(t); if (keys.length > 500) for (const k of keys.sort((a, b) => t[a].localeCompare(t[b])).slice(0, keys.length - 500)) delete t[k];
}

/** At console start: the leases were persisted with the clock of before the stop. Without a grace period the first heartbeat after a restart (or
 *  a long outage) found every running operation of the fleet 'lease expired' and handed it back while its agent was still running it.
 *  Every lease gets a fresh period from now: agents still at work renew it with their next keep-alive. */
export function graceLeasesOnBoot(store: Store, leaseSeconds = 120, now = Date.now()): Promise<number> {
  return store.mutate(draft => {
    let n = 0;
    for (const op of draft.operations) if ((op.status === 'leased' || op.status === 'running') && op.leaseUntil) { op.leaseUntil = new Date(now + leaseSeconds * 1000).toISOString(); n++; }
    // an operation the CONSOLE itself was running (agentless / direct mode: no node, no lease) died with the console: left 'running' it blocked
    // every later direct operation of that cluster for good (independent review). Its outcome is unknown - said, the cluster must be checked
    for (const op of draft.operations) if (op.status === 'running' && !op.nodeId && !op.leaseUntil) {
      push(op, 'failed', 'the console stopped while it was running this operation');
      op.error = 'outcome unknown: the console restarted while running it - check the cluster before running it again';
    }
    return n;
  });
}

/** Agent poll: hand out runnable operations for a node. */
export function lease(store: Store, nodeId: string, max = 1, leaseSeconds = 120, now = Date.now()): Promise<Operation[]> {
  return store.mutate(draft => {
    const out: Operation[] = [];
    // 1. expire / redeliver
    for (const op of draft.operations) {
      if (isTerminal(op.status)) continue;
      // the TTL is for work that never STARTED: an operation handed back after a lapsed lease (console restart, network cut, agent restart)
      // was already running somewhere - measured from when it was handed back, so the agent that comes back can still report its outcome
      if (op.status === 'queued' && now - Date.parse(op.attempts ? op.updatedAt : op.createdAt) > op.ttlSeconds * 1000) {
        push(op, 'expired', op.attempts ? 'not picked up again within ttl after the agent went away' : 'not started within ttl'); continue;
      }
      if ((op.status === 'leased' || op.status === 'running') && op.leaseUntil && Date.parse(op.leaseUntil) < now) {
        if (op.attempts >= MAX_ATTEMPTS) { push(op, 'failed', 'lease expired; max attempts reached'); op.error = 'agent did not report a result'; }
        else push(op, 'queued', 'lease expired; redelivering');
      }
    }
    // 2. pick, one in-flight per cluster
    // an operation handed back after a lapsed lease may still be running on its agent (cut off, not dead): it keeps its lane until it is adopted
    // again, ends or expires - nothing else of that lane starts meanwhile (independent review: a second restore or an expire could start)
    const busy = new Map<string, string>();
    for (const o of draft.operations) if (o.status === 'leased' || o.status === 'running' || (o.status === 'queued' && o.attempts > 0)) busy.set(`${o.clusterId}:${laneOf(o.type)}`, o.id);
    for (const op of draft.operations) {
      if (out.length >= max) break;
      if (op.status !== 'queued' || op.nodeId !== nodeId) continue;
      const laneKey = `${op.clusterId}:${laneOf(op.type)}`;
      if (op.cancelRequested) { push(op, 'cancelled', 'cancelled while its agent was away: not started again'); busy.delete(laneKey); continue; }
      if (busy.has(laneKey) && busy.get(laneKey) !== op.id) continue;
      op.attempts += 1;
      op.leaseUntil = new Date(now + leaseSeconds * 1000).toISOString();
      push(op, 'leased', `attempt ${op.attempts}`);
      busy.set(laneKey, op.id);
      out.push(JSON.parse(JSON.stringify(op)));   // a detached copy for the wire (op is a live proxy here)
    }
    return out;
  });
}

/** Agent report. Idempotent and monotonic. */
export function report(store: Store, nodeId: string, opId: string, status: 'running' | 'succeeded' | 'failed',
                       result?: any, error?: string, extendLeaseSeconds = 120, progress?: any): Promise<{ ok: boolean; op?: Operation; reason?: string; cancel?: boolean }> {
  return store.mutate(draft => {
    const op = draft.operations.find(o => o.id === opId);
    if (!op) return { ok: false, reason: 'unknown operation' };
    if (op.nodeId !== nodeId) return { ok: false, reason: 'operation belongs to another node' };
    // an older agent returns a verification that FOUND problems as a success ({ok: false, problems}): it is a failed verification
    if (status === 'succeeded' && op.type === 'backup_verify' && result && typeof result === 'object' && result.ok === false) {
      const pr: string[] = Array.isArray(result.problems) ? result.problems.map(String) : [];
      status = 'failed'; error = `PGA-VRF-050: verification found ${pr.length} problem(s): ${pr.slice(0, 5).join('; ')}${pr.length > 5 ? ` ... and ${pr.length - 5} more` : ''}`;
    }
    // the console gave up on it while the owning agent was cut off (lease lapsed, then max attempts or ttl): the agent's real outcome wins
    const gaveUp = op.status === 'expired' && op.attempts > 0 || op.status === 'failed' && op.error === 'agent did not report a result';
    if (isTerminal(op.status) && !gaveUp) {
      // a late duplicate of the same terminal outcome is fine (a re-sent 'failed' after a cancel is the same outcome); a conflicting one is rejected
      return op.status === status || (op.status === 'cancelled' && status === 'failed') ? { ok: true, op } : { ok: false, op, reason: `already ${op.status}` };
    }
    if (gaveUp || (op.status === 'queued' && op.attempts > 0)) {
      // adopted again: the agent never stopped working on it (a keep-alive) or finished it (an outcome) - nobody else may get it now
      if (status === 'running') push(op, 'running', 'the agent that runs it is back: adopted again');
      else op.history.push({ at: nowIso(), status: op.status, note: 'the agent that ran it is back with its outcome' });
      op.error = undefined;
    }
    if (status === 'running') {
      if (op.status === 'queued') return { ok: false, op, reason: 'not leased' };
      op.leaseUntil = new Date(Date.now() + extendLeaseSeconds * 1000).toISOString();
      if (op.status !== 'running') push(op, 'running');
      if (progress && typeof progress === 'object') { op.progress = progress; logProgress(op, progress); }
      return { ok: true, op, cancel: !!op.cancelRequested };
    }
    if (status === 'failed' && op.cancelRequested) { push(op, 'cancelled', 'cancelled by operator while running'); op.error = error; op.leaseUntil = undefined; op.progress = undefined;
      audit(draft, { clusterId: op.clusterId, actor: `agent:${nodeId}`, action: `op.${op.type}`, status: 'CANCELLED', details: { opId } }); return { ok: true, op }; }
    // a failure always says something: an older agent may report one without text (the console showed 'error: null')
    if (status === 'failed' && !String(error || '').trim()) error = `${op.type} failed on the agent without an explanation: see the agent log on that node (journalctl -u pg-arca-agent)`;
    push(op, status, status === 'failed' ? error : undefined);
    op.progress = undefined;
    setResult(op, result);
    op.error = error;
    op.leaseUntil = undefined;
    audit(draft, { clusterId: op.clusterId, actor: `agent:${nodeId}`, action: `op.${op.type}`, status: status.toUpperCase(), details: { opId, error } });
    return { ok: true, op };
  }, { lazy: status === 'running' });          // progress keep-alives: telemetry, written within seconds; outcomes are durable before the reply
}

/** Operator cancel: only possible before an agent picked it up. */
export function cancel(store: Store, opId: string, actor = 'admin'): Promise<{ ok: boolean; reason?: string; op?: Operation }> {
  return store.mutate(draft => {
    const op = draft.operations.find(o => o.id === opId);
    if (!op) return { ok: false, reason: 'unknown operation' };
    if (op.status === 'cancelled') return { ok: true, op };
    if ((op.status === 'leased' || op.status === 'running') && OP_SPECS[op.type]?.cancellable) {
      op.cancelRequested = true;                      // cooperative: the agent sees it on its next keep-alive and aborts cleanly
      op.updatedAt = nowIso();
      audit(draft, { clusterId: op.clusterId, actor, action: `op.cancel-requested:${op.type}`, status: 'requested', details: { opId } });
      return { ok: true, op, reason: 'cancel requested' };
    }
    if (op.status !== 'queued') return { ok: false, op, reason: `cannot cancel a ${op.status} operation` };
    if (op.attempts > 0) {
      // handed back after its lease lapsed: its agent may still be running it. Marking it cancelled here freed the cluster for other work while it
      // ran on, and its real outcome was then refused (independent review). The cancel is passed on when the agent comes back.
      if (!OP_SPECS[op.type]?.cancellable) return { ok: false, op, reason: 'its agent may still be running it (cut off from the console): it cannot be cancelled now - wait until the agent is back or the operation expires' };
      op.cancelRequested = true; op.updatedAt = nowIso();
      audit(draft, { clusterId: op.clusterId, actor, action: `op.cancel-requested:${op.type}`, status: 'requested', details: { opId, note: 'handed back, the agent is told when it returns' } });
      return { ok: true, op, reason: 'cancel requested: passed on to the agent when it is back' };
    }
    push(op, 'cancelled', `by ${actor}`);
    audit(draft, { clusterId: op.clusterId, actor, action: `op.cancel:${op.type}`, status: 'cancelled', details: { opId } });
    return { ok: true, op };
  });
}

/** Records the outcome of an operation executed server-side (direct-attach mode) with the same guarantees. */
export async function runLocal<T>(store: Store, input: SubmitInput, exec: () => Promise<T>): Promise<{ op: Operation; created: boolean }> {
  const { op, created } = await submit(store, { ...input, nodeId: undefined });
  if (!created) return { op, created };            // replay: return the recorded outcome, do not re-execute
  const claimed = await store.mutate(d => {
    const o = d.operations.find(x => x.id === op.id)!;
    const busy = d.operations.some(x => x.clusterId === o.clusterId && x.id !== o.id && (x.status === 'running' || x.status === 'leased'));
    if (busy) { push(o, 'failed', 'another operation is in flight on this cluster'); o.error = 'cluster busy'; return false; }
    o.attempts = 1; push(o, 'running'); return true;
  });
  if (!claimed) return { op: store.peek().operations.find(o => o.id === op.id)!, created };
  try {
    const result = await exec();
    await store.mutate(d => { const o = d.operations.find(x => x.id === op.id)!; push(o, 'succeeded'); setResult(o, result);
      audit(d, { clusterId: o.clusterId, actor: o.createdBy, action: `op.${o.type}`, status: 'SUCCEEDED', details: { opId: o.id } }); });
  } catch (e: any) {
    await store.mutate(d => { const o = d.operations.find(x => x.id === op.id)!; push(o, 'failed', e.message); o.error = e.message;
      audit(d, { clusterId: o.clusterId, actor: o.createdBy, action: `op.${o.type}`, status: 'FAILED', details: { opId: o.id, error: e.message } }); });
  }
  return { op: store.peek().operations.find(o => o.id === op.id)!, created };
}
