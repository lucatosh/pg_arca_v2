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

export async function api<T = any>(method: string, path: string, body?: any, opts: { key?: string; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.key) headers['idempotency-key'] = opts.key;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', signal: opts.signal });
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
export const get = <T = any>(p: string, signal?: AbortSignal) => api<T>('GET', p, undefined, { signal });
