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
export const OPS_SLIM_KEY = '/api/operations?slim=1&recent=86400';
/** Revalidate every cached query whose key matches: after a change that affects many views at once (a backup policy changes the recovery
 *  objectives of every cluster it applies to). Only keys already in the cache, so nothing is fetched that no page asked for. */
export function revalidateMatching(re: RegExp) { return Promise.all([...cache.keys()].filter(k => re.test(k)).map(k => revalidate(k))); }
export function revalidateOps(clusterId?: string) {
  const keys = [OPS_SLIM_KEY, '/api/operations'];
  if (clusterId && !clusterId.startsWith('worker:')) keys.push(`/api/clusters/${encodeURIComponent(clusterId)}/activity`);   // "Running on this cluster" strip: at once, not at its next 5 s poll
  return Promise.all(keys.map(k => revalidate(k)));
}
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
type Toast = { id: number; kind: 'ok' | 'bad' | 'info'; text: string; tag?: string };
let toasts: Toast[] = []; const tsubs = new Set<() => void>(); let tid = 1;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4500, tag?: string) {
  if (toasts.some(x => x.text === text && x.kind === kind)) return;                        // the same message twice (page + activity) is shown once
  const t = { id: tid++, kind, text, tag }; toasts = [...toasts, t].slice(-2); tsubs.forEach(f => f());   // at most two at a time: they must never hide the page
  setTimeout(() => { toasts = toasts.filter(x => x.id !== t.id); tsubs.forEach(f => f()); }, ms);
}
/** A later success makes an earlier failure toast of the same thing stale (a red "failed" next to a green "saved"): it goes. */
export function dismissToastsTagged(tag: string) { const n = toasts.filter(x => (x as any).tag !== tag); if (n.length !== toasts.length) { toasts = n; tsubs.forEach(f => f()); } }
/** Operations a mounted page is showing right now: their outcome is on the page, a toast would only repeat it (and cover it). */
const onScreen = new Map<string, number>();
export const isOnScreen = (id: string) => (onScreen.get(id) || 0) > 0;
export function dismissToast(id: number) { toasts = toasts.filter(x => x.id !== id); tsubs.forEach(f => f()); }
export function useToasts() { return useSyncExternalStore(cb => { tsubs.add(cb); return () => { tsubs.delete(cb); }; }, () => toasts); }

/* ---------------- operation runner ----------------
 * One user intent = one Idempotency-Key. Double clicks / retries / flaky networks re-use the key, so the console never runs it twice.
 * The key is renewed only when the intent finishes (or the params change). */
export interface Op { id: string; nodeId?: string; type: string; status: string; params: any; result?: any; error?: string; progress?: any; attempts: number; createdAt: string; updatedAt: string; history: any[]; clusterId: string; createdBy: string; cancelRequested?: boolean; }
const TERMINAL = ['succeeded', 'failed', 'expired', 'cancelled'];
export const isTerminal = (s?: string) => !!s && TERMINAL.includes(s);

/* ---------------- drafts: what the user typed or chose survives leaving the page ----------------
 * Switching tab, opening a setting from inside a form, following a link and coming back (also with the browser's Back) must give back
 * exactly what was there. A draft lives in memory for the whole session and, unless it may hold a secret, in sessionStorage too (a reload
 * of the tab keeps it; closing the tab forgets it). Saved or cancelled work clears its drafts (clearDrafts). */
