/** Thin API client: same-origin, cookie session, JSON. Emits 'arca:auth' on 401/428 so the shell can show login/setup. */
export class ApiError extends Error {
  status: number; body: any;
  constructor(status: number, body: any) {
    super((body && (body.message || body.error)) || `HTTP ${status}`);
    this.status = status; this.body = body;
  }
}

export function uid(prefix = 'ui'): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return `${prefix}-${Array.from(a, b => b.toString(16).padStart(2, '0')).join('')}`;
}

/* ---------------- reachability of the console ----------------
 * A request that never gets an answer (server down, network gone, the console's address changed) must not leave the user staring at a spinner
 * and then a bare "Failed to fetch". Every call has a deadline; a write carrying an Idempotency-Key is retried by itself (the console never runs
 * the same key twice); the shell shows one clear banner while the console cannot be reached and probes until it is back. */
export type NetState = { down: boolean; since: number | null; lastError: string };
let net: NetState = { down: false, since: null, lastError: '' };
const netSubs = new Set<() => void>();
export const netState = () => net;
export const onNet = (cb: () => void) => { netSubs.add(cb); return () => { netSubs.delete(cb); }; };
function setNet(down: boolean, err = '') {
  if (down === net.down && (!down || err === net.lastError)) return;
  net = down ? { down: true, since: net.since ?? Date.now(), lastError: err } : { down: false, since: null, lastError: '' };
  netSubs.forEach(f => f());
}
export const UNREACHABLE = 'console_unreachable';
const unreachable = (why: string) => new ApiError(0, { error: UNREACHABLE, message: `La console pg_arca (${location.host}) non risponde: ${why}. Nulla è andato perso: appena torna raggiungibile puoi riprovare.` });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function once(method: string, path: string, body: any, opts: { key?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.key) headers['idempotency-key'] = opts.key;
  const ctl = new AbortController(); let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ctl.abort(); }, opts.timeoutMs ?? (method === 'GET' ? 25000 : 30000));
  const relay = () => ctl.abort(); opts.signal?.addEventListener('abort', relay);
  try {
    return await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', signal: ctl.signal });
  } catch (e: any) {
    if (opts.signal?.aborted) throw e;                                    // the caller gave up: not a network problem
    throw unreachable(timedOut ? `nessuna risposta in ${Math.round((opts.timeoutMs ?? (method === 'GET' ? 25000 : 30000)) / 1000)} s` : 'connessione non riuscita (server spento, rete assente o indirizzo cambiato)');
  } finally { clearTimeout(t); opts.signal?.removeEventListener('abort', relay); }
}

export async function api<T = any>(method: string, path: string, body?: any, opts: { key?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  // reads and keyed writes are safe to repeat; an unkeyed write is tried once (it could have reached the server)
  const tries = (method === 'GET' || opts.key) && !net.down ? 3 : 1;      // already known down: answer at once, the banner probes
  let res: Response | null = null; let last: any;
  for (let i = 0; i < tries && !res; i++) {
    try { res = await once(method, path, body, opts); }
    catch (e: any) { last = e; if (!(e instanceof ApiError) || opts.signal?.aborted) throw e; setNet(true, e.message); if (i < tries - 1) await sleep(1500 * (i + 1)); }
  }
  if (!res) throw last;
  // a proxy in front of the console answering for it (502/503/504 with an HTML page) is the same problem as no answer
  if ([502, 503, 504].includes(res.status) && !(res.headers.get('content-type') || '').includes('json')) { const e = unreachable(`il proxy davanti alla console risponde ${res.status}`); setNet(true, e.message); throw e; }
  setNet(false);
  let data: any = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; } }
  if (!res.ok) {
    if (res.status === 401 || res.status === 428) window.dispatchEvent(new CustomEvent('arca:auth', { detail: res.status }));
    throw new ApiError(res.status, data);
  }
  // any write that may have queued an operation (or touched one): let the activity dock refresh right away instead of at its next poll
  if (method !== 'GET' && /\/operations|\/approvals/.test(path)) window.dispatchEvent(new Event('arca:ops'));
  return data as T;
}
/** While the console is unreachable: one light request every few seconds; the banner disappears by itself when it answers. */
let probing = false;
onNet(() => {
  if (!net.down || probing) return; probing = true;
  const tick = async () => {
    if (!net.down) { probing = false; return; }
    try { const r = await once('GET', '/api/auth/status', undefined, { timeoutMs: 8000 }); if (r.status < 500) setNet(false); } catch { /* still down */ }
    if (net.down) setTimeout(tick, 4000); else probing = false;
  };
  setTimeout(tick, 2000);
});
export const get = <T = any>(p: string, signal?: AbortSignal) => api<T>('GET', p, undefined, { signal });
