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
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { Store, sha256, nowIso, loadSecretKey, encrypt, decrypt } from './store';
import { audit } from './ops';
import { authenticateLdap, LdapConfig } from './ldap';

const SESSION_TTL_MS = 12 * 3600 * 1000;
const COOKIE = 'arca_session';
const sessions = new Map<string, { user: string; exp: number }>();
/** Failed logins: back-off per (source address, user name), so that one person mistyping a password (or someone guessing one account) does not lock out
 *  everybody else behind the same proxy / NAT; plus a loose cap per source address against guessing across many user names. Entries expire on their own. */
const failures = new Map<string, { n: number; until: number; last: number }>();
const ipWindow = new Map<string, { n: number; since: number }>();
/** ...and a cap per user name whatever the source address: a guesser behind a proxy that forwards a different X-Forwarded-For on every request
 *  (or many addresses) still gets at most USER_MAX_FAILS attempts on one account per window. */
const userWindow = new Map<string, { n: number; since: number }>();
const IP_MAX_FAILS = 30, IP_WINDOW_MS = 10 * 60_000, USER_MAX_FAILS = 50;
function pruneFailures(now: number) {
  if (failures.size + ipWindow.size + userWindow.size < 5000) return;
  for (const [k, v] of failures) if (now - v.last > 3600_000) failures.delete(k);
  for (const [k, v] of ipWindow) if (now - v.since > IP_WINDOW_MS) ipWindow.delete(k);
  for (const [k, v] of userWindow) if (now - v.since > IP_WINDOW_MS) userWindow.delete(k);
}
let DUMMY: { salt: string; hash: string } | null = null;          // an unknown user costs the same scrypt as a known one: no user enumeration by timing

export type Role = 'admin' | 'operator' | 'viewer';
export const ROLES: Role[] = ['admin', 'operator', 'viewer'];
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };
interface UserRec { user: string; salt: string; hash: string; role: Role; disabled?: boolean; createdAt: string; source?: 'local' | 'ldap'; dn?: string; lastLoginAt?: string }

/** Role of a user: the bootstrap account (settings.admin) is always admin; others live in settings.users. */
export function roleOf(store: Store, user: string): Role | null {
  const st = store.peek().settings;
  if (st.admin && st.admin.user === user) return 'admin';
  const u: UserRec | undefined = own(st.users, user);
  return u && !u.disabled ? u.role : null;
}
/**
 * Permission table. First match wins. Reads (GET) are open to every role except where listed;
 * every mutating route NOT listed here requires admin (deny by default), so a new route is never silently open.
 */
