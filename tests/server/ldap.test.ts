import assert from 'assert'; import net from 'net'; import tls from 'tls'; import fs from 'fs'; import os from 'os'; import path from 'path'; import { execFileSync } from 'child_process';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { authenticateLdap, encodeFilter, escFilter, roleFromGroups, _ber } from '../../server/ldap';
import { mountAuthRoutes, requireAdmin, requiredRole } from '../../server/auth';

/** A directory that speaks just enough LDAP: simple bind against a table, subtree search by equality filter on uid/sAMAccountName, memberOf. */
function fakeDirectory(opts: { tls?: { key: Buffer; cert: Buffer } } = {}) {
  const { tlv, int, str, seq, readTlv, readSeq, readInt } = _ber;
  const people: Record<string, { dn: string; password: string; memberOf: string[] }> = {
    alice: { dn: 'uid=alice,ou=people,dc=corp,dc=example', password: 'alice-secret-1', memberOf: ['cn=dba,ou=groups,dc=corp,dc=example', 'cn=staff,ou=groups,dc=corp,dc=example'] },
    bob: { dn: 'uid=bob,ou=people,dc=corp,dc=example', password: 'bob-secret-123', memberOf: ['cn=staff,ou=groups,dc=corp,dc=example'] },
    carol: { dn: 'uid=carol,ou=people,dc=corp,dc=example', password: 'carol-secret-1', memberOf: [] },
  };
  const service = { dn: 'cn=console,ou=services,dc=corp,dc=example', password: 'svc-pass' };
  const seen: string[] = [];
  const result = (tag: number, code: number, msg = '') => tlv(tag, Buffer.concat([int(code, 0x0a), str(''), str(msg)]));
  const handle = (sock: net.Socket) => {
    let buf = Buffer.alloc(0); let bound: string | null = null;
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        let m; try { m = readTlv(buf, 0); } catch { return; }
        buf = buf.subarray(m.end);
        const [idT, op] = readSeq(m.body); const id = readInt(idT);
        const reply = (b: Buffer) => sock.write(seq([int(id), b]));
        if (op.tag === 0x60) {                                                                 // bind
          const p = readSeq(op.body); const dn = p[1].body.toString(); const pw = p[2].body.toString();
          seen.push(`bind ${dn}`);
          const who = dn === service.dn ? service : Object.values(people).find(x => x.dn.toLowerCase() === dn.toLowerCase());
          if (dn === '' && pw === '') { bound = 'anonymous'; reply(result(0x61, 0)); }
          else if (who && who.password === pw) { bound = dn; reply(result(0x61, 0)); }
          else reply(result(0x61, 49, 'invalid credentials'));
        } else if (op.tag === 0x63) {                                                          // search
          const p = readSeq(op.body); const base = p[0].body.toString(); const scope = readInt(p[1]); const filter = p[6];
          seen.push(`search ${base} scope=${scope} bound=${bound}`);
          if (!bound) { reply(result(0x65, 50, 'insufficient access: bind first')); continue; }
          const eq = (f: any): [string, string] | null => { if (f.tag === 0xa3) { const q = readSeq(f.body); return [q[0].body.toString().toLowerCase(), q[1].body.toString()]; } if (f.tag === 0xa0 || f.tag === 0xa1) { for (const x of readSeq(f.body)) { const r = eq(x); if (r && r[0] !== 'objectclass') return r; } } return null; };
          const entries: { dn: string; attrs: Record<string, string[]> }[] = [];
          if (scope === 0) { const who = Object.values(people).find(x => x.dn.toLowerCase() === base.toLowerCase()); if (who) entries.push({ dn: who.dn, attrs: { memberOf: who.memberOf } }); }
          else { const q = eq(filter); if (q && (q[0] === 'uid' || q[0] === 'samaccountname') && people[q[1]]) { const w = people[q[1]]; entries.push({ dn: w.dn, attrs: { memberOf: w.memberOf, cn: [q[1]] } }); } }
          for (const e of entries) reply(tlv(0x64, Buffer.concat([str(e.dn), seq(Object.entries(e.attrs).map(([k, vs]) => seq([str(k), seq(vs.map(v => str(v)), 0x31)])))])));
          reply(result(0x65, 0));
        } else if (op.tag === 0x42) { sock.end(); }                                           // unbind
        else reply(result(0x65, 2, 'unsupported'));
      }
    });
    sock.on('error', () => { /* client gone */ });
  };
  const srv = opts.tls ? tls.createServer({ key: opts.tls.key, cert: opts.tls.cert }, handle) : net.createServer(handle);
  return new Promise<{ port: number; seen: string[]; close: () => void }>(resolve => srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as any).port, seen, close: () => srv.close() })));
}