const drafts = new Map<string, any>();
const SS = 'pgarca.draft.';
const ssGet = (k: string) => { try { const v = sessionStorage.getItem(SS + k); return v == null ? undefined : JSON.parse(v); } catch { return undefined; } };
const ssSet = (k: string, v: any) => { try { if (v === undefined) sessionStorage.removeItem(SS + k); else sessionStorage.setItem(SS + k, JSON.stringify(v)); } catch { /* full or blocked: memory is enough */ } };
export function readDraft<T>(key: string): T | undefined { return drafts.has(key) ? drafts.get(key) : ssGet(key); }
// between "Sign out" and the login screen the pages are still mounted for a moment (the logout request, then the status request): a draft
// written in that window (a field's last change, an effect) survived the logout and was shown to the next person (seen once in the fluidity test)
let frozen = false;
export function writeDraft(key: string, v: any, session = true) { if (frozen) return; drafts.set(key, v); if (session) ssSet(key, v); }
const draftResets = new Set<(prefix: string) => void>();
/** Logout, or another user signing in on this browser: nothing typed by the previous user may be shown. */
export function clearAllDrafts(leaving = false) {
  if (leaving) { frozen = true; cache.clear(); toasts = []; tsubs.forEach(f => f()); }   // signing out: cached answers (users, settings…) and toasts go too
  drafts.clear();
  try { for (let i = sessionStorage.length - 1; i >= 0; i--) { const k = sessionStorage.key(i) || ''; if (k.startsWith(SS)) sessionStorage.removeItem(k); } } catch { /* ignore */ }
}
/** The login screen is showing: drafts stay off until someone signs in. */
export function draftsSignedOut() { frozen = true; }   // nothing is cleared here: an expired session or a console restart must not lose a half-filled form; a different person signing in clears (draftsOwner)
export function draftsOwner(user: string) {
  frozen = false;
  let prev: string | null = null; try { prev = sessionStorage.getItem('pgarca.draft-owner'); } catch { /* ignore */ }
  if (prev !== null && prev !== user) clearAllDrafts();
  try { sessionStorage.setItem('pgarca.draft-owner', user); } catch { /* ignore */ }
}
export function clearDrafts(prefix: string) {
  draftResets.forEach(f => f(prefix));
  for (const k of [...drafts.keys()]) if (k === prefix || k.startsWith(prefix + ':')) drafts.delete(k);
  try { for (let i = sessionStorage.length - 1; i >= 0; i--) { const k = sessionStorage.key(i) || ''; if (k === SS + prefix || k.startsWith(SS + prefix + ':')) sessionStorage.removeItem(k); } } catch { /* ignore */ }
}
/** useState that survives unmounting. key null = an ordinary useState. secret: never written to sessionStorage (passwords, tokens). */
export function useDraft<T>(key: string | null, init: T | (() => T), opts: { secret?: boolean } = {}): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => { if (key) { const d = readDraft<T>(key); if (d !== undefined) return d; } return typeof init === 'function' ? (init as () => T)() : init; });
  const keyRef = useRef<string | null>(key); keyRef.current = key;
  const set = useCallback((x: T | ((p: T) => T)) => setV(prev => { const n = typeof x === 'function' ? (x as (p: T) => T)(prev) : x; if (keyRef.current) writeDraft(keyRef.current, n, !opts.secret); return n; }), [opts.secret]);
  // cleared elsewhere (saved, cancelled, applied): a component still on screen goes back to its initial value
  const initRef = useRef(init); initRef.current = init;
  useEffect(() => { const f = (prefix: string) => { const k = keyRef.current; if (k && (k === prefix || k.startsWith(prefix + ':'))) { const i = initRef.current; setV(typeof i === 'function' ? (i as () => T)() : i); } };
    draftResets.add(f); return () => { draftResets.delete(f); }; }, []);
  // the same component shown for another entity (another cluster): take that entity's draft
  const seen = useRef<string | null>(key);
  useEffect(() => { if (seen.current === key) return; seen.current = key; const d = key ? readDraft<T>(key) : undefined; setV(d !== undefined ? d : typeof init === 'function' ? (init as () => T)() : init); }, [key]);
  return [v, set];
}

