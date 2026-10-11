import assert from 'assert';
import { itCheck, itFix } from '../../src/i18n';
assert.strictEqual(itCheck('/var/tmp/pg_arca_scratch: 26.5 GiB free, about 16.1 GiB needed'), '/var/tmp/pg_arca_scratch: 26.5 GiB liberi, ne servono circa 16.1 GiB');
assert.strictEqual(itCheck("PostgreSQL 15 binaries found in /usr/lib/postgresql/15/bin (this node's own)"), 'binari di PostgreSQL 15 trovati in /usr/lib/postgresql/15/bin (quelli del nodo)');
assert.strictEqual(itCheck('all 172377 backup chunks needed are present in the repository'), 'tutti i 172377 blocchi di backup necessari sono nel repository');
assert.match(itCheck('not enough space on the volume of /srv (scratch of the recovery instance (extraction, WAL read-ahead, dump) + data directory of the live cluster (restored database / quarantine copy)): 5 GiB free, about 9 GiB needed'), /^spazio insufficiente sul volume di \/srv \(cartella temporanea .* \+ cartella dati .*\): 5 GiB liberi, ne servono circa 9 GiB$/);
assert.strictEqual(itCheck('something new from a newer agent'), 'something new from a newer agent');
assert.strictEqual(itFix('make sure it has about 3 GiB free'), 'assicurati che abbia circa 3 GiB liberi');
assert.strictEqual(itCheck("the agent's user (postgres) cannot create restore destination /srv/restore_big: /srv is not writable for it"), 'l’utente dell’agent (postgres) non può creare la destinazione del ripristino /srv/restore_big: /srv non è scrivibile per lui');
assert.match(itFix('create it for the agent: mkdir -p /srv/x && chown postgres: /srv/x (or choose a destination under a directory it owns)'), /^creala per l’agent: mkdir -p/);
assert.match(itCheck('the recovery host cannot reach the cluster that receives the result (172.30.1.2:5432): timeout expired'), /^l’host di recupero non raggiunge/);
// exact texts the agent produces (engine/granular.py) for things created after the backup and for owners/privileges
assert.match(itCheck("database 'new_db' is not in backup 20261011-234032F: it was created after that backup, so it is rebuilt from the WAL alone (size unknown in advance)"), /^il database 'new_db' non è nel backup 20261011-234032F: è stato creato dopo/);
assert.match(itCheck("object 'public.t_new' is not in backup 20261011-234032F: it was created after that backup and is rebuilt from the WAL"), /^l’oggetto 'public\.t_new' non è nel backup/);
assert.match(itCheck("object 'public.t_new' is not in backup 20261011-234032F and it does not exist in old_db now: it comes back only if it was created after that backup (and dropped since)"), /oggi non esiste in old_db: torna solo se/);
assert.match(itCheck("schema 'x y' has no tables in backup 20261011-234032F: it was created after that backup and is rebuilt from the WAL"), /^lo schema 'x y' non è nel backup/);
assert.match(itCheck('roles missing on this server (gone_role): object owners and privileges were NOT restored; create the roles and restore again to keep them'), /^ruoli assenti su questo server \(gone_role\)/);
assert.match(itFix('check the name: a wrong one is only found after the recovery; tables created and dropped after the backup are listed by the WAL forensics'), /^controlla il nome/);
console.log('i18n OK');
