/**
 * Operator authentication for the web console.
 *  - First run: no admin exists -> console is in "setup" mode; the first caller creates the admin
 *    (or set PG_ARCA_ADMIN_USER / PG_ARCA_ADMIN_PASSWORD to bootstrap non-interactively).
 *  - Passwords: scrypt (N=2^15) with per-user salt, timing-safe compare.
 *  - Sessions: 256-bit random id in an HttpOnly, SameSite=Strict cookie; only the sha256 is kept server side.
 *  - Brute force: exponential back-off per source IP.
 * Agent endpoints use a different mechanism (per-node bearer secret) — see agents.ts.
 */
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { Store, sha256, nowIso } from './store';
import { audit } from './ops';

const SESSION_TTL_MS = 12 * 3600 * 1000;
const COOKIE = 'arca_session';
const sessions = new Map<string, { user: string; exp: number }>();
const failures = new Map<string, { n: number; until: number }>();

export function hashPassword(pw: string, saltHex?: string) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export function verifyPassword(pw: string, rec: { salt: string; hash: string }) {
  const h = hashPassword(pw, rec.salt).hash;
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(rec.hash, 'hex'));
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionUser(req: Request): string | null {
  const sid = parseCookies(req)[COOKIE];
  if (!sid) return null;
  const k = sha256(sid);
  const s = sessions.get(k);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(k); return null; }
  return s.user;
}

const isSecure = (req: Request) => req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.PG_ARCA_COOKIE_SECURE === '1';

function startSession(req: Request, res: Response, user: string) {
  const sid = crypto.randomBytes(32).toString('base64url');
  sessions.set(sha256(sid), { user, exp: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${isSecure(req) ? '; Secure' : ''}`);
}

export function bootstrapAdminFromEnv(store: Store) {
  const u = process.env.PG_ARCA_ADMIN_USER, p = process.env.PG_ARCA_ADMIN_PASSWORD;
  if (u && p && p.length >= 12 && !store.peek().settings.admin) {
    const h = hashPassword(p);
    return store.mutate(d => { d.settings.admin = { user: u, ...h, createdAt: nowIso() }; });
  }
}

/** Gate for operator-facing /api routes. Agent routes and auth routes are exempt. */
export function requireAdmin(store: Store) {
  return (req: Request, res: Response, next: NextFunction) => {
    const p = req.path;
    if (p.startsWith('/api/auth/') || p.startsWith('/api/agent/') || p === '/api/health' || !p.startsWith('/api/')) return next();
    if (!store.peek().settings.admin) return res.status(428).json({ error: 'setup_required', message: 'Create the administrator account first.' });
    const u = sessionUser(req);
    if (!u) return res.status(401).json({ error: 'unauthenticated' });
    (req as any).actor = u;
    // CSRF defence in depth on top of SameSite=Strict: state-changing calls must be JSON or have no body
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['content-length'] && req.headers['content-length'] !== '0' &&
        !String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'json_required' });
    }
    next();
  };
}

export function mountAuthRoutes(app: any, store: Store) {
  app.get('/api/auth/status', (req: Request, res: Response) => {
    const adm = store.peek().settings.admin;
    res.json({ setupRequired: !adm, authenticated: !!sessionUser(req), user: sessionUser(req) });
  });

  app.post('/api/auth/setup', async (req: Request, res: Response) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) return res.status(400).json({ error: 'invalid_username' });
    if (typeof password !== 'string' || password.length < 12) return res.status(400).json({ error: 'weak_password', message: 'Minimum 12 characters.' });
    const h = hashPassword(password);
    const created = await store.mutate(d => {              // atomic check-and-set: only one setup can win
      if (d.settings.admin) return false;
      d.settings.admin = { user: username, ...h, createdAt: nowIso() };
      audit(d, { actor: username, action: 'auth.setup', status: 'OK' });
      return true;
    });
    if (!created) return res.status(409).json({ error: 'already_configured' });
    startSession(req, res, username);
    res.status(201).json({ ok: true, user: username });
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const ip = req.socket.remoteAddress || '?';
    const f = failures.get(ip);
    if (f && f.until > Date.now()) return res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds: Math.ceil((f.until - Date.now()) / 1000) });
    const adm = store.peek().settings.admin;
    const { username, password } = req.body || {};
    const ok = !!adm && typeof username === 'string' && typeof password === 'string' && username === adm.user && verifyPassword(password, adm);
    if (!ok) {
      const n = (f?.n || 0) + 1;
      failures.set(ip, { n, until: Date.now() + Math.min(60_000, 500 * 2 ** n) });
      await store.mutate(d => audit(d, { actor: String(username || '?'), action: 'auth.login', status: 'FAILED', details: { ip } }));
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    failures.delete(ip);
    startSession(req, res, adm.user);
    await store.mutate(d => audit(d, { actor: adm.user, action: 'auth.login', status: 'OK', details: { ip } }));
    res.json({ ok: true, user: adm.user });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const sid = parseCookies(req)[COOKIE];
    if (sid) sessions.delete(sha256(sid));
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  app.post('/api/auth/change-password', async (req: Request, res: Response) => {
    const u = sessionUser(req);
    if (!u) return res.status(401).json({ error: 'unauthenticated' });
    const { currentPassword, newPassword } = req.body || {};
    const adm = store.peek().settings.admin;
    if (!adm || typeof currentPassword !== 'string' || !verifyPassword(currentPassword, adm)) return res.status(403).json({ error: 'invalid_credentials' });
    if (typeof newPassword !== 'string' || newPassword.length < 12) return res.status(400).json({ error: 'weak_password' });
    const h = hashPassword(newPassword);
    await store.mutate(d => { d.settings.admin = { ...d.settings.admin, ...h }; audit(d, { actor: u, action: 'auth.change_password', status: 'OK' }); });
    sessions.clear();
    res.json({ ok: true });
  });
}
