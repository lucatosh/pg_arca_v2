import assert from 'assert';
import { advise, fmtMem, rawToNum } from '../../src/tuning';
const GB = 1024 ** 3;
assert.equal(fmtMem(4 * GB), '4GB'); assert.equal(fmtMem(300 * 1024 * 1024), '300MB');
assert.equal(rawToNum('shared_buffers', '131072'), 1 * GB);
const a = advise({ cpu: 8, mem: 16 * GB }, { max_connections: '200', shared_buffers: '16384', work_mem: '4096' }, 'oltp');
const by = (n: string) => a.find(x => x.name === n)!;
assert.equal(by('shared_buffers').recommended, '4GB'); assert(by('shared_buffers').restart); assert(by('shared_buffers').differs); assert.equal(by('shared_buffers').current, '128MB');
assert.equal(by('effective_cache_size').recommended, '12GB'); assert.equal(by('maintenance_work_mem').recommended, '1GB');
assert.equal(by('work_mem').recommended, '20MB');   // (16-4)GB / (200*3) = 20.48MB → 20MB
assert.equal(by('work_mem').differs, true);
assert.equal(by('max_parallel_workers_per_gather').recommended, '4');
// already-right value is not flagged
const b = advise({ cpu: 2, mem: 4 * GB }, { shared_buffers: String(GB / 8192) }, 'oltp'); assert.equal(b.find(x => x.name === 'shared_buffers')!.differs, false);
assert(!b.some(x => x.name === 'max_parallel_workers_per_gather'));
// work_mem never below 4MB, olap larger than oltp
const c = advise({ cpu: 4, mem: 1 * GB }, { max_connections: '500' }, 'oltp'); assert.equal(c.find(x => x.name === 'work_mem')!.recommended, '4MB');
const o = advise({ cpu: 8, mem: 32 * GB }, { max_connections: '100' }, 'olap'), t = advise({ cpu: 8, mem: 32 * GB }, { max_connections: '100' }, 'oltp');
assert(parseInt(o.find(x => x.name === 'work_mem')!.recommended) > parseInt(t.find(x => x.name === 'work_mem')!.recommended));
console.log('tuning ok');
