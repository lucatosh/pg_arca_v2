/**
 * Sign-in through LDAP / Active Directory, with no dependency: the three LDAP operations the console needs (simple bind, search, unbind)
 * encoded by hand in BER (RFC 4511). ldap:// with optional StartTLS, or ldaps://. Verified TLS by default (a CA file for private PKIs).
 *
 * Flow (authenticateLdap): [service bind] -> search the user by filter (or build the DN from a template) -> bind as the user with the
 * typed password -> read the group membership (memberOf, or a group search) -> role from the group map, else the default role.
 */
import net from 'net';
import tls from 'tls';
import fs from 'fs';

export interface LdapConfig {
  enabled: boolean;
  url: string;                       // ldap://host[:389] | ldaps://host[:636]
  startTls?: boolean;                // ldap:// then STARTTLS (recommended when ldaps is not offered)
  caFile?: string;                   // PEM of the directory's CA (private PKI); empty = system CAs
  insecureSkipVerify?: boolean;      // lab only
  bindDN?: string;                   // service account for the user search (empty = anonymous search, or DN template without search)
  bindPassword?: string;             // stored encrypted (settings.ldap.bindPasswordEnc); plain only in memory
  baseDN: string;                    // where users are searched
  userFilter?: string;               // (sAMAccountName={user}) | (uid={user}) | (&(objectClass=person)(mail={user}))
  userDnTemplate?: string;           // alternative to the search: uid={user},ou=people,dc=example,dc=com  or {user}@example.com (AD UPN)
  groupAttr?: string;                // memberOf (AD, OpenLDAP with memberof overlay); empty = group search below
  groupBaseDN?: string;              // group search: (member={dn}) under this base
  groupFilter?: string;              // default (|(member={dn})(uniqueMember={dn}))
  roleMap?: { group: string; role: 'admin' | 'operator' | 'viewer' }[];   // group DN (case-insensitive) -> console role; first match in order admin > operator > viewer
  defaultRole?: 'admin' | 'operator' | 'viewer' | 'none';                 // for users in no mapped group; 'none' = refused
  timeoutMs?: number;
}

export interface LdapResult { ok: boolean; dn?: string; role?: 'admin' | 'operator' | 'viewer'; groups?: string[]; error?: string; detail?: string }

// ---------------------------------------------------------------- BER
const len = (n: number): Buffer => {
  if (n < 128) return Buffer.from([n]);
  const b: number[] = []; let x = n; while (x > 0) { b.unshift(x & 0xff); x = Math.floor(x / 256); }
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const int = (n: number, tag = 0x02): Buffer => {
  const b: number[] = []; let x = n; do { b.unshift(x & 0xff); x = Math.floor(x / 256); } while (x > 0);
  if (b[0] & 0x80) b.unshift(0);
  return tlv(tag, Buffer.from(b));
};
const str = (s: string, tag = 0x04): Buffer => tlv(tag, Buffer.from(s, 'utf8'));
const seq = (parts: Buffer[], tag = 0x30): Buffer => tlv(tag, Buffer.concat(parts));
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0]));

interface Tlv { tag: number; body: Buffer; end: number }
function readTlv(b: Buffer, at = 0): Tlv {
  if (at + 2 > b.length) throw new Error('short');
  const tag = b[at]; let l = b[at + 1]; let p = at + 2;
  if (l & 0x80) { const n = l & 0x7f; if (n > 4 || p + n > b.length) throw new Error('bad length'); l = 0; for (let i = 0; i < n; i++) l = l * 256 + b[p + i]; p += n; }
  if (p + l > b.length) throw new Error('short');
  return { tag, body: b.subarray(p, p + l), end: p + l };
}
function readSeq(body: Buffer): Tlv[] { const out: Tlv[] = []; let p = 0; while (p < body.length) { const t = readTlv(body, p); out.push(t); p = t.end; } return out; }
const readInt = (t: Tlv): number => { let v = 0; for (const x of t.body) v = v * 256 + x; return v; };

/** The search filter string -> BER. Supports & | ! (a=v) (a=*) (a=*x*) is NOT supported (no substrings): equality and presence cover the sign-in cases. */
export function encodeFilter(f: string): Buffer {
  let p = 0;
  const parse = (): Buffer => {
    if (f[p] !== '(') throw new Error(`filter: "(" expected at ${p} in ${f}`);
    p++;
    const c = f[p];
    if (c === '&' || c === '|') { p++; const parts: Buffer[] = []; while (f[p] === '(') parts.push(parse()); expect(')'); return seq(parts, c === '&' ? 0xa0 : 0xa1); }
    if (c === '!') { p++; const inner = parse(); expect(')'); return tlv(0xa2, inner); }
    const eq = f.indexOf('=', p); const close = f.indexOf(')', p);
    if (eq < 0 || close < 0 || eq > close) throw new Error(`filter: attr=value expected at ${p} in ${f}`);
    const attr = f.slice(p, eq); const val = f.slice(eq + 1, close); p = close + 1;
    if (val === '*') return str(attr, 0x87);
    return seq([str(attr), str(val)], 0xa3);
  };
  const expect = (ch: string) => { if (f[p] !== ch) throw new Error(`filter: "${ch}" expected at ${p} in ${f}`); p++; };
  const out = parse();
  if (p !== f.length) throw new Error(`filter: trailing characters in ${f}`);
  return out;
}

