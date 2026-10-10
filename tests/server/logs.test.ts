import assert from 'assert';
import { recordLog as broadcastLiveLog, logModeFor, setWatching, recent } from '../../server/logring';

const history = (q: any) => { const f = recent(e => (!q.clusterId || e.clusterId === q.clusterId) && (!q.level || e.level === q.level), 1000); return { total: f.length, entries: f }; };
const base = { timestamp: new Date().toISOString(), nodeName: 'n', nodeHost: '', service: 'postgres' as const, raw: '' };

// a noisy cluster never evicts another cluster's history, and errors outlive INFO noise
broadcastLiveLog({ ...base, clusterId: 'quiet', clusterName: 'quiet', level: 'INFO', message: 'quiet-info' });
broadcastLiveLog({ ...base, clusterId: 'noisy', clusterName: 'noisy', level: 'ERROR', message: 'noisy-error' });
for (let i = 0; i < 5000; i++) broadcastLiveLog({ ...base, clusterId: 'noisy', clusterName: 'noisy', level: 'INFO', message: 'spam ' + i });
assert.ok(history({ clusterId: 'quiet' }).entries.some((e: any) => e.message === 'quiet-info'), 'quiet cluster keeps its line');
assert.ok(history({ clusterId: 'noisy', limit: '1000' }).total <= 700, 'ring is bounded');
assert.ok(history({ clusterId: 'noisy', level: 'ERROR' }).entries.some((e: any) => e.message === 'noisy-error'), 'the error survives 5000 INFO lines');
assert.ok(history({ clusterId: 'quiet' }).entries.every((e: any) => e.clusterId === 'quiet'), 'no cross-cluster leak');
const all = history({ limit: '1000' }).entries; const ids = all.map((e: any) => e.id);
assert.deepStrictEqual(ids, [...ids].sort(), 'chronological order');

// nobody is watching: agents are asked for alerts only
assert.strictEqual(logModeFor('quiet'), 'alerts'); assert.strictEqual(logModeFor(undefined), 'alerts');
setWatching(0, ['quiet']);
assert.strictEqual(logModeFor('quiet'), 'full', 'a viewer on the cluster asks for the full stream'); assert.strictEqual(logModeFor('noisy'), 'alerts', 'other clusters stay quiet');
setWatching(1, []); assert.strictEqual(logModeFor('noisy'), 'full', 'a viewer of "all" watches everything');
console.log('logs: ok');