const own = (o: any, k: string) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);   // user-controlled keys must never resolve to Object.prototype members
const RULES: { m: RegExp; p: RegExp; min: Role }[] = [
  { m: /^(GET|HEAD)$/, p: /^\/api\/users(\/|$)/, min: 'admin' },
  { m: /^(GET|HEAD)$/, p: /^\/api\/api-tokens/, min: 'admin' },
  { m: /^(GET|HEAD)$/, p: /^\/api\/auth\/ldap/, min: 'admin' },
  { m: /^(GET|HEAD)$/, p: /^\/api\/enrollment-tokens/, min: 'admin' },
  { m: /^(GET|HEAD)$/, p: /^\/api\/notifications/, min: 'admin' },
  { m: /^(GET|HEAD)$/, p: /^\/api\/join-requests/, min: 'admin' },
  { m: /^(GET|HEAD)$/, p: /./, min: 'viewer' },
  { m: /^POST$/, p: /^\/api\/operations\/[^/]+\/cancel$/, min: 'operator' },
  { m: /^POST$/, p: /^\/api\/clusters\/[^/]+\/operations$/, min: 'operator' },
  { m: /^POST$/, p: /^\/api\/clusters\/[^/]+\/hba\/(apply|restore)$/, min: 'operator' },
  { m: /^PUT$/, p: /^\/api\/clusters\/[^/]+\/backup-policy$/, min: 'operator' },
  { m: /^POST$/, p: /^\/api\/clusters\/[^/]+\/destination\/check$/, min: 'operator' },
  { m: /^POST$/, p: /^\/api\/discovery\/scan$/, min: 'operator' },
  { m: /^POST$/, p: /^\/api\/approvals\/[^/]+\/cancel$/, min: 'operator' },
  { m: /^POST$/, p: /^\/api\/workers\/[^/]+\/operations$/, min: 'operator' },
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

/**
 * First-run takeover protection: before the administrator exists, whoever reaches the console first could create it. From anywhere but the machine itself
 * (loopback) the setup therefore needs a one-time code that only someone with access to the server can read: printed in the console's log at start and
 * written to <data dir>/setup-code (0600). Active in production (NODE_ENV=production) or with PG_ARCA_SETUP_CODE=on; PG_ARCA_SETUP_CODE=off disables it.
 */
let SETUP_CODE: string | null = null;
const loopback = (req: Request) => /^(127\.|::1$|::ffff:127\.)/.test(String(req.socket?.remoteAddress || ''));
export function setupCodeNeeded(req: Request) {
  const mode = process.env.PG_ARCA_SETUP_CODE;
  if (mode === 'off') return false;
  return (process.env.NODE_ENV === 'production' || mode === 'on') && !loopback(req);
}
export function initSetupCode(store: Store) {
  if (store.peek().settings.admin) return null;
  SETUP_CODE = crypto.randomBytes(6).toString('hex');
  try { fs.writeFileSync(path.join(store.dir, 'setup-code'), SETUP_CODE + '\n', { mode: 0o600 }); } catch { /* the log line is enough */ }
  console.log(`[pg_arca] first run: setup code for the administrator account = ${SETUP_CODE} (also in ${store.dir}/setup-code)`);
  return SETUP_CODE;
}

export function bootstrapAdminFromEnv(store: Store) {
  const u = process.env.PG_ARCA_ADMIN_USER, p = process.env.PG_ARCA_ADMIN_PASSWORD;
  if (u && p && p.length >= 12 && !store.peek().settings.admin) {
    const h = hashPassword(p);
    return store.mutate(d => { d.settings.admin = { user: u, ...h, createdAt: nowIso() }; });
  }
}

const PUBLIC_AUTH = new Set(['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/auth/change-password']);
/** Gate for operator-facing /api routes. Agent routes and the sign-in routes are exempt. */
export function requireAdmin(store: Store) {
  return (req: Request, res: Response, next: NextFunction) => {
    const p = req.path.toLowerCase();          // Express routes case-insensitively: '/API/users' must not slip past a case-sensitive gate
    // public: only the sign-in routes themselves (status, setup, login, logout, change-password - the last checks its own session), the agent gateway
    // (node token), liveness and /api/metrics (its own bearer token). Everything else under /api/auth/ (the directory settings) is gated like any route.
    if (PUBLIC_AUTH.has(p) || p.startsWith('/api/agent/') || p === '/api/health' || p === '/api/metrics' || !p.startsWith('/api/')) return next();
    if (!store.peek().settings.admin) return res.status(428).json({ error: 'setup_required', message: 'Create the administrator account first.' });
    let u = sessionUser(req); let role: Role | null = u ? roleOf(store, u) : null;
    if (!u) {
      // automation (CI, Ansible, scripts): a bearer API token created by an administrator, with its own role and expiry; actor = "token:<label>"
      const t = apiTokenOf(store, req);
      if (t === 'bad') return res.status(401).json({ error: 'unauthenticated', message: 'API token unknown, revoked or expired.' });
      if (t) { u = `token:${t.label}`; role = t.role; (req as any).tokenOwner = t.createdBy; touchApiToken(store, t.id); }
    }
    if (!u) return res.status(401).json({ error: 'unauthenticated' });
    if (!role) return res.status(401).json({ error: 'unauthenticated' });          // user removed or disabled while logged in
    (req as any).actor = u; (req as any).role = role;
    if (!can(role, req.method, p)) return res.status(403).json({ error: 'forbidden', message: `Role “${role}” cannot perform this action.`, requiredRole: requiredRole(req.method, p) });
    // CSRF defence in depth on top of SameSite=Strict: state-changing calls must be JSON or have no body
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['content-length'] && req.headers['content-length'] !== '0' &&
        !String(req.headers['content-type'] || '').includes('application/json')) {
      return res.status(415).json({ error: 'json_required' });
    }
    next();
  };
}

