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
import { Store, Operation, OpStatus, AppState, newId, nowIso } from './store';

export const MAX_ATTEMPTS = 5;
const TERMINAL: OpStatus[] = ['succeeded', 'failed', 'expired', 'cancelled'];
export const isTerminal = (s: OpStatus) => TERMINAL.includes(s);

export interface SubmitInput {
  type: string;
  clusterId: string;
  nodeId?: string;
  params?: Record<string, any>;
  idempotencyKey?: string;
  createdBy?: string;
  ttlSeconds?: number;
}

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

/** Idempotent. Returns {op, created}. */
export function submit(store: Store, input: SubmitInput): Promise<{ op: Operation; created: boolean }> {
  return store.mutate(draft => {
    const key = input.idempotencyKey || newId('auto');
    const existing = draft.operations.find(o => o.idempotencyKey === key);
    if (existing) {
      if (existing.type !== input.type || existing.clusterId !== input.clusterId) {
        throw Object.assign(new Error('idempotency key reused with a different request'), { code: 'IDEMPOTENCY_CONFLICT' });
      }
      return { op: existing, created: false };
    }
    const ts = nowIso();
    const op: Operation = {
      id: newId('op'), idempotencyKey: key, type: input.type, clusterId: input.clusterId, nodeId: input.nodeId,
      params: input.params || {}, status: 'queued', createdAt: ts, updatedAt: ts,
      createdBy: input.createdBy || 'admin', attempts: 0, ttlSeconds: input.ttlSeconds ?? 900,
      history: [{ at: ts, status: 'queued' }],
    };
    draft.operations.push(op);
    audit(draft, { clusterId: op.clusterId, actor: op.createdBy, action: `op.submit:${op.type}`, status: 'queued', details: { opId: op.id, nodeId: op.nodeId } });
    // bounded journal: drop oldest terminal operations beyond 2000
    if (draft.operations.length > 2000) {
      const keep = draft.operations.filter(o => !isTerminal(o.status));
      const terms = draft.operations.filter(o => isTerminal(o.status)).slice(-1500);
      draft.operations = [...terms, ...keep].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return { op, created: true };
  });
}

/** Agent poll: hand out runnable operations for a node. */
export function lease(store: Store, nodeId: string, max = 1, leaseSeconds = 120, now = Date.now()): Promise<Operation[]> {
  return store.mutate(draft => {
    const out: Operation[] = [];
    // 1. expire / redeliver
    for (const op of draft.operations) {
      if (isTerminal(op.status)) continue;
      if (op.status === 'queued' && now - Date.parse(op.createdAt) > op.ttlSeconds * 1000) {
        push(op, 'expired', 'not started within ttl'); continue;
      }
      if ((op.status === 'leased' || op.status === 'running') && op.leaseUntil && Date.parse(op.leaseUntil) < now) {
        if (op.attempts >= MAX_ATTEMPTS) { push(op, 'failed', 'lease expired; max attempts reached'); op.error = 'agent did not report a result'; }
        else push(op, 'queued', 'lease expired; redelivering');
      }
    }
    // 2. pick, one in-flight per cluster
    const busy = new Set(draft.operations.filter(o => o.status === 'leased' || o.status === 'running').map(o => o.clusterId));
    for (const op of draft.operations) {
      if (out.length >= max) break;
      if (op.status !== 'queued' || op.nodeId !== nodeId) continue;
      if (busy.has(op.clusterId)) continue;
      op.attempts += 1;
      op.leaseUntil = new Date(now + leaseSeconds * 1000).toISOString();
      push(op, 'leased', `attempt ${op.attempts}`);
      busy.add(op.clusterId);
      out.push(structuredClone(op));
    }
    return out;
  });
}

/** Agent report. Idempotent and monotonic. */
export function report(store: Store, nodeId: string, opId: string, status: 'running' | 'succeeded' | 'failed',
                       result?: any, error?: string, extendLeaseSeconds = 120): Promise<{ ok: boolean; op?: Operation; reason?: string }> {
  return store.mutate(draft => {
    const op = draft.operations.find(o => o.id === opId);
    if (!op) return { ok: false, reason: 'unknown operation' };
    if (op.nodeId !== nodeId) return { ok: false, reason: 'operation belongs to another node' };
    if (isTerminal(op.status)) {
      // a late duplicate of the same terminal outcome is fine; a conflicting one is rejected
      return op.status === status ? { ok: true, op } : { ok: false, op, reason: `already ${op.status}` };
    }
    if (status === 'running') {
      if (op.status === 'queued') return { ok: false, op, reason: 'not leased' };
      op.leaseUntil = new Date(Date.now() + extendLeaseSeconds * 1000).toISOString();
      if (op.status !== 'running') push(op, 'running');
      return { ok: true, op };
    }
    push(op, status, status === 'failed' ? error : undefined);
    op.result = result;
    op.error = error;
    op.leaseUntil = undefined;
    audit(draft, { clusterId: op.clusterId, actor: `agent:${nodeId}`, action: `op.${op.type}`, status: status.toUpperCase(), details: { opId, error } });
    return { ok: true, op };
  });
}

/** Operator cancel: only possible before an agent picked it up. */
export function cancel(store: Store, opId: string, actor = 'admin'): Promise<{ ok: boolean; reason?: string; op?: Operation }> {
  return store.mutate(draft => {
    const op = draft.operations.find(o => o.id === opId);
    if (!op) return { ok: false, reason: 'unknown operation' };
    if (op.status === 'cancelled') return { ok: true, op };
    if (op.status !== 'queued') return { ok: false, op, reason: `cannot cancel a ${op.status} operation` };
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
    await store.mutate(d => { const o = d.operations.find(x => x.id === op.id)!; push(o, 'succeeded'); o.result = result;
      audit(d, { clusterId: o.clusterId, actor: o.createdBy, action: `op.${o.type}`, status: 'SUCCEEDED', details: { opId: o.id } }); });
  } catch (e: any) {
    await store.mutate(d => { const o = d.operations.find(x => x.id === op.id)!; push(o, 'failed', e.message); o.error = e.message;
      audit(d, { clusterId: o.clusterId, actor: o.createdBy, action: `op.${o.type}`, status: 'FAILED', details: { opId: o.id, error: e.message } }); });
  }
  return { op: store.peek().operations.find(o => o.id === op.id)!, created };
}
