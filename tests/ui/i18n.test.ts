import assert from 'assert';
import { itCheck, itFix } from '../../src/i18n';
assert.strictEqual(itCheck('/var/tmp/pg_arca_scratch: 26.5 GiB free, about 16.1 GiB needed'), '/var/tmp/pg_arca_scratch: 26.5 GiB liberi, ne servono circa 16.1 GiB');
assert.strictEqual(itCheck("PostgreSQL 15 binaries found in /usr/lib/postgresql/15/bin (this node's own)"), 'binari di PostgreSQL 15 trovati in /usr/lib/postgresql/15/bin (quelli del nodo)');
assert.strictEqual(itCheck('all 172377 backup chunks needed are present in the repository'), 'tutti i 172377 blocchi di backup necessari sono nel repository');
assert.match(itCheck('not enough space on the volume of /srv (scratch of the recovery instance (extraction, WAL read-ahead, dump) + data directory of the live cluster (restored database / quarantine copy)): 5 GiB free, about 9 GiB needed'), /^spazio insufficiente sul volume di \/srv \(cartella temporanea .* \+ cartella dati .*\): 5 GiB liberi, ne servono circa 9 GiB$/);
assert.strictEqual(itCheck('something new from a newer agent'), 'something new from a newer agent');
assert.strictEqual(itFix('make sure it has about 3 GiB free'), 'assicurati che abbia circa 3 GiB liberi');
console.log('i18n OK');
