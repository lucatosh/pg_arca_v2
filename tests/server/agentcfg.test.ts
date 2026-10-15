import assert from 'assert';
import { validateOp } from '../../server/optypes';
const ok = (p: any) => validateOp('agent_config_set', p) === null;
assert(ok({ set: { pg_data: '/data/pg', pg_port: 5433 } }));
assert(ok({ set: { pg_data: null } }), 'null resets an override');
assert(!ok({}) && !ok({ set: {} }) && !ok({ set: [] }) && !ok({ set: 'x' }));
assert(!ok({ set: { auth_token: 'x' } }), 'only whitelisted settings');
assert(!ok({ set: { repo_path: { a: 1 } } }) && !ok({ set: { repo_path: '/a\nb' } }));
assert.strictEqual(validateOp('agent_config_get', {}), null);
assert(validateOp('pg_set_param', { name: 'archive_command', value: 'x' }) !== null && validateOp('pg_set_param', { name: 'shared_preload_libraries', value: 'x' }) !== null);
assert.strictEqual(validateOp('pg_set_param', { name: 'work_mem', value: '64MB' }), null);
assert(validateOp('patroni_config_patch', { patch: { postgresql: { parameters: { archive_command: 'rm -rf /' } } } }) !== null);
assert(validateOp('patroni_config_patch', { patch: { postgresql: { authentication: {} } } }) !== null && validateOp('patroni_config_patch', { patch: { restapi: {} } }) !== null);
assert.strictEqual(validateOp('patroni_config_patch', { patch: { ttl: 30, postgresql: { parameters: { max_connections: 200 } } } }), null);
console.log('agent config op tests OK');
// an operation never chooses the directory the agent runs binaries from: `ephemeral` is resolved by the console when it hands the operation over,
// and a delivery address (`into`) carries no bindir
assert(/set by the console/.test(validateOp('restore_database', { set: 'latest', database: 'app', ephemeral: { bin_dir: '/tmp/evil' } }) || ''));
assert(/set by the console/.test(validateOp('restore_instance', { set: 'latest', target_dir: '/tmp/x', ephemeral: { bin_dir: '/tmp/evil' } }) || ''));
assert(/into\.bindir is not allowed/.test(validateOp('restore_database', { set: 'latest', database: 'app', into: { host: 'db2', port: 5432, bindir: '/tmp/evil' } }) || ''));
assert(/into\.dbname/.test(validateOp('restore_database', { set: 'latest', database: 'app', into: { host: 'db2', dbname: 'x\ny' } }) || ''));
assert.strictEqual(validateOp('restore_database', { set: 'latest', database: 'app', into: { host: 'db2', port: 5433, user: 'app', password: 'p', dbname: 'postgres' } }), null);
console.log('agentcfg OK');
