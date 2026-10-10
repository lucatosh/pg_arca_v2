import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError, get, uid } from './api';

/* ---------------- tiny stale-while-revalidate cache (deduped, pauses when the tab is hidden) ---------------- */
type Entry = { data?: any; error?: any; at: number; inflight?: Promise<any>; subs: Set<() => void>; version: number; bumped?: number };
const cache = new Map<string, Entry>();
const entry = (k: string): Entry => { let e = cache.get(k); if (!e) { e = { at: 0, subs: new Set(), version: 0 }; cache.set(k, e); } return e; };

export function revalidate(key: string): Promise<any> {
  const e = entry(key);
  if (e.inflight) return e.inflight;
  e.inflight = get(key).then(d => {
    // Polling returns the same payload most of the time: keep the old object (stable identity for memo) and do not wake any subscriber.
    let same = false;
    if (e.data !== undefined && !e.error) { try { same = JSON.stringify(d) === JSON.stringify(e.data); } catch { same = false; } }
    const now = Date.now(); const hadError = !!e.error;
    if (!same) e.data = d;
    if (!same || hadError || now - (e.bumped || 0) > 30000) { e.version++; e.bumped = now; }       // unchanged data still re-renders every 30 s so "5 min fa" labels stay fresh
    e.error = undefined; e.at = now;
  }, err => { e.error = err; e.version++; })
    .finally(() => { e.inflight = undefined; e.subs.forEach(f => f()); });
  return e.inflight;
}
/** The activity dock and the operation lists must notice a new or finished operation immediately, not at the next poll. */
export const OPS_SLIM_KEY = '/api/operations?slim=1&recent=3600';
export function revalidateOps() { return Promise.all([revalidate(OPS_SLIM_KEY), revalidate('/api/operations')]); }
export function mutateCache(key: string, fn: (d: any) => any) { const e = entry(key); if (e.data !== undefined) { e.data = fn(e.data); e.version++; e.subs.forEach(f => f()); } }

export function useQuery<T = any>(key: string | null, opts: { interval?: number } = {}) {
  const e = key ? entry(key) : undefined;
  const sub = useCallback((cb: () => void) => { e?.subs.add(cb); return () => { e?.subs.delete(cb); }; }, [e]);
  useSyncExternalStore(sub, () => e?.version ?? 0);
  useEffect(() => {
    if (!key) return;
    if (!entry(key).at || Date.now() - entry(key).at > 1500) revalidate(key);
    if (!opts.interval) return;
    const t = setInterval(() => { if (!document.hidden) revalidate(key); }, opts.interval);
    const vis = () => { if (!document.hidden) revalidate(key); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [key, opts.interval]);
  return { data: e?.data as T | undefined, error: e?.error as ApiError | undefined, loading: !!e && e.at === 0 && !e.error, refresh: () => (key ? revalidate(key) : Promise.resolve()) };
}

/* ---------------- toasts ---------------- */
type Toast = { id: number; kind: 'ok' | 'bad' | 'info'; text: string };
let toasts: Toast[] = []; const tsubs = new Set<() => void>(); let tid = 1;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4500) {
  const t = { id: tid++, kind, text }; toasts = [...toasts, t].slice(-4); tsubs.forEach(f => f());
  setTimeout(() => { toasts = toasts.filter(x => x.id !== t.id); tsubs.forEach(f => f()); }, ms);
}
export function useToasts() { return useSyncExternalStore(cb => { tsubs.add(cb); return () => { tsubs.delete(cb); }; }, () => toasts); }

/* ---------------- operation runner ----------------
 * One user intent = one Idempotency-Key. Double clicks / retries / flaky networks re-use the key, so the console never runs it twice.
 * The key is renewed only when the intent finishes (or the params change). */
export interface Op { id: string; type: string; status: string; params: any; result?: any; error?: string; progress?: any; attempts: number; createdAt: string; updatedAt: string; history: any[]; clusterId: string; createdBy: string; cancelRequested?: boolean; }
const TERMINAL = ['succeeded', 'failed', 'expired', 'cancelled'];
export const isTerminal = (s?: string) => !!s && TERMINAL.includes(s);

export function useOpRunner(clusterId: string, onDone?: (op: Op) => void) {
  const [op, setOp] = useState<Op | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<{ sig: string; key: string } | null>(null);
  const timer = useRef<any>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);

  const poll = useCallback(async (id: string) => {
    try {
      const r = await get<{ operation: Op }>(`/api/operations/${id}`);
      if (!alive.current) return;
      setOp(r.operation);
      if (isTerminal(r.operation.status)) { setBusy(false); keyRef.current = null; revalidateOps(); onDone?.(r.operation); return; }
    } catch (e: any) { if (!alive.current) return; setError(e.message); }
    timer.current = setTimeout(() => poll(id), 1000);
  }, [onDone]);

  const run = useCallback(async (type: string, params: Record<string, any> = {}, extra: { nodeId?: string } = {}) => {
    const sig = type + JSON.stringify(params) + (extra.nodeId || '');
    if (!keyRef.current || keyRef.current.sig !== sig) keyRef.current = { sig, key: uid('op') };
    setBusy(true); setError(null); setOp(null);
    try {
      const r = await api<{ operation: Op; approval?: any }>('POST', `/api/clusters/${clusterId}/operations`, { type, params, nodeId: extra.nodeId }, { key: keyRef.current.key });
      if (r.approval) { setBusy(false); keyRef.current = null; revalidate('/api/approvals'); toast('Richiesta inviata: serve l’approvazione di un altro amministratore (pagina Oggi).', 'info', 9000); return null; }
      setOp(r.operation); revalidateOps();
      if (isTerminal(r.operation.status)) { setBusy(false); keyRef.current = null; onDone?.(r.operation); } else poll(r.operation.id);
      return r.operation;
    } catch (e: any) { setBusy(false); setError(e.body?.message || e.message); return null; }
  }, [clusterId, poll, onDone]);

  const cancel = useCallback(async () => { if (op) { try { await api('POST', `/api/operations/${op.id}/cancel`); } catch (e: any) { setError(e.message); } } }, [op]);
  const reset = useCallback(() => { setOp(null); setError(null); setBusy(false); keyRef.current = null; clearTimeout(timer.current); }, []);
  return { op, error, busy, run, cancel, reset };
}

/** Role of the logged-in user ('admin' | 'operator' | 'viewer' | null while loading). The server enforces it; this only hides actions that would be refused. */
export function useRole(): string | null {
  const q = useQuery<{ role: string | null }>('/api/auth/status');
  return q.data?.role ?? null;
}
