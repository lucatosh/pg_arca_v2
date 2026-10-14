/** pg_hba helper logic for the console: description, duplicate / shadow / overlap analysis, safe ordering. Pure (no DOM, no network). */
export interface Rule { type: string; database: string; user: string; address: string; method: string; options?: string; comment?: string }

// ---------- addresses ----------
interface Net { v: 4 | 6; lo: bigint; hi: bigint; prefix: number }
function v4(s: string): bigint | null { const p = s.split('.'); if (p.length !== 4) return null; let n = 0n; for (const x of p) { if (!/^\d{1,3}$/.test(x) || +x > 255) return null; n = (n << 8n) | BigInt(+x); } return n; }
function v6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:]+$/.test(s) || s.split('::').length > 2) return null;
  const [h, t] = s.split('::'); const a = h ? h.split(':') : []; const b = t !== undefined && t ? t.split(':') : [];
  const miss = 8 - a.length - b.length; if ((t === undefined && a.length !== 8) || miss < 0 || (t !== undefined && miss < 1)) return null;
  let n = 0n; for (const g of [...a, ...Array(t === undefined ? 0 : miss).fill('0'), ...b]) { if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null; n = (n << 16n) | BigInt(parseInt(g, 16)); } return n;
}
export function parseNet(addr: string): Net | null {
  if (!addr || addr === 'all') return { v: 4, lo: 0n, hi: 0xffffffffn, prefix: 0 };
  const [ip, pfx] = addr.split('/');
  const a = v4(ip); if (a !== null) { const p = pfx === undefined ? 32 : +pfx; if (!/^\d+$/.test(pfx ?? '0') || p > 32) return null; const host = 32n - BigInt(p); const lo = (a >> host) << host; return { v: 4, lo, hi: lo | ((1n << host) - 1n), prefix: p }; }
  const b = v6(ip); if (b !== null) { const p = pfx === undefined ? 128 : +pfx; if (!/^\d+$/.test(pfx ?? '0') || p > 128) return null; const host = 128n - BigInt(p); const lo = (b >> host) << host; return { v: 6, lo, hi: lo | ((1n << host) - 1n), prefix: p }; }
  return null;
}
export const validCidr = (s: string) => !!s && s !== 'all' && parseNet(s) !== null && /[./:]/.test(s);
const isAll = (a: string) => a === 'all' || a === '0.0.0.0/0' || a === '::/0';
function addrCovers(a: string, b: string): boolean | null {     // true/false, null = cannot tell (host names, samenet…)
  if (a === 'all') return true;
  const x = parseNet(a), y = parseNet(b === 'all' ? '0.0.0.0/0' : b);
  if (!x || !y) return a === b ? true : null;
  if (b === 'all') return false;
  return x.v === y.v && x.lo <= y.lo && x.hi >= y.hi;
}
function overlap(a: string, b: string): boolean {
  const x = parseNet(a), y = parseNet(b); if (!x || !y) return a === b; if (a === 'all' || b === 'all') return true;
  return x.v === y.v && x.lo <= y.hi && y.lo <= x.hi;
}

