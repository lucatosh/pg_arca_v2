import assert from 'assert';
import { analyze, sortRules, describe, tag, fromEffective, fill, parseNet, validCidr, covers, Rule } from '../../src/hbaLogic';
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
assert(/Rifiuta/.test(describe(R('host', 'all', 'mallory', '203.0.113.0/24', 'reject'))));
assert(/replica/.test(describe(R('hostssl', 'replication', 'rep', '10.0.0.7/32'))));
assert(/solo con TLS/.test(describe(R('hostssl', 'app', 'bob', '10.0.0.0/24'))));
assert.equal(tag(R('host', 'all', 'all', '0.0.0.0/0')).kind, 'warn');
assert.equal(tag(R('host', 'app', 'bob', '10.0.0.1/32', 'trust')).kind, 'bad');
assert.equal(tag(R('hostssl', 'app', 'bob', '10.0.0.0/24')).kind, 'ok');

// effective
const e = fromEffective({ type: 'host', database: ['all'], user_name: ['all'], address: '10.0.0.0', netmask: '255.255.255.0', auth_method: 'md5', options: null });
assert.equal(e.address, '10.0.0.0/24'); assert.equal(e.database, 'all');
assert.equal(fromEffective({ type: 'host', database: ['a','b'], user_name: ['u'], address: '10.0.0.9', netmask: null, auth_method: 'md5' }).address, '10.0.0.9/32');
// fill
assert.equal(fill({ rules: [R('hostssl', '{{db}}', '{{u}}', '{{net}}')] }, { db: 'app', u: 'bob', net: '10.0.0.0/24' })[0].address, '10.0.0.0/24');
console.log('hbalogic ok');