(async () => {
  // ---- filter encoding and escaping
  assert.deepStrictEqual([...encodeFilter('(uid=alice)')].slice(0, 2), [0xa3, 12]);
  assert.strictEqual(encodeFilter('(&(objectClass=person)(uid=bob))')[0], 0xa0);
  assert.strictEqual(encodeFilter('(|(a=1)(!(b=*)))')[0], 0xa1);
  assert.throws(() => encodeFilter('(uid=alice'), /expected/);
  assert.strictEqual(escFilter('a*b(c)\\'), 'a\\2ab\\28c\\29\\5c');
  assert.strictEqual(roleFromGroups({ roleMap: [{ group: 'CN=DBA,ou=groups,dc=corp,dc=example', role: 'admin' }, { group: 'cn=staff,ou=groups,dc=corp,dc=example', role: 'viewer' }], defaultRole: 'none' } as any, ['cn=staff,ou=groups,dc=corp,dc=example', 'cn=dba,ou=groups,dc=corp,dc=example']), 'admin', 'highest mapped role wins, case-insensitive');
  assert.strictEqual(roleFromGroups({ roleMap: [], defaultRole: 'viewer' } as any, []), 'viewer');
  assert.strictEqual(roleFromGroups({ roleMap: [], defaultRole: 'none' } as any, ['x']), null);

  // ---- plain ldap://, search with a service account, memberOf -> role
  const dir = await fakeDirectory();
  const base = { enabled: true, url: `ldap://127.0.0.1:${dir.port}`, bindDN: 'cn=console,ou=services,dc=corp,dc=example', bindPassword: 'svc-pass', baseDN: 'ou=people,dc=corp,dc=example', userFilter: '(uid={user})',
    roleMap: [{ group: 'cn=dba,ou=groups,dc=corp,dc=example', role: 'operator' as const }], defaultRole: 'viewer' as const, timeoutMs: 3000 };
  let r = await authenticateLdap(base, 'alice', 'alice-secret-1');
  assert.deepStrictEqual([r.ok, r.role, r.dn], [true, 'operator', 'uid=alice,ou=people,dc=corp,dc=example'], JSON.stringify(r));
  assert.deepStrictEqual(dir.seen.slice(-3), ['bind cn=console,ou=services,dc=corp,dc=example', 'search ou=people,dc=corp,dc=example scope=2 bound=cn=console,ou=services,dc=corp,dc=example', 'bind uid=alice,ou=people,dc=corp,dc=example']);
  r = await authenticateLdap(base, 'bob', 'bob-secret-123'); assert.deepStrictEqual([r.ok, r.role], [true, 'viewer'], 'no mapped group: default role');
  r = await authenticateLdap({ ...base, defaultRole: 'none' }, 'carol', 'carol-secret-1'); assert.deepStrictEqual([r.ok, r.error], [false, 'no_role']);
  r = await authenticateLdap(base, 'alice', 'wrong'); assert.deepStrictEqual([r.ok, r.error], [false, 'invalid_credentials']);
  r = await authenticateLdap(base, 'nobody', 'x'); assert.deepStrictEqual([r.ok, r.error], [false, 'invalid_credentials']);
  r = await authenticateLdap(base, 'alice', ''); assert.deepStrictEqual([r.ok, r.error], [false, 'invalid_credentials'], 'an empty password never becomes an anonymous bind');
  r = await authenticateLdap({ ...base, userFilter: '(uid={user})', bindDN: 'cn=console,ou=services,dc=corp,dc=example', bindPassword: 'bad' }, 'alice', 'alice-secret-1');
  assert.deepStrictEqual([r.ok, r.error], [false, 'directory_unavailable'], 'service account refused: a configuration error, not the user\'s');
  r = await authenticateLdap(base, 'ali*ce)(uid=alice', 'alice-secret-1'); assert.strictEqual(r.ok, false, 'filter injection escaped');
  // DN template, no search: groups read from the user's own entry
  r = await authenticateLdap({ ...base, userFilter: '', bindDN: '', userDnTemplate: 'uid={user},ou=people,dc=corp,dc=example' }, 'alice', 'alice-secret-1');
  assert.deepStrictEqual([r.ok, r.role, r.groups?.length], [true, 'operator', 2], JSON.stringify(r));
  // unreachable directory
  r = await authenticateLdap({ ...base, url: 'ldap://127.0.0.1:1', timeoutMs: 1500 }, 'alice', 'alice-secret-1'); assert.deepStrictEqual([r.ok, r.error], [false, 'directory_unavailable']);
  dir.close();

  // ---- ldaps:// with a private CA: verified (wrong CA -> unavailable; right CA -> ok; insecure flag -> ok)
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'ldap-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(td, 'k.pem'), '-out', path.join(td, 'c.pem'), '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '2'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(td, 'k2.pem'), '-out', path.join(td, 'other.pem'), '-subj', '/CN=other', '-days', '2'], { stdio: 'ignore' });
    const sdir = await fakeDirectory({ tls: { key: fs.readFileSync(path.join(td, 'k.pem')), cert: fs.readFileSync(path.join(td, 'c.pem')) } });
    const sbase = { ...base, url: `ldaps://127.0.0.1:${sdir.port}` };
    r = await authenticateLdap({ ...sbase, caFile: path.join(td, 'other.pem') }, 'alice', 'alice-secret-1'); assert.deepStrictEqual([r.ok, r.error], [false, 'directory_unavailable'], 'certificate not trusted');
    r = await authenticateLdap({ ...sbase, caFile: path.join(td, 'c.pem') }, 'alice', 'alice-secret-1'); assert.deepStrictEqual([r.ok, r.role], [true, 'operator'], JSON.stringify(r));
    r = await authenticateLdap({ ...sbase, insecureSkipVerify: true }, 'bob', 'bob-secret-123'); assert.strictEqual(r.ok, true);
    sdir.close();
  } catch (e: any) { if (/openssl/.test(String(e.message)) || e.code === 'ENOENT') console.log('  (ldaps part skipped: no openssl)'); else throw e; }

  // ---- console routes: settings (admin only, password encrypted), login falls back to the directory, directory users have no local password
  const dir2 = await fakeDirectory();
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ldapc-'))); const app = new MiniApp();
  app.use(requireAdmin(store)); mountAuthRoutes(app, store);
  const call = (m: string, u: string, body?: any, cookie?: string) => app.call(m, u, { body, headers: cookie ? { cookie } : {} });
  const setup = await call('POST', '/api/auth/setup', { username: 'admin', password: 'correct-horse-battery' }); const A = setup.headers['set-cookie'].split(';')[0];
  assert.strictEqual(requiredRole('GET', '/api/auth/ldap'), 'admin'); assert.strictEqual(requiredRole('PUT', '/api/auth/ldap'), 'admin'); assert.strictEqual(requiredRole('POST', '/api/auth/ldap/test'), 'admin');
  // the directory settings are under /api/auth/ but are NOT sign-in routes: without a session (or with a lower role) they are refused, otherwise
  // anyone on the network could point the console at their own directory with defaultRole admin and sign in as administrator
  for (const [m, u, b] of [['GET', '/api/auth/ldap', undefined], ['PUT', '/api/auth/ldap', { enabled: false }], ['POST', '/api/auth/ldap/test', { username: 'a', password: 'b' }]] as const)
    assert.strictEqual((await call(m, u, b)).status, 401, `${m} ${u} anonymous`);
  assert.strictEqual((await call('PUT', '/api/auth/ldap', { enabled: true, url: 'nope' }, A)).status, 400);
  const cfg = { enabled: true, url: `ldap://127.0.0.1:${dir2.port}`, bindDN: 'cn=console,ou=services,dc=corp,dc=example', bindPassword: 'svc-pass', baseDN: 'ou=people,dc=corp,dc=example', userFilter: '(uid={user})',
    roleMap: [{ group: 'cn=dba,ou=groups,dc=corp,dc=example', role: 'admin' }], defaultRole: 'viewer' };
  assert.strictEqual((await call('PUT', '/api/auth/ldap', cfg, A)).status, 200);
  const saved = JSON.stringify(store.peek().settings); assert(!saved.includes('svc-pass'), 'bind password is not stored in clear'); assert(/bindPasswordEnc":"v1:/.test(saved));
  const got = (await call('GET', '/api/auth/ldap', undefined, A)).body.ldap; assert.strictEqual(got.bindPasswordEnc, undefined); assert.strictEqual(got.bindPasswordSet, true);
  const t = await call('POST', '/api/auth/ldap/test', { username: 'alice', password: 'alice-secret-1' }, A); assert.deepStrictEqual([t.status, t.body.ok, t.body.role], [200, true, 'admin'], JSON.stringify(t.body));
  assert.strictEqual((await call('PUT', '/api/auth/ldap', { ...cfg, bindPassword: '' }, A)).status, 200, 'saving without retyping the password keeps it');
  assert.strictEqual((await call('POST', '/api/auth/ldap/test', { username: 'alice', password: 'alice-secret-1' }, A)).body.ok, true);
  // sign in as a directory user
  const l = await call('POST', '/api/auth/login', { username: 'bob', password: 'bob-secret-123' }); assert.deepStrictEqual([l.status, l.body.role], [200, 'viewer'], JSON.stringify(l.body));
  const B = l.headers['set-cookie'].split(';')[0];
  assert.strictEqual((await call('GET', '/api/auth/status', undefined, B)).body.role, 'viewer');
  const users = (await call('GET', '/api/users', undefined, A)).body.users; const bob = users.find((u: any) => u.user === 'bob'); assert.deepStrictEqual([bob.source, bob.role], ['ldap', 'viewer']);
  assert.strictEqual((await call('POST', '/api/auth/change-password', { currentPassword: 'bob-secret-123', newPassword: 'whatever-long-enough' }, B)).status, 400, 'directory users have no console password');
  assert.strictEqual((await call('PATCH', '/api/users/bob', { password: 'whatever-long-enough' }, A)).status, 400);
  assert.strictEqual((await call('POST', '/api/auth/login', { username: 'bob', password: 'wrong' })).status, 401);
  const a2 = await call('POST', '/api/auth/login', { username: 'alice', password: 'alice-secret-1' }); assert.strictEqual(a2.body.role, 'admin', 'group -> admin');
  // local accounts still work and win: a local user with the name of a directory user never goes to the directory
  assert.strictEqual((await call('POST', '/api/users', { username: 'carol', password: 'local-carol-pass-1', role: 'operator' }, A)).status, 201);
  const c = await call('POST', '/api/auth/login', { username: 'carol', password: 'local-carol-pass-1' }); assert.strictEqual(c.body.role, 'operator');
  assert.strictEqual((await call('POST', '/api/auth/login', { username: 'carol', password: 'carol-secret-1' })).status, 401, 'the directory password of a local account is not accepted');
  // disabled here wins over the directory
  assert.strictEqual((await call('PATCH', '/api/users/bob', { disabled: true }, A)).status, 200);
  await new Promise(r => setTimeout(r, 1200));                                                   // bob's earlier wrong password: 1 s back-off
  assert.strictEqual((await call('POST', '/api/auth/login', { username: 'bob', password: 'bob-secret-123' })).status, 401);
  // directory down: a clear 503, not "invalid credentials"
  dir2.close();
  await new Promise(r => setTimeout(r, 50));
  const dn = await call('POST', '/api/auth/login', { username: 'alice', password: 'alice-secret-1' }); assert.strictEqual(dn.status, 503, JSON.stringify(dn.body));
  assert(!/ECONNREFUSED|getaddrinfo|127\.0\.0\.1/.test(JSON.stringify(dn.body)), 'the reason stays in the audit log, not in the anonymous answer: ' + JSON.stringify(dn.body));
  assert(store.peek().audit.some((a: any) => a.action === 'ldap.configure') && store.peek().audit.some((a: any) => a.action === 'auth.login' && a.details?.ldap === true));
  // a directory (or whoever sits between) answering garbage must not crash the console: the sign-in fails cleanly
  { const bad = net.createServer(sk => { sk.on('data', () => sk.write(Buffer.from([0x30, 0x03, 0x02, 0x05, 0x00]))); });
    await new Promise<void>(r => bad.listen(0, '127.0.0.1', () => r())); const port = (bad.address() as any).port;
    let crashed: any = null; const h = (e: any) => { crashed = e; }; process.on('uncaughtException', h);
    const r = await authenticateLdap({ enabled: true, url: `ldap://127.0.0.1:${port}`, baseDN: 'dc=x', userFilter: '(uid={user})', bindDN: 'cn=a', bindPassword: 'b', timeoutMs: 2000 } as any, 'alice', 'pw');
    await new Promise(r => setTimeout(r, 50)); process.off('uncaughtException', h); bad.close();
    assert.strictEqual(crashed, null, 'no uncaught exception'); assert.strictEqual(r.ok, false); assert(/malformed/.test(String(r.detail)), JSON.stringify(r)); }
  console.log('ldap OK');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