/** Escapes a value for use inside a filter (RFC 4515) and inside a DN (RFC 4514). */
export const escFilter = (s: string) => s.replace(/[\\*()\0]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
export const escDn = (s: string) => s.replace(/^[ #]|[,+"\\<>;]|[ ]$/g, c => '\\' + c);

/** BER helpers, for tests that play the directory's side. */
export const _ber = { tlv, int, str, seq, bool, readTlv, readSeq, readInt };

// ---------------------------------------------------------------- connection
class Conn {
  private sock!: net.Socket | tls.TLSSocket;
  private buf = Buffer.alloc(0);
  private waiters = new Map<number, { resolve: (msgs: Tlv[]) => void; reject: (e: Error) => void; msgs: Tlv[] }>();
  private id = 0;
  private closed = false;
  constructor(private cfg: LdapConfig) {}

  async connect(): Promise<void> {
    const u = new URL(this.cfg.url);
    const secure = u.protocol === 'ldaps:';
    if (u.protocol !== 'ldap:' && !secure) throw new Error('url must start with ldap:// or ldaps://');
    const host = u.hostname; const port = Number(u.port) || (secure ? 636 : 389);
    const tlsOpts: tls.ConnectionOptions = { host, rejectUnauthorized: !this.cfg.insecureSkipVerify };
    if (!net.isIP(host)) tlsOpts.servername = host;                                   // SNI only for names (an IP in SNI is not allowed by RFC 6066)
    if (this.cfg.caFile) tlsOpts.ca = fs.readFileSync(this.cfg.caFile);
    const timeout = this.cfg.timeoutMs || 8000;
    this.sock = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
      const s: net.Socket | tls.TLSSocket = secure ? tls.connect({ ...tlsOpts, port }) : net.connect({ host, port });
      const t = setTimeout(() => { s.destroy(); reject(new Error(`connection to ${host}:${port} timed out`)); }, timeout);
      s.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(t); resolve(s); });
      s.once('error', e => { clearTimeout(t); reject(e); });
    });
    this.attach();
    if (!secure && this.cfg.startTls) {
      await this.request(tlv(0x77, Buffer.concat([str('1.3.6.1.4.1.1466.20037', 0x80)])), 0x78);   // ExtendedRequest StartTLS
      const plain = this.sock as net.Socket; plain.removeAllListeners('data');
      this.sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const s = tls.connect({ ...tlsOpts, socket: plain });
        s.once('secureConnect', () => resolve(s)); s.once('error', reject);
      });
      this.attach();
    }
  }

  private attach() {
    this.sock.setTimeout(this.cfg.timeoutMs || 8000, () => this.fail(new Error('directory did not answer in time')));
    this.sock.on('data', (d: Buffer) => this.onData(d));
    this.sock.on('error', (e: Error) => this.fail(e));
    this.sock.on('close', () => this.fail(new Error('connection closed by the directory')));
  }
  private fail(e: Error) { if (this.closed) return; this.closed = true; for (const w of this.waiters.values()) w.reject(e); this.waiters.clear(); try { this.sock.destroy(); } catch { /* closed */ } }
  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      let m: Tlv;
      try { m = readTlv(this.buf, 0); } catch { return; }                           // incomplete message: wait for more
      this.buf = this.buf.subarray(m.end);
      let id: number, op: Tlv;
      try { const parts = readSeq(m.body); if (parts.length < 2) continue; id = readInt(parts[0]); op = parts[1]; }
      catch (e: any) { this.fail(new Error(`malformed answer from the directory (${e?.message || e})`)); return; }     // a bad server must not crash the console
      const w = this.waiters.get(id); if (!w) continue;
      w.msgs.push(op);
      if (op.tag !== 0x64 && op.tag !== 0x73) { this.waiters.delete(id); w.resolve(w.msgs); }     // entries and references keep the request open
    }
  }
  /** Sends one protocol op; resolves with every op received for that id (search: entries + done). */
  request(op: Buffer, _expectTag?: number): Promise<Tlv[]> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject, msgs: [] });
      this.sock.write(seq([int(id), op]));
    });
  }
  async bind(dn: string, password: string): Promise<{ code: number; message: string }> {
    const [r] = await this.request(seq([int(3), str(dn), str(password, 0x80)], 0x60));
    const p = readSeq(r.body);
    return { code: readInt(p[0]), message: p[2] ? p[2].body.toString('utf8') : '' };
  }
  async search(base: string, filter: string, attrs: string[], scope = 2): Promise<{ dn: string; attrs: Record<string, string[]> }[]> {
    const msgs = await this.request(seq([str(base), int(scope, 0x0a), int(0, 0x0a), int(0), int(0), bool(false), encodeFilter(filter), seq(attrs.map(a => str(a)))], 0x63));
    const out: { dn: string; attrs: Record<string, string[]> }[] = [];
    for (const m of msgs) {
      if (m.tag === 0x64) {
        const p = readSeq(m.body); const dn = p[0].body.toString('utf8'); const attrsOut: Record<string, string[]> = {};
        for (const a of readSeq(p[1].body)) { const ap = readSeq(a.body); attrsOut[ap[0].body.toString('utf8').toLowerCase()] = readSeq(ap[1].body).map(v => v.body.toString('utf8')); }
        out.push({ dn, attrs: attrsOut });
      } else if (m.tag === 0x65) {
        const p = readSeq(m.body); const code = readInt(p[0]);
        if (code !== 0) throw new Error(`search failed (code ${code}): ${p[2]?.body.toString('utf8') || ''}`);
      }
    }
    return out;
  }
  close() { if (this.closed || !this.sock) { this.closed = true; return; } try { this.sock.write(seq([int(++this.id), tlv(0x42, Buffer.alloc(0))])); } catch { /* ignore */ } this.closed = true; this.sock.end(); this.sock.destroy(); }
}