// ---------------------------------------------------------------------------------------------------------- API tokens (automation)
export interface ApiTokenRec { id: string; label: string; hash: string; role: Role; createdBy: string; createdAt: string; expiresAt: string | null; lastUsedAt?: string; revokedAt?: string }
const API_TOKEN_PREFIX = 'arca_api_';
/** The valid API token presented as a bearer, null when none is presented, 'bad' when one is presented but unknown / revoked / expired. */
export function apiTokenOf(store: Store, req: Request): ApiTokenRec | null | 'bad' {
  const h = String(req.headers.authorization || '');
  if (!/^Bearer\s+arca_api_/i.test(h)) return null;
  const raw = h.replace(/^Bearer\s+/i, '').trim();
  const k = sha256(raw);
  const t = Object.values((store.peek().settings.apiTokens || {}) as Record<string, ApiTokenRec>).find(x => x.hash === k);
  if (!t || t.revokedAt || (t.expiresAt && Date.parse(t.expiresAt) < Date.now())) return 'bad';
  return t;
}
const lastTouch = new Map<string, number>();
/** lastUsedAt, written at most every 5 minutes per token (a scraper every 10 s must not rewrite the state each time). */
function touchApiToken(store: Store, id: string) {
  const now = Date.now(); if ((lastTouch.get(id) || 0) > now - 300_000) return; lastTouch.set(id, now);
  store.mutate(d => { const t = (d.settings.apiTokens || {})[id]; if (t) t.lastUsedAt = nowIso(); }).catch(() => undefined);
}
export function mountApiTokenRoutes(app: any, store: Store) {
  const view = (t: ApiTokenRec) => ({ id: t.id, label: t.label, role: t.role, createdBy: t.createdBy, createdAt: t.createdAt, expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt || null, revokedAt: t.revokedAt || null, prefix: API_TOKEN_PREFIX });
  app.get('/api/api-tokens', (_req: Request, res: Response) => res.json({ tokens: Object.values((store.peek().settings.apiTokens || {}) as Record<string, ApiTokenRec>).map(view) }));
  app.post('/api/api-tokens', async (req: Request, res: Response) => {
    const { label, role, ttlDays } = req.body || {};
    if (typeof label !== 'string' || !/^[A-Za-z0-9 _.@:-]{2,60}$/.test(label)) return res.status(400).json({ error: 'invalid_label', message: 'Label: 2-60 characters (letters, digits, space, _ . @ : -).' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
    const days = ttlDays === undefined || ttlDays === null || ttlDays === '' ? null : Number(ttlDays);
    if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) return res.status(400).json({ error: 'invalid_ttl', message: 'ttlDays: 1-3650, or empty for no expiry.' });
    const token = API_TOKEN_PREFIX + crypto.randomBytes(30).toString('base64url');
    const rec: ApiTokenRec = { id: 'tk' + crypto.randomBytes(6).toString('hex'), label, hash: sha256(token), role, createdBy: (req as any).actor, createdAt: nowIso(), expiresAt: days ? new Date(Date.now() + days * 86400_000).toISOString() : null };
    await store.mutate(d => { (d.settings.apiTokens ||= {})[rec.id] = rec; audit(d, { actor: (req as any).actor, action: 'apitoken.create', status: 'OK', details: { id: rec.id, label, role, expiresAt: rec.expiresAt } }); });
    res.status(201).json({ token, ...view(rec), note: 'The token is shown once. Send it as: Authorization: Bearer <token>' });
  });
  app.delete('/api/api-tokens/:id', async (req: Request, res: Response) => {
    const id = req.params.id;
    const r = await store.mutate(d => { const t = own(d.settings.apiTokens, id); if (!t) return 'missing' as const; if (!t.revokedAt) { t.revokedAt = nowIso(); audit(d, { actor: (req as any).actor, action: 'apitoken.revoke', status: 'OK', details: { id, label: t.label } }); } return 'ok' as const; });
    if (r === 'missing') return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });
}

/** The directory configuration with the bind password decrypted, or null when LDAP sign-in is off (even=true: also when disabled, for the test endpoint). */
export function ldapConfig(store: Store, evenDisabled = false): LdapConfig | null {
  const c = (store.peek().settings as any).ldap;
  if (!c || !c.url || (!c.enabled && !evenDisabled)) return null;
  let bindPassword = '';
  if (c.bindPasswordEnc) { try { bindPassword = decrypt(loadSecretKey(store.dir), c.bindPasswordEnc); } catch { bindPassword = ''; } }
  return { ...c, bindPassword };
}

export function validateLdap(b: any): string[] {
  const errs: string[] = [];
  if (!b.enabled && !b.url) return errs;
  if (typeof b.url !== 'string' || !/^ldaps?:\/\/[^\s/]+$/i.test(b.url.trim())) errs.push('url: ldap://host[:port] or ldaps://host[:port].');
  if (typeof b.baseDN !== 'string' || !b.baseDN.trim()) { if (!(typeof b.userDnTemplate === 'string' && b.userDnTemplate.includes('{user}'))) errs.push('baseDN is required (or a user DN template with {user}).'); }
  if (b.userFilter && (typeof b.userFilter !== 'string' || !b.userFilter.includes('{user}'))) errs.push('userFilter must contain {user}.');
  if (b.userDnTemplate && (typeof b.userDnTemplate !== 'string' || !b.userDnTemplate.includes('{user}'))) errs.push('userDnTemplate must contain {user}.');
  if (!b.userFilter && !b.userDnTemplate) errs.push('Give a user filter (search) or a user DN template.');
  if (b.insecureSkipVerify && /^ldaps:/i.test(String(b.url)) === false && !b.startTls) { /* plain ldap: nothing to verify */ }
  return errs;
}

export function mountAuthRoutes(app: any, store: Store) {
  app.get('/api/auth/status', (req: Request, res: Response) => {
    const adm = store.peek().settings.admin;
    const u = sessionUser(req); res.json({ setupRequired: !adm, setupCodeRequired: !adm && setupCodeNeeded(req), authenticated: !!u, user: u, role: u ? roleOf(store, u) : null });
  });

  app.post('/api/auth/setup', async (req: Request, res: Response) => {
    const { username, password, setupCode } = req.body || {};
    if (setupCodeNeeded(req) && !(SETUP_CODE && typeof setupCode === 'string' && setupCode.trim().length === SETUP_CODE.length && crypto.timingSafeEqual(Buffer.from(setupCode.trim()), Buffer.from(SETUP_CODE))))
      return res.status(403).json({ error: 'setup_code_required', message: 'The first-setup code is required: you find it in the console log or in the setup-code file of its data directory.' });
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
    SETUP_CODE = null; try { fs.unlinkSync(path.join(store.dir, 'setup-code')); } catch { /* not there */ }
    startSession(req, res, username);
    res.status(201).json({ ok: true, user: username });
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || '?';
    const now = Date.now(); pruneFailures(now);
    const { username, password } = req.body || {};
    const uname = typeof username === 'string' ? username.slice(0, 64) : '?';
    const fk = ip + '\u0000' + uname.toLowerCase();
    const f = failures.get(fk); const w = ipWindow.get(ip); const uw = userWindow.get(uname.toLowerCase());
    const ipBlocked = !!w && now - w.since < IP_WINDOW_MS && w.n >= IP_MAX_FAILS;
    const userBlocked = !!uw && now - uw.since < IP_WINDOW_MS && uw.n >= USER_MAX_FAILS;
    if ((f && f.until > now) || ipBlocked || userBlocked) {
      const until = ipBlocked ? w!.since + IP_WINDOW_MS : userBlocked ? uw!.since + IP_WINDOW_MS : f!.until;
      return res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds: Math.ceil((until - now) / 1000) });
    }
    const charge = () => {                                                              // one more failed attempt from this address on this account
      const n = (failures.get(fk)?.n || 0) + 1;
      failures.set(fk, { n, until: now + Math.min(60_000, 500 * 2 ** n), last: now });
      const w2 = ipWindow.get(ip); if (!w2 || now - w2.since >= IP_WINDOW_MS) ipWindow.set(ip, { n: 1, since: now }); else w2.n++;
      const u2 = userWindow.get(uname.toLowerCase()); if (!u2 || now - u2.since >= IP_WINDOW_MS) userWindow.set(uname.toLowerCase(), { n: 1, since: now }); else u2.n++;
    };
    const st = store.peek().settings; const adm = st.admin;
    const local: UserRec | undefined = typeof username === 'string' ? (adm && username === adm.user ? adm : own(st.users, username)) : undefined;
    const rec = local && local.source !== 'ldap' ? local : undefined;                   // a directory user has no local password
    const pw = typeof password === 'string' ? password : '';
    const good = verifyPassword(pw, rec || (DUMMY ||= hashPassword('pg_arca-dummy-password')));
    let ok = !!rec && typeof password === 'string' && !!roleOf(store, username) && good;
    let viaLdap: { dn: string; role: Role; groups: string[] } | null = null; let viaLdapTried = false;
    const ldapCfg = ldapConfig(store);
    if (!ok && !rec && ldapCfg && typeof username === 'string' && pw) {                 // not a local account: ask the directory
      if (local?.disabled) { /* disabled here wins over the directory */ } else {
        charge(); viaLdapTried = true;                                                  // counted BEFORE asking the directory: parallel attempts cannot multiply the bind calls
        const r = await authenticateLdap(ldapCfg, username, pw);
        if (r.ok && r.role && r.dn) { viaLdap = { dn: r.dn, role: r.role, groups: r.groups || [] }; ok = true; }
        else if (r.error === 'directory_unavailable' || r.error === 'no_role') {
          await store.mutate(d => audit(d, { actor: uname, action: 'auth.login', status: 'FAILED', details: { ip, ldap: r.error, detail: r.detail } }));   // the detail (host names, certificate errors) stays in the audit log, for administrators
          return res.status(r.error === 'no_role' ? 403 : 503).json({ error: r.error, message: r.error === 'no_role' ? 'The directory knows you, but no group of yours is mapped to a console role.' : 'The directory cannot be reached right now: ask an administrator (the reason is in the audit log).' });
        }
      }
    }
    if (!ok) {
      if (!viaLdapTried) charge();
      await store.mutate(d => audit(d, { actor: uname, action: 'auth.login', status: 'FAILED', details: { ip } }));
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    failures.delete(fk);
    if (viaLdap) {                                                                     // the directory's answer of today is the user's role of today
      const v = viaLdap;
      await store.mutate(d => {
        const cur = own(d.settings.users, username);
        d.settings.users ||= {};
        d.settings.users[username] = { ...(cur || { createdAt: nowIso() }), user: username, salt: '', hash: '', role: v.role, source: 'ldap', dn: v.dn, lastLoginAt: nowIso(), disabled: false };
        audit(d, { actor: username, action: 'auth.login', status: 'OK', details: { ip, ldap: true, role: v.role, dn: v.dn } });
      });
    } else await store.mutate(d => audit(d, { actor: username, action: 'auth.login', status: 'OK', details: { ip } }));
    startSession(req, res, username);
    res.json({ ok: true, user: username, role: roleOf(store, username) });
  });

  // ---- LDAP / Active Directory settings (admin): stored with the bind password encrypted; a test endpoint says what a sign-in would do
  app.get('/api/auth/ldap', (_req: Request, res: Response) => { const c = (store.peek().settings as any).ldap || { enabled: false }; res.json({ ldap: { ...c, bindPasswordEnc: undefined, bindPasswordSet: !!c.bindPasswordEnc } }); });
  app.put('/api/auth/ldap', async (req: Request, res: Response) => {
    const b = req.body || {};
    const errs = validateLdap(b);
    if (errs.length) return res.status(400).json({ error: 'invalid_ldap', message: errs.join(' ') });
    await store.mutate(d => {
      const prev = (d.settings as any).ldap || {};
      const next: any = { enabled: !!b.enabled, url: String(b.url || '').trim(), startTls: !!b.startTls, caFile: String(b.caFile || '').trim(), insecureSkipVerify: !!b.insecureSkipVerify,
        bindDN: String(b.bindDN || '').trim(), baseDN: String(b.baseDN || '').trim(), userFilter: String(b.userFilter || '').trim(), userDnTemplate: String(b.userDnTemplate || '').trim(),
        groupAttr: String(b.groupAttr || '').trim(), groupBaseDN: String(b.groupBaseDN || '').trim(), groupFilter: String(b.groupFilter || '').trim(),
        roleMap: (Array.isArray(b.roleMap) ? b.roleMap : []).filter((m: any) => m && typeof m.group === 'string' && ROLES.includes(m.role)).map((m: any) => ({ group: m.group.trim(), role: m.role })),
        defaultRole: ['admin', 'operator', 'viewer', 'none'].includes(b.defaultRole) ? b.defaultRole : 'none', timeoutMs: Number(b.timeoutMs) > 0 ? Math.min(60000, Number(b.timeoutMs)) : 8000 };
      next.bindPasswordEnc = typeof b.bindPassword === 'string' && b.bindPassword !== '' ? encrypt(loadSecretKey(store.dir), b.bindPassword) : (b.clearBindPassword ? undefined : prev.bindPasswordEnc);
      (d.settings as any).ldap = next;
      audit(d, { actor: (req as any).actor, action: 'ldap.configure', status: 'OK', details: { enabled: next.enabled, url: next.url, baseDN: next.baseDN, roles: next.roleMap.length, defaultRole: next.defaultRole } });
    });
    res.json({ ok: true });
  });
  app.post('/api/auth/ldap/test', async (req: Request, res: Response) => {
    const { username, password } = req.body || {};
    const cfg = ldapConfig(store, true);
    if (!cfg) return res.status(400).json({ error: 'ldap_not_configured', message: 'Save the directory settings first.' });
    if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'invalid_request' });
    const r = await authenticateLdap(cfg, username, password);
    await store.mutate(d => audit(d, { actor: (req as any).actor, action: 'ldap.test', status: r.ok ? 'OK' : 'FAILED', details: { username, error: r.error, role: r.role } }));
    res.json({ ok: r.ok, role: r.role || null, dn: r.dn || null, groups: r.groups || [], error: r.error || null, detail: r.detail || null,
      note: r.ok ? `${username} would sign in as ${r.role}.` : r.error === 'no_role' ? 'Authenticated, but no group maps to a role and no default role is set.' : r.error === 'directory_unavailable' ? 'The directory could not be queried.' : 'The directory refused these credentials (or the filter matched no single entry).' });
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
    if (rec && (rec as any).source === 'ldap') return res.status(400).json({ error: 'directory_user', message: 'Your password is managed by the directory (LDAP / Active Directory), not by the console.' });
    if (!rec || typeof currentPassword !== 'string' || !verifyPassword(currentPassword, rec)) return res.status(403).json({ error: 'invalid_credentials' });
    if (typeof newPassword !== 'string' || newPassword.length < 12) return res.status(400).json({ error: 'weak_password' });
    const h = hashPassword(newPassword);
    await store.mutate(d => { if (isBoot) d.settings.admin = { ...d.settings.admin, ...h }; else d.settings.users[u] = { ...d.settings.users[u], ...h }; audit(d, { actor: u, action: 'auth.change_password', status: 'OK' }); });
    revokeSessionsOf(u);
    res.json({ ok: true });
  });

  // ---- user management (admin only: enforced by the permission table) ----
  const strip = (u: UserRec) => ({ user: u.user, role: u.role, disabled: !!u.disabled, createdAt: u.createdAt, source: u.source || 'local', lastLoginAt: u.lastLoginAt || null });
  const admins = (st: any) => 1 + Object.values(st.users || {}).filter((x: any) => x.role === 'admin' && !x.disabled).length;
  app.get('/api/users', (_req: Request, res: Response) => {
    const st = store.peek().settings;
    res.json({ users: [{ user: st.admin?.user, role: 'admin', disabled: false, bootstrap: true }, ...Object.values(st.users || {}).map((u: any) => strip(u))] });
  });
  app.post('/api/users', async (req: Request, res: Response) => {
    const { username, password, role } = req.body || {};
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.@-]{3,64}$/.test(username) || ['__proto__', 'constructor', 'prototype'].includes(username)) return res.status(400).json({ error: 'invalid_username' });
    if (typeof password !== 'string' || password.length < 12) return res.status(400).json({ error: 'weak_password', message: 'At least 12 characters.' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
    const h = hashPassword(password);
    const r = await store.mutate(d => {
      if (d.settings.admin?.user === username || own(d.settings.users, username)) return 'exists' as const;
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
      const u = own(d.settings.users, name);
      if (!u) return 'missing' as const;
      if (password && u.source === 'ldap') return 'directory_user' as const;
      const nextRole = role ?? u.role, nextDis = disabled ?? !!u.disabled;
      if (u.role === 'admin' && !u.disabled && (nextRole !== 'admin' || nextDis) && admins(d.settings) <= 1) return 'last_admin' as const;
      if (role !== undefined) u.role = role; if (disabled !== undefined) u.disabled = !!disabled;
      if (password) Object.assign(u, hashPassword(password));
      audit(d, { actor: (req as any).actor, action: 'user.update', status: 'OK', details: { username: name, role, disabled, passwordReset: !!password } });
      return 'ok' as const;
    });
    if (r === 'missing') return res.status(404).json({ error: 'not_found' });
    if (r === 'last_admin') return res.status(409).json({ error: 'last_admin', message: 'At least one active administrator must remain.' });
    if (r === 'directory_user') return res.status(400).json({ error: 'directory_user', message: 'This account signs in through the directory: it has no console password.' });
    revokeSessionsOf(name);
    res.json({ ok: true });
  });
  app.delete('/api/users/:name', async (req: Request, res: Response) => {
    const name = req.params.name;
    const r = await store.mutate(d => {
      const u = own(d.settings.users, name);
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
