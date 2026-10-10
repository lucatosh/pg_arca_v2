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

export type Role = 'admin' | 'operator' | 'viewer';
export const ROLES: Role[] = ['admin', 'operator', 'viewer'];
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };
interface UserRec { user: string; salt: string; hash: string; role: Role; disabled?: boolean; createdAt: string }

/** Role of a user: the bootstrap account (settings.admin) is always admin; others live in settings.users. */
export function roleOf(store: Store, user: string): Role | null {
  const st = store.peek().settings;
  if (st.admin && st.admin.user === user) return 'admin';
  const u: UserRec | undefined = (st.users || {})[user];
  return u && !u.disabled ? u.role : null;
}
/**
 * Permission table. First match wins. Reads (GET) are open to every role except where listed;
 * every mutating route NOT listed here requires admin (deny by default), so a new route is never silently open.
 */
const RULES: { m: RegExp; p: RegExp; min: Role }[] = [
  { m: /^(GET|HEAD)$/, p: /^\/api\/users(\/|$)/, min: 'admin' },
  { m: /^(GET|HEAD)$/, p: /^\/api\/enrollment-tokens/, min: 'admin' },
  { m: /^(GET|HEAD)$/, p: /^\/api\/notifications/, min: 'admin' },
  { m: /^(GET|HEAD)$/, p: /^\/api\/join-requests/, min: 'admin' },
  { m: /^(GET|HEAD)$/, p: /./, min: 'viewer' },
  { m: /^POST$/, p: /^\/api\/operations\/[^/]+\/cancel$/, min: 'operator' },
  { m: /^POST$/, p: /^\/api\/clusters\/[^/]+\/operations$/, min: 'operator' },
  { m: /^POST$/, p: /^\/api\/clusters\/[^/]+\/hba\/apply$/, min: 'operator' },
  { m: /^PUT$/, p: /^\/api\/clusters\/[^/]+\/backup-policy$/, min: 'operator' },
  { m: /^POST$/, p: /^\/api\/discovery\/scan$/, min: 'operator' },
  { m: /^POST$/, p: /^\/api\/approvals\/[^/]+\/cancel$/, min: 'operator' },
];
export function requiredRole(method: string, path: string): Role {
  for (const r of RULES) if (r.m.test(method) && r.p.test(path)) return r.min;
  return 'admin';
}
export const can = (role: Role, method: string, path: string) => RANK[role] >= RANK[requiredRole(method, path)];
export function revokeSessionsOf(user: string) { for (const [k, v] of sessions) if (v.user === user) sessions.delete(k); }


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
    const p = req.path.toLowerCase();          // Express routes case-insensitively: '/API/users' must not slip past a case-sensitive gate
    if (p.startsWith('/api/auth/') || p.startsWith('/api/agent/') || p === '/api/health' || !p.startsWith('/api/')) return next();
    if (!store.peek().settings.admin) return res.status(428).json({ error: 'setup_required', message: 'Create the administrator account first.' });
    const u = sessionUser(req);
    if (!u) return res.status(401).json({ error: 'unauthenticated' });
    const role = roleOf(store, u);
    if (!role) return res.status(401).json({ error: 'unauthenticated' });          // user removed or disabled while logged in
    (req as any).actor = u; (req as any).role = role;
    if (!can(role, req.method, p)) return res.status(403).json({ error: 'forbidden', message: `Il ruolo “${role}” non può eseguire questa azione.`, requiredRole: requiredRole(req.method, p) });
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
    const u = sessionUser(req); res.json({ setupRequired: !adm, authenticated: !!u, user: u, role: u ? roleOf(store, u) : null });
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
    const st = store.peek().settings; const adm = st.admin;
    const { username, password } = req.body || {};
    const rec: { salt: string; hash: string } | undefined = typeof username === 'string' ? (adm && username === adm.user ? adm : (st.users || {})[username]) : undefined;
    const ok = !!rec && typeof password === 'string' && !!roleOf(store, username) && verifyPassword(password, rec);
    if (!ok) {
      const n = (f?.n || 0) + 1;
      failures.set(ip, { n, until: Date.now() + Math.min(60_000, 500 * 2 ** n) });
      await store.mutate(d => audit(d, { actor: String(username || '?').slice(0, 64), action: 'auth.login', status: 'FAILED', details: { ip } }));
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    failures.delete(ip);
    startSession(req, res, username);
    await store.mutate(d => audit(d, { actor: username, action: 'auth.login', status: 'OK', details: { ip } }));
    res.json({ ok: true, user: username, role: roleOf(store, username) });
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
    const st = store.peek().settings; const isBoot = st.admin?.user === u; const rec = isBoot ? st.admin : (st.users || {})[u];
    if (!rec || typeof currentPassword !== 'string' || !verifyPassword(currentPassword, rec)) return res.status(403).json({ error: 'invalid_credentials' });
    if (typeof newPassword !== 'string' || newPassword.length < 12) return res.status(400).json({ error: 'weak_password' });
    const h = hashPassword(newPassword);
    await store.mutate(d => { if (isBoot) d.settings.admin = { ...d.settings.admin, ...h }; else d.settings.users[u] = { ...d.settings.users[u], ...h }; audit(d, { actor: u, action: 'auth.change_password', status: 'OK' }); });
    revokeSessionsOf(u);
    res.json({ ok: true });
  });

  // ---- user management (admin only: enforced by the permission table) ----
  const strip = (u: UserRec) => ({ user: u.user, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt });
  const admins = (st: any) => 1 + Object.values(st.users || {}).filter((x: any) => x.role === 'admin' && !x.disabled).length;
  app.get('/api/users', (_req: Request, res: Response) => {
    const st = store.peek().settings;
    res.json({ users: [{ user: st.admin?.user, role: 'admin', disabled: false, bootstrap: true }, ...Object.values(st.users || {}).map((u: any) => strip(u))] });
  });
  app.post('/api/users', async (req: Request, res: Response) => {
    const { username, password, role } = req.body || {};
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) return res.status(400).json({ error: 'invalid_username' });
    if (typeof password !== 'string' || password.length < 12) return res.status(400).json({ error: 'weak_password', message: 'Minimo 12 caratteri.' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
    const h = hashPassword(password);
    const r = await store.mutate(d => {
      if (d.settings.admin?.user === username || (d.settings.users || {})[username]) return 'exists' as const;
      (d.settings.users ||= {})[username] = { user: username, ...h, role, createdAt: nowIso() };
      audit(d, { actor: (req as any).actor, action: 'user.create', status: 'OK', details: { username, role } });
      return 'ok' as const;
    });
    if (r === 'exists') return res.status(409).json({ error: 'user_exists' });
    res.status(201).json({ ok: true });
  });
  app.patch('/api/users/:name', async (req: Request, res: Response) => {
    const name = req.params.name; const { role, disabled, password } = req.body || {};
    if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
    if (password !== undefined && (typeof password !== 'string' || password.length < 12)) return res.status(400).json({ error: 'weak_password' });
    const r = await store.mutate(d => {
      const u = (d.settings.users || {})[name];
      if (!u) return 'missing' as const;
      const nextRole = role ?? u.role, nextDis = disabled ?? !!u.disabled;
      if (u.role === 'admin' && !u.disabled && (nextRole !== 'admin' || nextDis) && admins(d.settings) <= 1) return 'last_admin' as const;
      if (role !== undefined) u.role = role; if (disabled !== undefined) u.disabled = !!disabled;
      if (password) Object.assign(u, hashPassword(password));
      audit(d, { actor: (req as any).actor, action: 'user.update', status: 'OK', details: { username: name, role, disabled, passwordReset: !!password } });
      return 'ok' as const;
    });
    if (r === 'missing') return res.status(404).json({ error: 'not_found' });
    if (r === 'last_admin') return res.status(409).json({ error: 'last_admin', message: 'Deve restare almeno un amministratore attivo.' });
    revokeSessionsOf(name);
    res.json({ ok: true });
  });
  app.delete('/api/users/:name', async (req: Request, res: Response) => {
    const name = req.params.name;
    const r = await store.mutate(d => {
      const u = (d.settings.users || {})[name];
      if (!u) return 'missing' as const;
      if (u.role === 'admin' && !u.disabled && admins(d.settings) <= 1) return 'last_admin' as const;
      delete d.settings.users[name];
      audit(d, { actor: (req as any).actor, action: 'user.delete', status: 'OK', details: { username: name } });
      return 'ok' as const;
    });
    if (r === 'missing') return res.status(404).json({ error: 'not_found' });
    if (r === 'last_admin') return res.status(409).json({ error: 'last_admin' });
    revokeSessionsOf(name);
    res.json({ ok: true });
  });
}
