import assert from 'assert';
import { classify, eolDate } from '../../server/pgcompat';
import { evaluate } from '../../server/health';

const t = (v: string | null | undefined, now = Date.parse('2026-10-10T12:00:00Z')) => classify(v, now);
// parsing + tiers
assert.strictEqual(t('16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)')!.tier, 'supported');
assert.strictEqual(t('16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)')!.label, '16');
assert.strictEqual(t('9.6.24')!.tier, 'unsupported'); assert.strictEqual(t('9.6.24')!.label, '9.6');
assert.strictEqual(t('10.23')!.tier, 'legacy'); assert.strictEqual(t('11')!.tier, 'legacy');
assert.strictEqual(t('12.22')!.tier, 'supported'); assert.strictEqual(t('18devel')!.tier, 'supported'); assert.strictEqual(t('17beta1')!.label, '17');
assert.strictEqual(t('19.0')!.tier, 'newer'); assert.strictEqual(t('30')!.tier, 'newer');
assert.strictEqual(t('15.4 - Percona Distribution')!.label, '15');
assert.strictEqual(t(''), null); assert.strictEqual(t(undefined), null); assert.strictEqual(t('abc'), null);
// end of life follows the policy (second Thursday of November, five years after the first release)
assert.strictEqual(eolDate(12), '2024-11-14'); assert.strictEqual(eolDate(14), '2026-11-12'); assert.strictEqual(eolDate(16), '2028-11-09'); assert.strictEqual(eolDate(18), '2030-11-14');
assert.strictEqual(t('13.21')!.eol, true, '13 is past its end of life on 2026-10-10');
assert.strictEqual(t('14.9')!.eol, false, '14 ends on 2026-11-12');
assert.strictEqual(classify('14.9', Date.parse('2026-11-13T00:00:00Z'))!.eol, true);
assert.strictEqual(t('16.1')!.problems.length, 0);
assert.deepStrictEqual(t('11.2')!.problems.map(p => p.code), ['legacy', 'eol']);
assert.deepStrictEqual(t('9.5')!.problems.map(p => p.code), ['unsupported']);

// the briefing: one issue per cluster and major, and the agent's own findings (binaries of another major) come through
const now = Date.parse('2026-10-10T12:00:00Z'); const iso = (ms: number) => new Date(ms).toISOString();
const node = (id: string, name: string, version: string, extra: any = {}) => ({ id, name, clusterId: 'c', lastSeen: iso(now), snapshot: {
  postgres: { is_in_recovery: id !== 'a', version, connections: { used: 1, max: 100 }, settings: {}, ...extra }, wal: { gap_count: 0, conflicts: 0 }, system: { disks: {} },
  backup: { configured: true, recent_sets: [{ status: 'COMPLETE', type: 'full', start_time: iso(now - 3600_000) }] } } });
const st: any = { clusters: [{ id: 'c', name: 'old-db', environment: 'dev', source: 'agent' }], operations: [], settings: {}, nodes: { a: node('a', 'pg1', '13.21 (Debian)'), b: node('b', 'pg2', '13.21 (Debian)') } };
let codes = evaluate(st, now).map(i => i.code).sort();
assert.deepStrictEqual(codes, ['pg_eol'], 'two nodes on the same EOL major raise ONE issue: ' + codes);
st.nodes.a = node('a', 'pg1', '9.6.24'); codes = evaluate(st, now).map(i => i.code);
assert.ok(codes.includes('pg_unsupported')); assert.strictEqual(evaluate(st, now).find(i => i.code === 'pg_unsupported')!.severity, 'critical');
st.nodes.a = node('a', 'pg1', '16.4', { compat: { label: '16', problems: [], tool_problems: [{ severity: 'critical', code: 'tool_major', text: 'pg_waldump is version 14' }] } });
st.nodes.b = node('b', 'pg2', '16.4');
const issues = evaluate(st, now); assert.deepStrictEqual(issues.map(i => i.code), ['pg_tool_major']); assert.strictEqual(issues[0].nodeName, 'pg1');
console.log('pgcompat.test OK');