export function useOpRunner(clusterId: string, onDone?: (op: Op) => void, persist?: string) {
  // persist: the operation this runner started is remembered under that key; coming back to the page shows it again (and follows it if still running)
  const pk = persist ? `op:${persist}` : null;
  const [op, setOp0] = useState<Op | null>(() => (pk ? readDraft<Op>(pk) ?? null : null));
  const setOp = useCallback((o: Op | null) => { setOp0(o); if (pk) writeDraft(pk, o && o.id ? o : undefined); }, [pk]);   // the 'sending' placeholder is never remembered
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(() => !!(pk && readDraft<Op>(pk) && !isTerminal(readDraft<Op>(pk)!.status)));
  const [conflict, setConflict] = useState<any>(null);          // 409 from the console: a colleague's operation collides with this one (who, what, since)
  // a request waiting for a second administrator (four-eyes): followed until it is decided; once approved, the operation it started is followed
  // like any other (independent review: the wizard lost it, showed an empty card and let the operator submit it again)
  const ak = pk ? pk + ':apr' : null;
  const [approval, setApproval0] = useState<any>(() => (ak ? readDraft<any>(ak) ?? null : null));
  const setApproval = useCallback((a: any) => { setApproval0(a); if (ak) writeDraft(ak, a || undefined); }, [ak]);
  const last = useRef<{ type: string; params: any; extra: any } | null>(null);
  const keyRef = useRef<{ sig: string; key: string } | null>(null);
  const timer = useRef<any>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  useEffect(() => { const id = op?.id; if (!id) return; onScreen.set(id, (onScreen.get(id) || 0) + 1); return () => { const n = (onScreen.get(id) || 1) - 1; if (n > 0) onScreen.set(id, n); else onScreen.delete(id); }; }, [op?.id]);

  const poll = useCallback(async (id: string) => {
    try {
      const r = await get<{ operation: Op }>(`/api/operations/${id}`);
      if (!alive.current) return;
      setOp(r.operation); setError(null);
      if (isTerminal(r.operation.status)) { setBusy(false); keyRef.current = null; revalidateOps(clusterId); onDone?.(r.operation); return; }
    } catch (e: any) { if (!alive.current) return; setError(e.body?.error === 'console_unreachable' ? 'Cannot refresh the status: the console is not responding. The operation keeps running on the server; the status updates as soon as the console is reachable again.' : e.message); }
    timer.current = setTimeout(() => poll(id), 1000);
  }, [onDone, setOp]);

  const pollApproval = useCallback(async (id: string) => {
    try {
      const r = await get<{ approvals: any[] }>('/api/approvals');
      if (!alive.current) return;
      const a = (r.approvals || []).find(x => x.id === id);
      if (a && a.status === 'approved' && a.operationId) { setApproval(null); setBusy(true); poll(a.operationId); return; }
      if (!a || ['rejected', 'cancelled', 'expired'].includes(a.status) || (a.status === 'approved' && !a.operationId)) { setApproval(a ? { ...a, final: true } : { id, status: 'gone', final: true }); return; }
      setApproval(a);
    } catch { /* console briefly unreachable: try again */ }
    timer.current = setTimeout(() => pollApproval(id), 4000);
  }, [poll, setApproval]);
  useEffect(() => { const o = pk ? readDraft<Op>(pk) : null; if (o && !isTerminal(o.status)) poll(o.id); else { const a = ak ? readDraft<any>(ak) : null; if (a && !a.final) pollApproval(a.id); } }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async (type: string, params: Record<string, any> = {}, extra: { nodeId?: string } = {}) => {
    const sig = type + JSON.stringify(params) + (extra.nodeId || '');
    if (!keyRef.current || keyRef.current.sig !== sig) keyRef.current = { sig, key: uid('op') };
    setBusy(true); setError(null); setConflict(null); last.current = { type, params, extra };
    // shown at once by every OpPanel: the request is on its way to the console (status 'sending', no id yet)
    const now = new Date().toISOString();
    setOp({ id: '', type, status: 'sending', params, attempts: 0, createdAt: now, updatedAt: now, history: [], clusterId, createdBy: '' });
    try {
      const url = clusterId.startsWith('worker:') ? `/api/workers/${encodeURIComponent(clusterId.slice(7))}/operations` : `/api/clusters/${clusterId}/operations`;   // operational machines have their own endpoint
      const r = await api<{ operation: Op; approval?: any }>('POST', url, { type, params, nodeId: extra.nodeId }, { key: keyRef.current.key });
      if (r.approval) { setOp(null); setBusy(false); keyRef.current = null; setApproval(r.approval); revalidate('/api/approvals'); toast('Request sent: another administrator must approve it (Today page).', 'info', 9000); timer.current = setTimeout(() => pollApproval(r.approval.id), 4000); return null; }
      setOp(r.operation); revalidateOps(clusterId);
      if (isTerminal(r.operation.status)) { setBusy(false); keyRef.current = null; onDone?.(r.operation); } else poll(r.operation.id);
      return r.operation;
    } catch (e: any) {
      // console unreachable: the key is kept, so pressing the same button again can never start the operation twice
      setOp(null); setBusy(false); setError(e.body?.message || e.message); if (e.body?.error === 'conflict' || e.body?.overridable) { setConflict(e.body); keyRef.current = null; } return null;
    }
  }, [clusterId, poll, pollApproval, onDone, setOp, setApproval]);
  /** after an overridable conflict (an HA action while data work runs), the operator confirmed: same request with force */
  const runForced = useCallback(() => { const l = last.current; if (l) return run(l.type, { ...l.params, force: true }, l.extra); return Promise.resolve(null); }, [run]);

  const cancel = useCallback(async () => { if (op?.id) { try { await api('POST', `/api/operations/${op.id}/cancel`); } catch (e: any) { setError(e.message); } } }, [op]);
  const reset = useCallback(() => { setOp(null); setError(null); setConflict(null); setBusy(false); setApproval(null); keyRef.current = null; clearTimeout(timer.current); }, [setOp, setApproval]);
  /** the requester withdraws a request still waiting for approval */
  const withdraw = useCallback(async () => { if (approval?.id && !approval.final) { try { await api('POST', `/api/approvals/${approval.id}/cancel`); } catch (e: any) { setError(e.message); } clearTimeout(timer.current); pollApproval(approval.id); } }, [approval, pollApproval]);
  return { op, error, busy, run, cancel, reset, conflict, runForced, approval, withdraw };
}

/** Role of the logged-in user ('admin' | 'operator' | 'viewer' | null while loading). The server enforces it; this only hides actions that would be refused. */
export function useRole(): string | null {
  const q = useQuery<{ role: string | null }>('/api/auth/status');
  return q.data?.role ?? null;
}