// ---------- scopes ----------
const toks = (s: string) => s.split(',').map(t => t.trim().replace(/^"|"$/g, '')).filter(Boolean);
function listCovers(a: string, b: string): boolean {
  const A = toks(a), B = toks(b);
  if (A.includes('all')) return !B.includes('replication');       // 'all' never matches the replication pseudo-database
  return B.every(t => A.includes(t));
}
const typeCovers = (a: string, b: string) => a === b || (a === 'host' && (b === 'hostssl' || b === 'hostnossl')) || (a === 'hostgssenc' && b === 'hostgssenc');
export function covers(a: Rule, b: Rule): boolean {
  if (!typeCovers(a.type, b.type)) return false;
  if (a.type === 'local') return listCovers(a.database, b.database) && listCovers(a.user, b.user);
  const dbOk = b.database.split(',').some(t => t.trim() === 'replication') ? (toks(a.database).includes('replication') && toks(b.database).every(t => toks(a.database).includes(t))) : listCovers(a.database, b.database);
  return dbOk && listCovers(a.user, b.user) && addrCovers(a.address, b.address) === true;
}
function intersects(a: Rule, b: Rule): boolean {
  if (!(typeCovers(a.type, b.type) || typeCovers(b.type, a.type))) return false;
  const dbA = toks(a.database), dbB = toks(b.database);
  const dbI = dbA.includes('replication') !== dbB.includes('replication') ? false : (dbA.includes('all') || dbB.includes('all') || dbA.some(t => dbB.includes(t)));
  const usA = toks(a.user), usB = toks(b.user);
  const usI = usA.includes('all') || usB.includes('all') || usA.some(t => usB.includes(t)) || usA.some(t => t.startsWith('+')) || usB.some(t => t.startsWith('+'));
  return dbI && usI && (a.type === 'local' || overlap(a.address, b.address));
}
export const key = (r: Rule) => [r.type, r.database, r.user, r.address, r.method, r.options || ''].join('|');

// ---------- analysis ----------
export interface Issue { index: number; level: 'error' | 'warn' | 'info'; code: 'duplicate' | 'redundant' | 'shadowed' | 'overlap'; with: number; message: string }
/** `rules` in evaluation order (earlier wins). Issues refer to indexes in this array. */
export function analyze(rules: Rule[]): Issue[] {
  const out: Issue[] = [];
  rules.forEach((r, i) => {
    for (let j = 0; j < i; j++) {
      const e = rules[j];
      if (key(e) === key(r)) { out.push({ index: i, level: 'error', code: 'duplicate', with: j, message: `Duplicate of rule ${j + 1}.` }); break; }
      if (covers(e, r)) {
        const same = (e.method === 'reject') === (r.method === 'reject');
        out.push(same ? { index: i, level: 'warn', code: 'redundant', with: j, message: `Redundant: rule ${j + 1} (${e.address || 'local'}) already covers these connections.` }
                      : { index: i, level: 'error', code: 'shadowed', with: j, message: `Never reached: rule ${j + 1} already ${e.method === 'reject' ? 'rejects' : 'allows'} these connections before this one.` });
        break;
      }
    }
    for (let j = i + 1; j < rules.length; j++) {
      const e = rules[j];
      if (!covers(r, e) && !covers(e, r) && intersects(r, e) && (r.method === 'reject') !== (e.method === 'reject'))
        out.push({ index: i, level: 'info', code: 'overlap', with: j, message: `Overlaps rule ${j + 1} with the opposite outcome: the higher one wins.` });
    }
  });
  return out;
}

// ---------- ordering ----------
const typeRank = (t: string) => (t === 'local' ? 0 : t === 'hostssl' || t === 'hostgssenc' ? 1 : t === 'hostnossl' || t === 'hostnogssenc' ? 2 : 3);
function breadth(r: Rule): number { if (r.type === 'local') return 0; const n = parseNet(r.address); return n ? (r.address === 'all' ? 0 : n.prefix) : 30; }   // larger = narrower
const scopeSpec = (s: string) => (toks(s).includes('all') ? 0 : 1);
/** 'specific' (default, correct for first-match: narrow exceptions before broad rules) or 'wide' (broad networks first — narrower rules after a covering one become unreachable and are flagged by analyze()). */
export function sortRules<T extends Rule>(rules: T[], mode: 'specific' | 'wide' = 'specific'): T[] {
  const dir = mode === 'specific' ? -1 : 1;
  return rules.map((r, i) => ({ r, i })).sort((a, b) => {
    const A = a.r, B = b.r;
    return typeRank(A.type) - typeRank(B.type) || dir * (breadth(A) - breadth(B)) || (A.method === 'reject' ? 0 : 1) - (B.method === 'reject' ? 0 : 1) || scopeSpec(B.user) - scopeSpec(A.user) || scopeSpec(B.database) - scopeSpec(A.database) || a.i - b.i;
  }).map(x => x.r);
}

