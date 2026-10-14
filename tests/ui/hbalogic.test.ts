import assert from 'assert';
import { analyze, sortRules, describe, tag, fromEffective, fill, parseNet, validCidr, covers, Rule, clusterNeeds, accessCoverage } from '../../src/hbaLogic';
const R = (type: string, database: string, user: string, address: string, method = 'scram-sha-256'): Rule => ({ type, database, user, address, method });

// CIDR
assert(validCidr('10.0.0.0/8')); assert(validCidr('10.1.2.3')); assert(validCidr('::1/128')); assert(validCidr('fe80::/10'));
assert(!validCidr('10.0.0.0/33')); assert(!validCidr('300.1.1.1')); assert(!validCidr('all')); assert(!validCidr('abc'));
assert.equal(parseNet('10.0.0.5/24')!.lo, parseNet('10.0.0.0/24')!.lo);

// covers
assert(covers(R('host', 'all', 'all', '10.0.0.0/8'), R('hostssl', 'app', 'bob', '10.1.2.3/32')));
assert(!covers(R('hostssl', 'all', 'all', '10.0.0.0/8'), R('host', 'app', 'bob', '10.1.2.3/32')));
assert(!covers(R('host', 'all', 'all', '0.0.0.0/0'), R('host', 'replication', 'rep', '10.1.2.3/32')));   // all never matches replication
assert(covers(R('host', 'replication', 'rep', '10.0.0.0/24'), R('host', 'replication', 'rep', '10.0.0.7/32')));
assert(!covers(R('host', 'all', 'all', '10.0.0.0/8'), R('host', 'all', 'all', '::1/128')));

// duplicates / shadow / redundant / overlap
let i = analyze([R('host', 'app', 'bob', '10.0.0.0/24'), R('host', 'app', 'bob', '10.0.0.0/24')]);
assert.equal(i.length, 1); assert.equal(i[0].code, 'duplicate'); assert.equal(i[0].index, 1);
i = analyze([R('host', 'all', 'all', '10.0.0.0/8'), R('host', 'app', 'bob', '10.1.0.0/16')]);
assert(i.some(x => x.code === 'redundant' && x.index === 1));
i = analyze([R('host', 'all', 'all', '10.0.0.0/8'), R('host', 'app', 'bob', '10.1.0.0/16', 'reject')]);
assert(i.some(x => x.code === 'shadowed' && x.level === 'error' && x.index === 1));
i = analyze([R('host', 'app', 'bob', '10.1.0.0/16', 'reject'), R('host', 'all', 'all', '10.0.0.0/8')]);
assert(!i.some(x => x.level === 'error' || x.code === 'redundant'));
assert(i.length === 0 || i.every(x => x.code === 'overlap') ); // narrow reject before wide allow = proper exception

// ordering
const rs = [R('host', 'all', 'all', '10.0.0.0/8'), R('hostssl', 'app', 'bob', '10.1.2.3/32'), R('local', 'all', 'postgres', '', 'peer'), R('hostssl', 'all', 'all', '10.0.0.0/16')];
const sp = sortRules(rs, 'specific'); assert.equal(sp[0].type, 'local'); assert.equal(sp[1].address, '10.1.2.3/32'); assert.equal(sp[2].address, '10.0.0.0/16');
const wd = sortRules(rs, 'wide'); assert.equal(wd[0].type, 'local'); assert.equal(wd[1].address, '10.0.0.0/16'); assert.equal(wd[2].address, '10.1.2.3/32');
assert(analyze(sortRules([R('host','all','all','10.0.0.0/8'), R('host','app','bob','10.1.0.0/16','reject')], 'specific')).every(x => x.level !== 'error'));
assert(analyze(sortRules([R('host','all','all','10.0.0.0/8'), R('host','app','bob','10.1.0.0/16','reject')], 'wide')).some(x => x.code === 'shadowed'));
// stable
const st = sortRules([R('host','a','x','10.0.0.0/8'), R('host','b','x','10.0.0.0/8')]); assert.equal(st[0].database, 'a');

// describe / tag
assert(/Rejects/.test(describe(R('host', 'all', 'mallory', '203.0.113.0/24', 'reject'))));
assert(/replication/.test(describe(R('hostssl', 'replication', 'rep', '10.0.0.7/32'))));
assert(/TLS only/.test(describe(R('hostssl', 'app', 'bob', '10.0.0.0/24'))));
assert.equal(tag(R('host', 'all', 'all', '0.0.0.0/0')).kind, 'warn');
assert.equal(tag(R('host', 'app', 'bob', '10.0.0.1/32', 'trust')).kind, 'bad');
assert.equal(tag(R('hostssl', 'app', 'bob', '10.0.0.0/24')).kind, 'ok');

