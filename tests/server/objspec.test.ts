// Object paths for restore_object / promote / rows: names with spaces, unicode, dots and quotes (quoted parts) are accepted; malformed ones refused.
import assert from 'assert';
import { splitSpec, validateOp } from '../../server/optypes';
assert.deepStrictEqual(splitSpec('db.s.t'), ['db', 's', 't']);
assert.deepStrictEqual(splitSpec('arca_exotic.Ex Ötic.Child'), ['arca_exotic', 'Ex Ötic', 'Child']);
assert.deepStrictEqual(splitSpec('db."sales.eu".orders'), ['db', 'sales.eu', 'orders']);
assert.deepStrictEqual(splitSpec('"my.db"."a""b".c'), ['my.db', 'a"b', 'c']);
assert.strictEqual(splitSpec('db."a"b.t'), null);
assert.strictEqual(splitSpec('db."a'), null);
assert.strictEqual(splitSpec('db..t'), null);
assert.strictEqual(splitSpec('db.s.t\n'), null);
assert.strictEqual(splitSpec('db.' + 'x'.repeat(64)), null);
assert.deepStrictEqual(splitSpec('db.' + 'ö'.repeat(31)), ['db', 'ö'.repeat(31)]);           // 62 bytes
assert.strictEqual(splitSpec('db.' + 'ö'.repeat(32)), null);                               // 64 bytes
const v = (type: string, params: any) => validateOp(type, params);
assert.strictEqual(v('restore_object', { object: 'arca_exotic.Ex Ötic.Child' }), null);
assert.strictEqual(v('restore_object', { objects: ['d."a.b".t', 'd.public'] }), null);
assert.match(String(v('restore_object', { objects: ['d.s.t', 'e.s.t'] })), /same database/);
assert.match(String(v('restore_object', { objects: ['"x.y".s.t', 'x.s.u'] })), /same database/, 'the database part is compared unquoted');
assert.match(String(v('restore_object', { object: 'onlyone' })), /database\.schema/);
assert.strictEqual(v('restore_promote', { stage_db: 'pgarca_stage_x', object: 'd.Ex Ötic.t', mode: 'as_new' }), null);
assert.strictEqual(v('restore_diff', { stage_db: 'pgarca_stage_x', object: 'd."a.b".t' }), null);
assert.match(String(v('restore_diff', { stage_db: 'pgarca_stage_x', object: 'd.s' })), /database\.schema\.name/);
console.log('objspec tests OK');