// ---------- plain-language description ----------
const METHOD: Record<string, string> = { 'scram-sha-256': 'SCRAM password', md5: 'MD5 password (deprecated)', password: 'clear-text password (discouraged)', trust: 'NO password', peer: 'operating system user (peer)', cert: 'client certificate', reject: 'REJECTED', ident: 'ident', ldap: 'LDAP', gss: 'Kerberos', pam: 'PAM', radius: 'RADIUS', sspi: 'SSPI', bsd: 'BSD' };
const who = (u: string) => toks(u).map(t => t === 'all' ? 'every user' : t.startsWith('+') ? `the members of role ${t.slice(1)}` : `user ${t}`).join(', ');
const what = (d: string) => toks(d).map(t => t === 'all' ? 'every database' : t === 'replication' ? 'replication' : t === 'sameuser' ? 'the database with the user’s name' : t === 'samerole' ? 'the databases of its roles' : `database ${t}`).join(', ');
const where = (a: string) => a === 'all' || a === '0.0.0.0/0' || a === '::/0' ? 'from any address' : a === 'samehost' ? 'from the same host' : a === 'samenet' ? 'from the same subnet' : a === '127.0.0.1/32' || a === '::1/128' ? 'from this server itself (loopback)' : /\/(32|128)$/.test(a) ? `from host ${a.replace(/\/\d+$/, '')}` : validCidr(a) ? `from network ${a}${hostCount(a)}` : `from ${a}`;
function hostCount(a: string): string { const n = parseNet(a); if (!n || n.v !== 4) return ''; const c = Number(n.hi - n.lo + 1n); return c > 1 ? ` (${c.toLocaleString('en-GB')} addresses)` : ''; }
export function describe(r: Rule): string {
  const enc = r.type === 'hostssl' ? ', TLS only' : r.type === 'hostnossl' ? ', WITHOUT TLS only' : r.type === 'host' ? ', with or without TLS' : '';
  const m = METHOD[r.method] || r.method;
  if (r.method === 'reject') return `Rejects ${who(r.user)} on ${what(r.database)}${r.type === 'local' ? ' from the local socket' : ' ' + where(r.address)}${enc}.`;
  if (r.type === 'local') return `${cap(who(r.user))} can use ${what(r.database)} from the local socket, authenticated by ${m}.`;
  return `${cap(who(r.user))} can use ${what(r.database)} ${where(r.address)}${enc}, authenticated by ${m}.`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export function tag(r: Rule): { label: string; kind: 'ok' | 'warn' | 'bad' | 'info' } {
  if (r.method === 'reject') return { label: 'Block', kind: 'bad' };
  if (r.method === 'trust') return { label: 'No password', kind: 'bad' };
  if (toks(r.database).includes('replication')) return { label: 'Replication', kind: 'info' };
  if (r.type === 'local') return { label: 'Local', kind: 'info' };
  if (r.user.includes('+') ) return { label: 'Group', kind: 'info' };
  if (isAll(r.address)) return { label: 'Open to all', kind: 'warn' };
  if (r.type === 'host' || r.type === 'hostnossl') return { label: 'Not encrypted', kind: 'warn' };
  return { label: 'Access', kind: 'ok' };
}

// ---------- effective rows from pg_hba_file_rules -> Rule ----------
export function fromEffective(row: any): Rule {
  const arr = (x: any) => Array.isArray(x) ? x.join(',') : String(x ?? '');
  let address = row.address || '';
  if (address && row.netmask) { const m = v4(row.netmask); if (m !== null) { let p = 0; for (let b = 31n; b >= 0n; b--) { if ((m >> b) & 1n) p++; else break; } address = `${address}/${p}`; } }
  else if (address && !address.includes('/') && v4(address) !== null) address += '/32';
  return { type: row.type, database: arr(row.database), user: arr(row.user_name), address, method: row.auth_method, options: arr(row.options).replace(/,/g, ' ') };
}
export function fill(tpl: { rules: Rule[] }, vars: Record<string, string>): Rule[] {
  return tpl.rules.map(r => { const f = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? ''); return { ...r, database: f(r.database), user: f(r.user), address: f(r.address), comment: f(r.comment || '') }; });
}