// effective
const e = fromEffective({ type: 'host', database: ['all'], user_name: ['all'], address: '10.0.0.0', netmask: '255.255.255.0', auth_method: 'md5', options: null });
assert.equal(e.address, '10.0.0.0/24'); assert.equal(e.database, 'all');
assert.equal(fromEffective({ type: 'host', database: ['a','b'], user_name: ['u'], address: '10.0.0.9', netmask: null, auth_method: 'md5' }).address, '10.0.0.9/32');
// fill
assert.equal(fill({ rules: [R('hostssl', '{{db}}', '{{u}}', '{{net}}')] }, { db: 'app', u: 'bob', net: '10.0.0.0/24' })[0].address, '10.0.0.0/24');
// temporary rules
import { withUntil, untilOf, stripUntil, untilLabel } from '../../src/hbaLogic';
const t0 = Date.UTC(2030, 0, 1, 12, 0);
assert.equal(withUntil('Consultant', t0), 'Consultant [until=2030-01-01T12:00Z]'); assert.equal(untilOf('x [until=2030-01-01T12:00Z]'), t0);
assert.equal(stripUntil('Consultant [until=2030-01-01T12:00Z]'), 'Consultant'); assert.equal(withUntil('A [until=2030-01-01T12:00Z]', null), 'A'); assert.equal(untilOf('no'), null);
assert.equal(untilLabel(t0, t0 - 30 * 60000), 'expires in 30 min'); assert.equal(untilLabel(t0, t0 + 1), 'expired'); assert.equal(untilLabel(t0, t0 - 5 * 86400000), 'expires in 5 days');
console.log('hbalogic ok');

// cluster access matrix: replication + superuser from every node, /32 each, first-match coverage (a reject on top blocks)
{
  const nodes = [{ name: 'pg1', host: '10.0.0.1' }, { name: 'pg2', host: '10.0.0.2' }, { name: 'pg3', host: 'db3.example' }, { name: 'dup', host: '10.0.0.2' }];
  const needs = clusterNeeds(nodes, { replUser: 'replicator', superuser: 'postgres', ssl: true, method: 'scram-sha-256', extraNets: ['10.0.5.0/24', 'bad'] });
  assert.deepStrictEqual(needs.map(n => `${n.kind}:${n.from}:${n.rule.address}`),
    ['replication:pg1:10.0.0.1/32', 'admin:pg1:10.0.0.1/32', 'replication:pg2:10.0.0.2/32', 'admin:pg2:10.0.0.2/32', 'replication:10.0.5.0/24:10.0.5.0/24', 'admin:10.0.5.0/24:10.0.5.0/24']);   // host names and duplicates skipped
  assert(needs.every(n => n.rule.type === 'hostssl' && n.rule.method === 'scram-sha-256'));
  const all: Rule[] = [R('host', 'all', 'all', '10.0.0.2/32', 'reject'), R('hostssl', 'replication', 'replicator', '10.0.0.0/24'), R('hostssl', 'all', 'postgres', '10.0.0.1/32')];
  const cov = accessCoverage(all, needs);
  const st = (k: string, f: string) => { const c = cov.find(x => x.need.kind === k && x.need.from === f)!; return c.blocked ? 'blocked' : c.by !== null ? `by${c.by}` : 'missing'; };
  assert.equal(st('replication', 'pg1'), 'by1'); assert.equal(st('admin', 'pg1'), 'by2');
  assert.equal(st('replication', 'pg2'), 'by1', 'database=all never matches replication: the reject does not block it'); assert.equal(st('admin', 'pg2'), 'blocked');
  assert.equal(st('replication', '10.0.5.0/24'), 'missing'); assert.equal(st('admin', '10.0.5.0/24'), 'missing');
  // no superuser wanted, plain host without TLS
  const only = clusterNeeds([{ name: 'a', host: 'fe80::1' }], { replUser: 'rep', superuser: '', ssl: false, method: 'md5' });
  assert.deepStrictEqual(only.map(n => [n.kind, n.rule.type, n.rule.address]), [['replication', 'host', 'fe80::1/128']]);
}
console.log('hba cluster access OK');