// ---------------------------------------------------------------- the sign-in
const ROLE_RANK = { admin: 3, operator: 2, viewer: 1 } as const;

export function roleFromGroups(cfg: LdapConfig, groups: string[]): 'admin' | 'operator' | 'viewer' | null {
  const have = new Set(groups.map(g => g.toLowerCase()));
  let best: 'admin' | 'operator' | 'viewer' | null = null;
  for (const m of cfg.roleMap || []) if (m?.group && m.role && have.has(m.group.toLowerCase()) && (!best || ROLE_RANK[m.role] > ROLE_RANK[best])) best = m.role;
  if (best) return best;
  const d = cfg.defaultRole || 'none';
  return d === 'none' ? null : d;
}

export async function authenticateLdap(cfg: LdapConfig, username: string, password: string): Promise<LdapResult> {
  if (!password) return { ok: false, error: 'invalid_credentials' };
  if (!/^[^\s,=+<>#;\\"]{1,128}$/.test(username) && !/^[^\s]{1,128}$/.test(username)) return { ok: false, error: 'invalid_credentials' };
  const c = new Conn(cfg);
  try {
    await c.connect();
    let dn: string;
    let entry: { dn: string; attrs: Record<string, string[]> } | null = null;
    if (cfg.userDnTemplate && !cfg.userFilter) {
      dn = cfg.userDnTemplate.replace(/\{user\}/g, cfg.userDnTemplate.includes('@') ? username : escDn(username));
    } else {
      if (cfg.bindDN) { const b = await c.bind(cfg.bindDN, cfg.bindPassword || ''); if (b.code !== 0) return { ok: false, error: 'directory_unavailable', detail: `service account bind failed (code ${b.code}): ${b.message}` }; }
      const filter = (cfg.userFilter || '(uid={user})').replace(/\{user\}/g, escFilter(username));
      const attrs = [cfg.groupAttr || 'memberOf', 'cn', 'mail'];
      const found = await c.search(cfg.baseDN, filter, attrs);
      if (found.length !== 1) return { ok: false, error: 'invalid_credentials', detail: found.length ? 'the filter matched several entries' : 'no such user in the directory' };
      entry = found[0]; dn = entry.dn;
    }
    const b = await c.bind(dn, password);
    if (b.code !== 0) return { ok: false, error: 'invalid_credentials', detail: `bind as ${dn} refused (code ${b.code})` };
    let groups: string[] = [];
    const ga = (cfg.groupAttr || 'memberOf').toLowerCase();
    if (entry && entry.attrs[ga]) groups = entry.attrs[ga];
    else if (cfg.groupBaseDN) {
      const gf = (cfg.groupFilter || '(|(member={dn})(uniqueMember={dn}))').replace(/\{dn\}/g, escFilter(dn)).replace(/\{user\}/g, escFilter(username));
      try { groups = (await c.search(cfg.groupBaseDN, gf, ['cn'])).map(g => g.dn); } catch (e: any) { return { ok: false, error: 'directory_unavailable', detail: `group search failed: ${e.message}` }; }
    } else if (!entry && (cfg.groupAttr || 'memberOf')) {
      try { const me = await c.search(dn, '(objectClass=*)', [cfg.groupAttr || 'memberOf'], 0); if (me[0]) groups = me[0].attrs[ga] || []; } catch { /* no read access to own entry: no groups */ }
    }
    const role = roleFromGroups(cfg, groups);
    if (!role) return { ok: false, error: 'no_role', dn, groups, detail: 'authenticated, but in no group that maps to a console role and no default role is set' };
    return { ok: true, dn, role, groups };
  } catch (e: any) {
    return { ok: false, error: 'directory_unavailable', detail: e.message };
  } finally {
    c.close();
  }
}

/** For the settings page: what would happen for a given user (never creates a session). */
export async function testLdap(cfg: LdapConfig, username: string, password: string): Promise<LdapResult> {
  return authenticateLdap(cfg, username, password);
}