// ---- temporary rules: the expiry travels in the comment as [until=YYYY-MM-DDTHH:MMZ] (the agent removes the rule after that instant)
const UNTIL = /\s*\[until=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z\]/;
export const untilOf = (comment?: string): number | null => { const m = UNTIL.exec(comment || ''); return m ? Date.parse(m[1] + ':00Z') : null; };
export const stripUntil = (comment?: string) => (comment || '').replace(UNTIL, '').trim();
export const withUntil = (comment: string | undefined, ms: number | null) => { const base = stripUntil(comment); return ms == null ? base : `${base} [until=${new Date(ms).toISOString().slice(0, 16)}Z]`.trim(); };
export const untilLabel = (ms: number, now = Date.now()) => { const d = ms - now; if (d <= 0) return 'expired'; const m = Math.round(d / 60000); return m < 60 ? `expires in ${m} min` : m < 2880 ? `expires in ${Math.round(m / 60)} h` : `expires in ${Math.round(m / 1440)} days`; };

// ---------- cluster access matrix: every node must be able to reach every node ----------
/** What a cluster needs in pg_hba so that any member can become the primary: the replication user from every node (streaming replication,
 *  pg_rewind, pg_basebackup when a replica is re-cloned) and the superuser from every node (Patroni / the console administering members).
 *  One /32 per node: narrow, explicit, and it keeps working when the wider rule someone wrote by hand is changed. */
export interface AccessNeed { kind: 'replication' | 'admin'; from: string; rule: Rule }
export interface AccessOpts { replUser: string; superuser: string; ssl: boolean; method: string; extraNets?: string[] }
const hostNet = (h: string): string | null => {
  const ip = h.split('/')[0];
  if (!ip || ip === 'localhost') return null;
  if (parseNet(ip) && /[.:]/.test(ip)) return ip.includes(':') ? `${ip}/128` : `${ip}/32`;
  return null;                                                   // a host name: PostgreSQL would resolve it, but a rule by name hides which address is allowed
};
export function clusterNeeds(nodes: { name: string; host?: string }[], o: AccessOpts): AccessNeed[] {
  const type = o.ssl ? 'hostssl' : 'host';
  const out: AccessNeed[] = [];
  const seen = new Set<string>();
  const push = (from: string, net: string) => {
    if (seen.has(net)) return; seen.add(net);
    if (o.replUser) out.push({ kind: 'replication', from, rule: { type, database: 'replication', user: o.replUser, address: net, method: o.method, comment: `Replication from ${from}` } });
    if (o.superuser) out.push({ kind: 'admin', from, rule: { type, database: 'all', user: o.superuser, address: net, method: o.method, comment: `Administration from ${from}` } });
  };
  for (const n of nodes) { const net = hostNet(String(n.host || '')); if (net) push(n.name, net); }
  for (const x of o.extraNets || []) if (validCidr(x)) push(x, x);
  return out;
}
/** First-match semantics, like PostgreSQL: the first rule whose scope contains the need decides. */
export function accessCoverage(all: Rule[], needs: AccessNeed[]): { need: AccessNeed; by: number | null; blocked: boolean }[] {
  return needs.map(need => {
    const i = all.findIndex(r => covers(r, need.rule));
    return { need, by: i >= 0 ? i : null, blocked: i >= 0 && all[i].method === 'reject' };
  });
}
