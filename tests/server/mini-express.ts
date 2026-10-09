/** Tiny express-compatible harness so route modules can be exercised end-to-end without express installed. */
type H = (req: any, res: any, next?: any) => any;
export class MiniApp {
  routes: { method: string; re: RegExp; keys: string[]; h: H }[] = [];
  mws: H[] = [];
  use(h: H) { this.mws.push(h); }
  private add(method: string, p: string, h: H) {
    const keys: string[] = [];
    const re = new RegExp('^' + p.replace(/:([A-Za-z]+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, h });
  }
  get(p: string, h: H) { this.add('GET', p, h); } post(p: string, h: H) { this.add('POST', p, h); }
  delete(p: string, h: H) { this.add('DELETE', p, h); } patch(p: string, h: H) { this.add('PATCH', p, h); }
  disable() {}
  async call(method: string, url: string, opts: { body?: any; headers?: Record<string, string> } = {}) {
    const [pathname, qs] = url.split('?');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    if (opts.body !== undefined) { headers['content-type'] ||= 'application/json'; headers['content-length'] ||= String(JSON.stringify(opts.body).length); }
    const req: any = { method, path: pathname, url, headers, body: opts.body ?? {}, query: Object.fromEntries(new URLSearchParams(qs || '')),
      params: {}, socket: { remoteAddress: '10.9.9.9' }, protocol: 'http', secure: false };
    let status = 200, payload: any, done: () => void; const finished = new Promise<void>(r => (done = r));
    const outHeaders: Record<string, string> = {};
    const res: any = {
      status(c: number) { status = c; return res; }, json(b: any) { payload = b; done(); return res; }, setHeader(k: string, v: string) { outHeaders[k.toLowerCase()] = v; },
      type() { return res; }, sendFile() { done(); }, send(b: any) { payload = b; done(); },
    };
    const chain: H[] = [...this.mws];
    const route = this.routes.find(r => r.method === method && r.re.test(pathname));
    if (route) { const m = pathname.match(route.re)!; route.keys.forEach((k, i) => (req.params[k] = m[i + 1])); chain.push(route.h); }
    else chain.push((_q, s) => s.status(404).json({ error: 'no_route' }));
    let i = 0;
    const next = async (): Promise<void> => { const h = chain[i++]; if (h) await h(req, res, next); };
    await next(); await Promise.race([finished, new Promise(r => setTimeout(r, 50))]);
    return { status, body: payload, headers: outHeaders };
  }
}
