# Come funzionano backup e restore in pg_arca

Documento tecnico vivo: va aggiornato a ogni modifica del motore (`unix-agent/pg_arca/engine/`). In fondo c'è il registro delle modifiche.
Regola: qui si scrive solo ciò che il codice fa davvero. Ciò che è provato è dichiarato tale; ciò che non è misurato è marcato **[non misurato]**.

## 1. Il modello in una frase

Un backup è un **elenco (manifest) di chunk** da 64 KiB, identificati dal loro hash e conservati una sola volta in un archivio *content-addressed*.
Full, differenziale e incrementale non sono tre formati diversi: sono tre modi di decidere quali chunk riscrivere. Il manifest di ogni backup è sempre **completo**
(descrive tutti i file), quindi un restore non deve "sommare" nulla a mano: legge il manifest dell'ultimo set e prende ogni chunk dove si trova.

## 2. Il repository

```
<repo>/repo.json                         parametri fissi (chunk 64 KiB, blake2b-256, cifratura)
<repo>/cas/aa/bb/<blake2b-256>           1 byte di tag + chunk compresso (+ cifrato), immutabile, verificato a ogni lettura
<repo>/stanza/<nome>/stanza.json
<repo>/stanza/<nome>/backup/<set>/{meta.json, manifest.json.z, catalog.json.z, backup_label}
<repo>/stanza/<nome>/locks/
<wal_dir>/<segmento>[.zst|.lz4] + .meta  archivio WAL (condiviso fra backup e restore)
```

- **Chunk**: 8 pagine PostgreSQL (64 KiB). Hash `blake2b-256` (con cifratura attiva: blake2b *con chiave*, così l'hash non rivela se un contenuto è noto).
- **Compressione**: per chunk, zstd (livello 3 di default) oppure zlib se `zstandard` manca. Il primo byte indica l'algoritmo (`S` zstd, `Z` zlib, `N` non compresso), quindi si possono mescolare.
- **Cifratura** opzionale: AES-256-GCM per chunk; anche manifest e catalogo (contengono nomi di file) sono protetti.
- **Deduplica**: due chunk uguali nello stesso o in backup diversi sono scritti una volta. È il motivo per cui un full ripetuto costa quasi solo i chunk cambiati.
- **Durabilità**: i chunk si scrivono con tmp+rename senza fsync singolo; il set viene dichiarato COMPLETE solo dopo un `sync()` globale. Dopo un crash i chunk lasciati a metà vengono riverificati prima di essere riusati.

## 3. Backup

Sequenza (`engine/backup.py`):

1. `pg_backup_start()` (o `pg_start_backup` sulle versioni vecchie, vedi COMPAT.md).
2. Lettura dei file del datadir con `posix_fadvise(DONTNEED)` per non sporcare la cache di sistema; `pg_control` per ultimo, come `pg_basebackup`.
3. `pg_backup_stop()`, poi attesa che tutti i WAL necessari siano nell'archivio e verifica che la catena sia continua.
4. Cattura del **catalogo** (§5), scrittura di manifest e metadati, `sync()` globale, commit del set.

| Tipo | Cosa riscrive | Riferimento |
|------|---------------|-------------|
| full | tutti i chunk (quelli già presenti nel CAS non vengono riscritti) | nessuno |
| diff | i chunk che contengono almeno una pagina con `pd_lsn` ≥ LSN dell'ultimo **full** | ultimo full |
| incr | i chunk con almeno una pagina con `pd_lsn` ≥ LSN dell'ultimo backup **di qualsiasi tipo** | ultimo backup |

Dettagli che contano:
- La decisione è **a livello di pagina**, la granularità di scrittura è il chunk da 8 pagine. Un file da 1 GB con 3 pagine modificate scrive pochi chunk, non 1 GB.
- Pagine azzerate e coda parziale del file sono trattate esplicitamente (la coda "strappata" è sempre tenuta).
- I file che non sono relazioni (`whole`) vengono sempre salvati interi.
- **Limite onesto**: per capire cosa è cambiato, l'incrementale **legge comunque tutti i file** del cluster (controlla gli LSN di pagina). Risparmia scrittura, rete e spazio nel repository, non lettura dal disco di produzione. Non c'è (ancora) un registro dei blocchi modificati come i WAL summary di PostgreSQL 17. **[non misurato]** l'impatto reale sul carico su istanze grandi.
- Il backup da una **replica** è supportato (con le correzioni di timeline e `stop_lsn`, vedi `tools/lab/NOTES.md` righe 29, 34-36).

### WAL

- `archive_command = python3 -m pg_arca.wal_archive archive %p %f`, `restore_command = … get %f %p`.
- Scrittura **atomica e write-once** (temp + fsync + `link(2)`, che fallisce se il nome esiste), idempotente se il contenuto è identico.
- **Split-brain**: stesso nome ma contenuto diverso (due primari sulla stessa timeline) non viene mai accettato: la copia va in `conflicts/` e il comando fallisce, così `pg_stat_archiver.failed_count` avverte.
- In lettura lo sha256 del segmento decompresso deve coincidere con quello registrato: un segmento corrotto **interrompe** la recovery (exit 126) invece di sembrare "fine archivio" (exit 1) e fermare il restore al punto sbagliato in silenzio.
- Anche i file `.history` delle timeline sono write-once.

## 4. Restore

### 4.1 Istanza completa / PITR (`engine/restore.py`)

1. **Scelta del set** più recente che precede il target e verifica che i WAL da `start_lsn` al target siano presenti e continui (`check_wal_for_chain`).
2. **Merge della catena**: si prende il manifest dell'ultimo set; per ogni file i chunk si cercano dall'ultimo al primo set della catena (vince il più recente per offset). I file cancellati prima dell'ultimo set non riappaiono.
3. **Materializzazione parallela e verificata**: ogni chunk è letto, decifrato, decompresso e **riverificato con l'hash** prima di essere scritto. Spazio libero controllato prima di iniziare (`PGA-RST-030`).
4. **Configurazione della recovery** con il meccanismo della versione (`recovery.signal` + `postgresql.auto.conf` da PG12, `recovery.conf` prima), con `restore_command` verso l'archivio WAL e `recovery_target_*`.
5. Mai sovrascrive: una destinazione non vuota o un datadir vivo è rifiutato (`engine/safety.py`, controllo dei symlink compreso).
6. **Destinazione proposta dall'agent** (`engine/restored.py: suggest`): un candidato per volume (cartella indicata in `restore_roots`, volumi scrivibili dall'agent, accanto a PGDATA, scratch, home, /var/tmp), con filesystem, sorgente, spazio libero prima/dopo e cosa altro vive su quel volume (dati di produzione, archivio WAL, repository). Ordine: volume separato con spazio → stesso volume di altro → stesso volume dei dati di produzione solo se restano ≥ max(2 GiB, 10 %) → mai se non ci sta. Senza destinazione il piano e il restore usano il consigliato.
7. **La copia viene avviata e seguita fino in fondo** (`register_and_start`): binari della sua versione (`pick_bindir`), porta libera 5433-5499 (o l'intervallo configurato), socket privato 0700, log nella copia, nessun file condiviso con la produzione (`external_pid_file`, `stats_temp_directory` di Debian), `shared_buffers` limitato, accesso dell'agent solo dal socket privato. Attende la promozione o la pausa al target. Le impostazioni che valevano solo sul server originale vengono corrette e dichiarate: huge pages, file SSL, librerie mancanti, `listen_addresses` inesistenti, porta occupata.
8. **Registro delle copie** (`state_dir/restored-instances.json`): scadenza predefinita 24 h (4 h, 3 giorni, 1 settimana o «finché non la elimino»), poi l'agent la ferma e la cancella; riavvio automatico se dovrebbe girare e non gira (riavvio dell'agent, reboot); operazioni `restored_stop/start/resume/keep/drop` dalla console (l'eliminazione richiede il nome e un marcatore `.pgarca-restored` con lo stesso id). Con `keep_archiving` (la copia sostituirà l'originale) la copia non viene avviata.

9. **Rimettere a posto la produzione stessa** (`replace_production`, `engine/replace.py`; server standalone, scelta predefinita nella UI quando il cluster non è Patroni). Il ripristino non è una copia accanto: è la produzione che torna al momento scelto.
   - Il server viene ricostruito **accanto a PGDATA, sullo stesso volume** (`<pgdata>.pgarca-new-<ts>`), con l'archiviazione WAL attiva (`keep_archiving`), mentre la produzione continua a lavorare. Lo spazio sul volume dei dati è controllato prima (`restorecheck`); una ricostruzione fallita o annullata viene cancellata subito.
   - Poi: **stop** (segnale `pg_ctl stop -m fast` dall'utente dell'agent, che è il proprietario del server; `systemctl stop` solo se l'agent è root, perché la regola polkit concede solo start/restart) → `rename(pgdata → <pgdata>.pgarca-before-<ts>)` → `rename(ricostruito → pgdata)` → **start** come il server è gestito (la sua unità systemd con `--no-block`, oppure `pg_ctl start` con le opzioni di `postmaster.opts`) → attesa della fine del recupero.
   - **Fine del recupero** decisa dal control file (`Database cluster state: in production`) *e* dall'assenza di `recovery.signal`/`recovery.conf` (il control file copiato dice «in production» prima ancora che il recupero inizi), con `pg_is_in_recovery()` come seconda prova: funziona anche se il ruolo dell'agent non esisteva all'istante ripristinato. Nessun timeout fisso: fallisce se il postmaster muore o se nulla si muove per 30 minuti.
   - **Rollback automatico**: se il server non torna primario (o l'operazione viene annullata) i dati ricostruiti diventano `<pgdata>.pgarca-failed-<ts>`, l'originale torna al suo posto e, se girava, viene riavviato.
   - **Produzione ferma** (il caso del disastro): l'unità systemd si trova dalla data directory (`Environment`/`ExecStart` per le unità RHEL, `data_directory` di `/etc/postgresql/<ver>/<cluster>` per Debian). Con target «ultimo istante» i **WAL che la produzione ha scritto ma non archiviato** (il suo `pg_wal`, dopo lo stop) vengono passati al recupero: nulla di confermato va perso. Provato: senza questo passo le righe confermate e non archiviate andavano perse.
   - Dopo: le impostazioni di recovery del ripristino vengono commentate in `postgresql.auto.conf` (non devono seguire il server nei backup e negli standby futuri); la produzione è su una nuova timeline, quindi il backup successivo è un full (già gestito da `backup.py`). I dati di prima restano finché l'operatore non li elimina (`restore_kept_list` / `restore_kept_drop`, conferma con il nome della cartella).
   - **Rifiuti**: membri Patroni (`PGA-RST-081`: il cluster non si sostituisce alle spalle di Patroni; lì si ripristinano database e tabelle al loro posto), standby (`PGA-RST-084`), tablespace fuori da PGDATA (`PGA-RST-083`, per ora), PostgreSQL processo principale di un container (`PGA-RST-087`: fermarlo fermerebbe il container), server che risponde ma i cui processi l'agent non vede (`PGA-RST-088`, altro container), server avviato a mano mentre l'agent è un servizio, unità con `Restart=always` se l'agent non è root, nessuna regola polkit. Avviso se ci sono standby in streaming: vanno ricostruiti.
   - Conferma digitata `SOSTITUISCI` (UI e API) e approvazione a quattro occhi negli ambienti protetti.

Target supportati: ultimo istante disponibile, tempo, LSN, xid, nome (restore point), "immediate" (fine del backup).
**Target oltre la fine dell'archivio** (tempo o LSN): il motore recupera fino all'ultimo WAL disponibile e lo dichiara (`target_clamped`) invece di fallire con `PGA-PITR-010`. Per xid/nome inesistenti o archivio con buchi dà un errore chiaro (`PGA-PITR-014`) con posizione raggiunta e coda del log. Provato su PG16 reale e sul lab Patroni.

### 4.2 Restore granulare (`engine/granular.py`)

Per database, tabella o righe **non** si ricostruisce il cluster intero:

1. **Estrazione sparse** (`sparse_filter`): si materializzano solo i file del database richiesto, `template1` e `global`; degli altri database restano solo `PG_VERSION` e `pg_filenode.map`.
2. Si avvia un'**istanza effimera** isolata (porta e socket propri, configurazione di produzione neutralizzata: niente archiviazione, niente repliche), che rigioca il WAL fino al target.
3. I dati escono con `pg_dump`/`pg_restore` verso la destinazione (stesso cluster, un altro, o un database di quarantena `pgarca_stage_*`).
4. L'istanza effimera viene distrutta; i database di quarantena sono riconoscibili e mai confusi con database utente.

Operazioni: `restore_database` (nome nuovo, mai sovrascrive), `restore_object` (una tabella in quarantena), `restore_diff` (confronto riga per riga con la tabella viva), `restore_apply_rows` (reinserisce/elimina solo le righe scelte, con copia di sicurezza), `restore_promote` (riporta la tabella: `as_new` accanto all'originale, `replace` con l'originale rinominato e mai cancellato; una tabella già sparita ritorna con il **suo nome nel suo schema**, schema ricreato se serve).

**Il lavoro finisce nell'originale** (scelta «Alla fine», presa prima di partire, eseguita dalla stessa operazione):
- tabella/schema: `restore_object` con `finish: promote` (`missing_only` se è sparita, `replace` se esiste ancora, `as_new` accanto) rimette tutto nel database originale e cancella la quarantena;
- righe: `finish: rows_all` reinserisce le righe cancellate e riporta quelle modificate (copia di sicurezza prima, una transazione), poi cancella la quarantena;
- database: `restore_database` con `replace_original` ricostruisce con un nome provvisorio e poi `swap_database` lo mette al posto dell'originale (nuove connessioni sospese con `ALLOW_CONNECTIONS false`, sessioni chiuse, i due `ALTER DATABASE … RENAME` in una transazione, l'originale resta come `<db>_before_<ts>`); un database eliminato torna con il suo nome. `restore_db_swap` fa lo stesso dopo, con un clic, per una copia controllata prima;
- se l'ultimo passo non si può fare in sicurezza (righe orfane, standby, sessioni che non si chiudono) il risultato dice perché (`finish_error` / `swap_error`), l'originale non è toccato e la UI propone le alternative.

Costo, in chiaro: la lettura è proporzionale al **database** richiesto, non al cluster. All'interno del database si estraggono comunque tutte le tabelle e si rigioca tutto il WAL tra backup e target. Una tabella da 1 GB in un database da 500 GB estrae 500 GB. **[non misurato]** su istanze grandi: i tempi sul lab (database da decine di MB) non sono rappresentativi.

### 4.3 Verifica

`backup_verify` rilegge i chunk e confronta gli hash; `restore_drill` **ripristina davvero** un set (sparse: solo `postgres` e `template1`, fino al consistent state) per dimostrare che è recuperabile. Un backup non ripristinato non è considerato provato.

## 5. Il catalogo

Ogni backup contiene `catalog.json.z`: per ogni database le sue relazioni (`oid`, schema, nome, tipo, `relfilenode`, tablespace, dimensione, TOAST, proprietario dell'indice, partizione padre). Serve a:
- elencare database/schemi/tabelle **senza avviare nulla**;
- sapere quali file appartengono a quale oggetto (base della sparse extraction);
- mostrare conteggi e dimensioni corretti: solo tabelle utente (niente `pg_catalog`, niente TOAST, partizioni conteggiate nel padre), dimensione reale = heap + TOAST + indici (+ partizioni), calcolata dai valori già nel catalogo, senza altre letture sul sorgente. I backup scritti da versioni precedenti non hanno i legami indice/partizione: la dimensione è allora indicata come approssimata (`approx`).

## 6. È unico? Confronto onesto con pgBackRest

Cosa **non** è nuovo: backup fisico con pg_backup_start/stop, archivio WAL con verifica, compressione, cifratura, deduplica a blocchi (restic/borg), PITR. Sono tecniche note.

Cosa è, per quanto so, diverso da pgBackRest (che è il riferimento):

| Aspetto | pgBackRest | pg_arca |
|---------|------------|---------|
| Unità di backup | file interi; incr/diff per timestamp/checksum; block-incremental opzionale nelle versioni recenti | chunk da 64 KiB content-addressed, decisione per LSN di pagina |
| Deduplica fra backup | no (ogni backup referenzia i file) | sì, globale nel repository |
| Manifest | per backup, catena da risolvere | per backup, sempre completo |
| Catalogo database→schema→tabella dentro il backup | no | sì, senza avviare PostgreSQL |
| Restore di un database | `--db-include` (istanza vera, altri DB a zero) | sparse + istanza effimera, quarantena, mai sovrascrive |
| Restore di tabella / righe / confronto con la viva | no | sì (quarantena, diff, apply righe, promote) |
| Gestione Patroni | esterna | parametri e pg_hba **solo** via DCS (stessa chiamata di `patronictl edit-config`) |
| Console, approvazioni, audit | no | sì |

Quello che **non** posso dire: che sia "mille volte meglio" o più veloce. Non c'è nessun benchmark confrontato con pgBackRest; ogni affermazione di prestazione resta **[non misurato]**.
La differenza reale oggi è funzionale (granularità del restore, catalogo, deduplica, console), non di velocità dimostrata.

## 7. Limiti noti e direzione

| Limite | Perché conta | Direzione |
|--------|--------------|-----------|
| L'incrementale legge tutto il cluster | carico di I/O su produzione | indice dei blocchi modificati dal WAL (come i WAL summary di PG17) |
| Restore di una tabella estrae tutto il database | tempo e spazio su istanze grandi | estrazione sparse **per relazione** (tabella + TOAST + catalogo del database), con dipendenze dal catalogo |
| Il redo rigioca tutto il WAL del periodo | tempo | indice WAL per blocco costruito in archiviazione, redo limitato ai blocchi dell'oggetto |
| L'istanza effimera gira sul nodo | carico sul cluster | istanza effimera centralizzata e configurabile (globale/cluster) |
| Serve sempre un PostgreSQL per leggere le righe | tipi custom, visibilità, multixact | decoder diretto dei chunk: ricerca, dietro flag, validato contro il restore classico prima di essere offerto |
| Restore oggetto = una tabella, senza dipendenze | FK, viste, sequenze, trigger non vengono ricreati | restore oggetto v2: calcolo delle dipendenze, ricreazione, modalità schema (implementato, provato su PG16 locale) |
| Lo scambio della promozione è UNA transazione | uno schema con migliaia di tabelle può superare la tabella dei lock del server | stimato prima di partire e rifiutato con il valore di `max_locks_per_transaction` da impostare (PGA-GEN-093); per ora nessuna promozione «a gruppi» automatica |
| Vista materializzata ripristinata da sola | il contenuto è derivato | ricalcolata sui dati attuali (detto nel risultato) |

## 7b. Progetto: restore di oggetti con dipendenze e di schemi (v2)

Stato: **implementato e provato su PostgreSQL 16 reale** (`unix-agent/tests/test_objects_v2.py`, 10 test: FK in ingresso e in uscita, partizioni, viste, sequenze, tipi, ACL, schema intero, tre modalità di promozione, rifiuto degli schemi di sistema). Collegato alle operazioni `restore_plan` (oggetti) / `restore_object` / `restore_promote` (anche `dry_run`) e alla pagina Restore. **Non ancora eseguito sul lab Patroni** (vedi HANDOFF).

Problema del restore tabella v1: ripristina *la sola tabella*. Chiavi esterne che puntano alla tabella, viste, sequenze, trigger, tipi, permessi e funzioni vengono dimenticati o restano agganciati alla vecchia tabella rinominata.

Principi del v2:
1. **Si ripristina una selezione**, non una tabella: una o più tabelle, uno o più schemi, oppure uno schema intero. La selezione si espande nella sua **chiusura di dipendenze**, calcolata sull'istanza recuperata (dove il catalogo è quello al target): tabelle referenziate dalle FK, tipi (enum, domini, composti), funzioni usate da default/trigger/vincoli, sequenze possedute, viste e viste materializzate che dipendono dagli oggetti scelti, estensioni, ruoli e permessi (ACL).
2. **Mai distruttivo, mai a metà**: tutto viene costruito prima in un database di quarantena (`pgarca_stage_*`) con i metadati (`pgarca_meta`); la promozione avviene in una transazione, con piano visibile (dry-run) prima di toccare nulla.
3. **Modalità di promozione**: `as_new` (accanto all'originale, suffisso), `replace` (scambio atomico: l'originale resta rinominato, le FK in ingresso e le viste dipendenti vengono *riagganciate* alla tabella nuova), `in_place` (solo righe, con la copia di sicurezza già presente in `apply_rows`).
4. **Modalità schema**: `create` (lo schema non esiste: si ricrea con tutto il contenuto), `missing_only` (si riportano solo gli oggetti che mancano, senza toccare gli altri), `as_new` (**come implementato oggi**: le tabelle ripristinate compaiono nello stesso schema con suffisso `_pitr_<data>`; uno schema accanto con un altro nome **non** è implementato), `replace` (scambio dell'intero schema con rinomina dell'originale, con riagganciamento delle dipendenze da altri schemi).
5. **Le FK si filtrano**: quelle verso tabelle fuori dalla selezione si ricreano solo se la tabella di destinazione esiste nel database vivo e le righe sono coerenti (altrimenti si segnala e si crea `NOT VALID`).
6. **Ogni passaggio è verificato**: conteggi e impronta delle righe, vincoli, indici e sequenze (posizione corrente) confrontati con lo stage.

Scenari di accettazione (da eseguire sul lab con `arca_restore_lab`, vedi `tools/lab/scenario-restore.py`): database cancellato, schema cancellato con CASCADE, tabella cancellata, righe cancellate, tabella con dipendenze in ingresso (`tabledeps`, ora gestito dal v2), più `modes` (replace / missing_only / as_new). Gli scenari girano in locale su PG16 reale; sul lab Patroni vanno ancora rieseguiti con `tools/lab/run-scn.sh`.

## 7c. Ricerca: dove va il tempo di un restore (misure del 11/10 notte, PG16 locale)

Metodo: strumenti in `unix-agent/tests/` (`bench_restore.py`, `bench_forensics.py`), un cluster di prova locale, una sola macchina, **nessun confronto con altri prodotti**. I numeri sono quelli misurati in quel contesto e non si trasferiscono automaticamente a database da 1 TB o a storage di rete.

| Fase | Che cosa si è visto | Cosa è stato fatto | Misura |
|------|--------------------|--------------------|--------|
| Ricerca di DROP/TRUNCATE nel WAL | un solo `pg_waldump` seriale su tutto il periodo | `walscan.py`: piano per segmenti, filtro per rmgr, scansione parallela sulla corsia `analysis`, cache per segmento | 18 s → 2,1 s (freddo) → 0,02 s (cache); lab Patroni 97 s → 8 s |
| Recovery di una PITR «sparsa» (un database su molti, poco WAL da rigiocare) | il `restore_command` valeva circa il 93 % della fase (14,0 s su 15,1 s in una prova da 105 segmenti): avvio di python, decompressione, sha256, fsync ≈ 133 ms/segmento contro 53 ms della sola decompressione | read-ahead (`walprefetch.py`): spool decompresso e verificato da più worker, segmento servito con `rename` | recovery −38 % |
| Dump dall'istanza recuperata | `pg_dump` con compressione di default | `zstd:1` (solo PG ≥ 16, `pgsession.run_dump`; sulle versioni precedenti nessun cambiamento) | 3,5 s → 1,1 s |
| `pg_restore` | il tempo è caricamento dati + costruzione indici | nulla da guadagnare dal formato: il lavoro è nel server di destinazione | non ottimizzato; `jobs` configurabile |

Prove che **non** hanno dato vantaggio (macchina di prova a 2 vCPU, 400 MB di dati + 300 MB di WAL in 325 segmenti: recovery ≈ 44–47 s): `max_wal_size` alto + `checkpoint_timeout` lungo per evitare i restartpoint (nessuna differenza misurabile, scartato), read-ahead più profondo (24 segmenti, 8 worker: invariato o peggiore, la CPU è già satura tra redo e prefetch). Su macchine con più core il risultato può essere diverso: non misurato.

Sicurezza e successo (blindatura):
- **Pre-flight prima della fase lunga** (`engine/restorecheck.py`): catena di chunk completa, spazio di scratch e del volume dati del cluster vivo, nome di destinazione libero, ambiente dell'istanza effimera. Il piano lo mostra (blocca «Avvia» se bloccante) e l'avvio lo rivaluta, perché il disco può essere cambiato dopo il piano.
- **Mai sovrascrivere**: un database di destinazione esistente è un errore (`PGA-SEC-030`) *prima* del recupero; la modalità `replace` per oggetti conserva gli originali come `_old_<data>`, nella UI chiede la conferma digitata `SOSTITUISCI` e il server la richiede anche via API (`confirm`), oltre all'approvazione negli ambienti protetti.
- Anche il restore di istanza controlla la catena di chunk (piano + avvio) e il test `test_12b` verifica che con un chunk mancante nulla venga creato.
- **Verifica a fine ripristino**: numero di tabelle all'istante di recupero = numero di tabelle ripristinate (`PGA-VRF-040`).
- **Pulizia**: stage, spool WAL e istanza effimera sono rimossi anche in caso di errore; lo spool viene fermato prima di essere cancellato.

Da fare (ipotesi, **non** ancora implementate né misurate): estrazione per relazione invece che per database; verifica a campione dei chunk contro il hash prima di estrarre; ripresa di un restore interrotto; conteggio righe di controllo sulle tabelle piccole; misura delle stesse fasi sul lab Patroni e su un database da ≥ 100 GB.

### 7d. Restore: casi reali gestiti (notte 11→12/10)

- **Una partizione da sola o un figlio di ereditarietà**: i padri entrano nella quarantena come gusci vuoti (dump `--schema-only` dei soli antenati, sezioni pre-data/data/post-data nell'ordine di pg_dump, così l'ATTACH precede gli indici del padre), la tabella resta autonoma in quarantena (DETACH / NO INHERIT); nello scambio la tabella viva viene staccata (tenuta `_old_`) e quella recuperata riattaccata al padre VIVO con gli stessi limiti (`attached`). `as_new` = copia mai attaccata.
- **Statistiche estese** (`CREATE STATISTICS`): pg_dump `-t` non le porta → lette dall'istanza recuperata e ricreate; quelle della copia vecchia rinominate.
- **Sequenze condivise** (default di una tabella che usa una sequenza non sua): viaggiano con la tabella; nella promozione create solo se mancano, mai riportate indietro. **Default di ALTRE tabelle** che usano la sequenza posseduta dalla tabella sostituita: ripuntati alla nuova (altrimenti due sequenze darebbero gli stessi id).
- **Domini con CHECK che chiamano funzioni**, funzioni che usano tipi: prerequisiti creati a passate finché si riesce.
- **Vista / vista materializzata / sequenza da sole**: ricreate (prima «niente da fare»).
- **Oggetti e database creati dopo l'ultimo backup**: il database si ricostruisce dai soli WAL (si estraggono solo i database di sistema; il CREATE DATABASE rigiocato dà oid, codifica, collation); una tabella nuova arriva con il redo. Istante precedente alla creazione → PGA-PITR-016.
- **Il database come oggetto**: proprietario, ACL, limite connessioni, commento, `ALTER DATABASE/ROLE … IN DATABASE SET`, provider ICU/builtin, tablespace predefinito; proprietari e permessi di tutti gli oggetti quando i ruoli esistono (prima `--no-owner --no-acl` sempre).
- **Consegna a un altro server**: tablespace assenti → `--no-tablespaces` con avviso; ruoli assenti → proprietari/permessi saltati con l'elenco.
- **Legami per identità di altri oggetti** con la tabella sostituita: viste (già prima), regole e policy RLS di altre tabelle, appartenenza alle pubblicazioni (filtro di righe e colonne compresi); sottoscrizioni: avviso con il comando di refresh.
- **Recupero di righe senza chiave primaria**: un indice univoco su colonne NOT NULL identifica le righe.
- **Lock**: l'istanza di recupero dimensiona `max_locks_per_transaction` sulle relazioni del catalogo (pg_dump di 1500 tabelle falliva con «out of shared memory»).
- **Tablespace creati dopo il full (sicurezza)**: il recupero rigioca i WAL dall'inizio del FULL; `CREATE TABLESPACE` viene rigiocato sul percorso ASSOLUTO del record, PostgreSQL cancella la cartella di versione che trova lì e ripunta `pg_tblspc` → sull'host di produzione cancellerebbe il tablespace vivo. Prima di ogni recupero i WAL vengono cercati (record Tablespace, cache); percorso in uso → rifiuto (PGA-RST-050), percorso assente → creato per il recupero e rimosso; lo scheduler avvia un FULL appena compare un tablespace nuovo.
- **Copia d'istanza sicura**: `archive_mode=off`, niente standby sincroni né primario da seguire (salvo `keep_archiving`).
- **Annullamento e interruzioni**: Annulla interrompe pg_dump/pg_restore; database in riempimento marcato «restore IN PROGRESS», quarantena marcata `building` (mai promossa incompleta).
- **Forense DELETE/UPDATE di massa** (`wal_forensics` mode `dml`): righe modificate per transazione e tabella, ROLLBACK esclusi, ripristino «subito prima» con `target_xid` + `inclusive=false`.
- **Database clonati da un template utente con FILE_COPY**: il template è trovato nei record `copy dir` ed estratto.

- **Estensioni nel proprio schema e collation personalizzate**: `CREATE EXTENSION … SCHEMA <quello originale>` (senza SCHEMA se l'estensione non è rilocabile); `CREATE COLLATION` dalla riga di `pg_collation` (colonne diverse per versione). Estensione già presente in uno schema diverso → avviso.
- **Tipo riga di una tabella usato altrove**: come tipo di colonna di una tabella recuperata (guscio vuoto in quarantena, rifiuto nel piano se la tabella non esiste nel live); nelle funzioni (argomenti/risultato) → ricreate sul tipo della tabella ripristinata nello scambio; colonne di altre tabelle → avviso con il comando. **Funzioni `BEGIN ATOMIC`** (legate per identità come le viste) → `CREATE OR REPLACE` dal loro testo.
- **Cartelle di versione dei tablespace** (`PG_<major>_<catversion>`) sempre create, anche senza file dentro: un `CREATE DATABASE` rigiocato dopo il punto di coerenza le richiede (PANIC altrimenti).
- **Copia d'istanza senza effetti verso l'esterno**: oltre all'archiviazione, nessun worker di replica logica (`max_logical_replication_workers = 0`, anche nell'istanza effimera) e senza le librerie preload che lavorano su altri server (pg_cron, pglogical, pgactive/bdr…). `restore_database` stacca le sottoscrizioni dallo slot del publisher (`slot_name = NONE`).
- **Ruoli**: il catalogo del backup registra i ruoli usati da ogni database (piano: ruoli mancanti prima del recupero); opzione segnaposto NOLOGIN senza password né appartenenze.

### 7e. Destinazione dei backup che cambia (12/10)

- **Due scrittori**: l'agent (backup, scadenza, migrazione) e il server PostgreSQL (`archive_command`). Il controllo prova entrambi; quello del server passa da PostgreSQL stesso (`COPY (SELECT 1) TO PROGRAM 'pg-arca-wal probe <dir> <token>'`), così utente e ambiente sono quelli reali dell'archiviazione.
- **Posizioni precedenti in sola lettura**: `Repo(previous=…)` e `WalManager(previous=…)`. Letture (set, manifest, catalogo, blocchi, segmenti, history) cercano anche lì; scritture, deduplica, scelta del padre di un incrementale, pulizia dei set falliti e scadenza solo nella posizione attuale (`own_sets`). Una nuova posizione è quindi autosufficiente; un PITR che parte da un set vecchio e attraversa il cambio legge WAL da entrambi gli archivi.
- **Archiviazione**: l'`archive_command` legge la configurazione dell'agent, quindi il cambio vale dal segmento successivo senza toccare PostgreSQL né il DCS; la verifica del primo segmento decide se tenere il cambio o tornare indietro.
- **Migrazione**: solo i set e i WAL dello stanza del cluster (una radice può ospitare più cluster); blocchi prima, poi la cartella del set rinominata in un colpo; ogni file riletto e confrontato (sha256); blocchi con data di modifica nuova (la tolleranza del garbage collector li protegge finché il loro set non arriva); riprendibile; la sorgente non si cancella mai qui.

## 7f. Riesame dell'architettura (15/10 notte, richiesta utente: «più velocità e intelligenza, norme enterprise, best practice DBA»)

Metodo: lettura completa del percorso dati (backup → archivio WAL → restore), confronto con quello che fanno pgBackRest, Barman e WAL-G, e con ciò che un DBA senior si aspetta. Per ogni punto: **che cosa c'è**, **che cosa manca**, **che cosa è stato fatto stanotte**, **che cosa resta** (con come misurarlo). Niente numeri inventati: dove non c'è una misura è scritto «da misurare».

### Dove va davvero il tempo (modello)
Un backup pg_arca è: lettura sequenziale del datadir (I/O) → hash blake2b per chunk (CPU) → compressione zstd (CPU) → scrittura nel CAS (I/O, molti file piccoli) → `sync` globale → **attesa WAL**. Un restore è: lettura CAS → decompressione → scrittura (I/O) → **recovery di PostgreSQL** (replay WAL, seriale per natura) → dump/restore per i ripristini granulari.
- Le fasi CPU scalano con i thread (`process_max`, default 4): zstd e blake2b rilasciano il GIL.
- L'attesa WAL era un **buco funzionale**, non di prestazioni: su standby nessuno chiudeva il segmento (→ 120 s poi fallimento), e con archivi locali per nodo il backup da standby era impossibile senza che nessuno lo dicesse. **Fatto stanotte**: switch orchestrato dal primario, diagnosi `PGA-WAL-021` in meno di un minuto, progresso visibile.
- La barriera a lotti di 512 file teneva fermi i thread alla coda di ogni lotto, sia in backup sia in restore. **Fatto stanotte**: finestra scorrevole. Guadagno **da misurare** sul lab con `bench_backup.py` (atteso: visibile su cluster con poche relazioni grandi e molte piccole, nullo su un datadir uniforme).

### Confronto onesto con lo stato dell'arte
| Aspetto | pgBackRest / Barman / WAL-G | pg_arca oggi | Giudizio |
|---|---|---|---|
| Incrementale | pgBackRest: block incremental (mappa di blocchi), delta per file su timestamp/checksum; PG17 WAL summaries | per pagina (pd_lsn) ma **legge tutto il datadir** | il risparmio è su scrittura/spazio, non su I/O di lettura: su istanze da terabyte è il limite più serio |
| Parallelismo | processi multipli, pipeline per file | thread, pipeline per chunk | adeguato fino a qualche centinaio di GB; **da misurare** oltre |
| Destinazioni | locale, S3/Azure/GCS nativi, SFTP (Barman), cifratura in repo | locale, NFS/SMB montate, cifratura opzionale | **S3 nativo è table stakes**: primo investimento post-RC (backend `engine/storage/` a oggetti, upload multipart, retry, verifica ETag/sha; il CAS a chunk si presta bene) |
| Repository remoto | pgBackRest: host di repository dedicato via SSH/TLS | il «backup server» è una share montata sui nodi | funziona ed è spiegato (stanotte: export/mount guidati); un **trasporto diretto agent→worker** (HTTPS, chunk) eviterebbe NFS: progetto, non urgente |
| Verifica | `verify`, checksum dei file | quick/deep verify, catena chunk, restore drill con RTO | alla pari o meglio (il drill con RTO misurato è un punto di forza) |
| Retention | per quantità/tempo di full, archivio WAL coerente | policy per ambiente/cartella/cluster, GC con grazia 48 h | alla pari; manca la **retention basata su «ultimo restore verificato»** (idea) |
| Restore granulare | nessuno (pgBackRest ripristina il cluster; il DBA fa il resto) | tabella/righe/database/schema con dipendenze, quarantena, promozione | **il vantaggio competitivo**: nessuno dei tre lo ha |
| Standby | backup da standby supportato con archivio condiviso | idem, ora con lo switch orchestrato e la diagnosi | alla pari |
| Osservabilità | log, `info`, metriche esterne | console, briefing, audit, timeline | meglio |

### Difetti strutturali trovati stanotte (tutti corretti, con test)
1. Backup su standby: switch WAL mai richiesto al primario; archivio non condiviso mai diagnosticato.
2. Nome membro Patroni ≠ hostname: righe doppie, switchover che fallisce con «not a member».
3. Fencing geo: il vecchio sito veniva declassato solo quando era già tornato primario (finestra di split-brain ≈ 65 s sul lab).
4. Ramo morto di timeline: nessuna azione di prodotto, archiviazione bloccata per ore.
5. UI: focus rubato a ogni poll (cursore che salta, copia/incolla che si perde).
6. Backup server: esito del check senza motivi né rimedi.

### Piano (ordine di valore, con criterio di misura)
1. **Bench sul lab** della finestra scorrevole (prima/dopo, `bench_backup.py` e `bench_restore.py`, datadir 10 GB misto): numeri in questo documento. *Prima misura (15/10, locale, 2 vCPU, 450 MB uniformi, `process_max=4`): lotti 9,0 s / 50 MB/s, finestra 9,4 s / 48 MB/s → nessuna differenza (CPU-bound su 2 core, file di taglia simile). Il beneficio atteso vale solo con più core e un datadir sbilanciato: da misurare sul lab prima di dichiararlo.*
2. **Incrementale senza leggere tutto**: su PG ≥ 17 usare i WAL summaries (`summarize_wal=on`, `pg_wal_summary_contents`) per saltare i file senza blocchi cambiati; sulle versioni precedenti un pre-filtro per relazione da `pg_stat_*`? no: non affidabile. Criterio: byte letti dal datadir per un incrementale su cluster scarico ≈ byte dei file cambiati.
3. **S3/MinIO nativo** (`engine/storage/` con interfaccia locale/S3; stesso CAS; test con MinIO sul lab). Criterio: backup+restore+verify+GC verdi su MinIO; cifratura lato client invariata.
4. **Pre-flight del backup da standby** lato console: se la destinazione è «locale» e il nodo scelto è una replica, dirlo *prima* di partire (oggi si scopre in < 1 min con `PGA-WAL-021`).
5. **Restore di oggetti per relazione** (già in piano, §7): estrarre solo i file della tabella + TOAST + catalogo; criterio: tempo di «tabella da 1 GB in un database da 500 GB» indipendente dalla taglia del database.
6. **Trasporto diretto agent→worker** (sostituisce NFS per chi non può montarlo): progetto dopo S3.

### 7g. Formato 2 del repository: pack file (15/10 mattina)
**Difetto strutturale.** Il CAS scriveva **un file per chunk da 64 KiB**: un database da 100 GB sono 1,6 milioni di file (più 65 536 directory). Ogni chunk costava una `create` + `rename` (e una `stat` per la deduplica). Su disco locale è una quota visibile del backup full; su NFS/SMB — dove un'azienda tiene i backup — ogni operazione di metadati è un round trip di millisecondi e i soli metadati durano più della copia. È la ragione per cui restic, borg e i bundle di pgBackRest non scrivono un file per chunk.

**Soluzione** (`engine/packs.py`, `Repo` in `engine/repo.py`): `cas/packs/<id>.pack` = migliaia di record `[hash 32][len u32][blob]` (il blob è identico a prima: tag + compresso [+ cifrato]); `<id>.idx` = indice ordinato per hash, scritto **dopo** l'fsync del pack e **prima** del manifest che ne riferisce i chunk (`Repo.flush()` nel commit del backup e in ogni uscita, anche su errore: i chunk di un tentativo fallito restano deduplicabili). Pack immutabili, chiusi a 256 MiB (`PG_ARCA_PACK_MAX_MB`) o a fine backup; un writer per thread. Indice in memoria: lista ordinata di hash + due array (≈55 byte per chunk: 100 GB ≈ 90 MB), ricerca con `bisect` in C; i chunk scritti dal processo in un dizionario ripiegato ogni 262 144 voci. Lettura con descrittori riusati per thread (`pread`). Un pack ancora aperto di un processo morto (`.pack.open`) è invisibile e viene rimosso dopo la grazia; un pack chiuso senza indice (crash tra i due passi) viene re-indicizzato dal contenuto.

**Garbage collection** (`maintenance._gc_cas`): mark & sweep come prima (hash vivi da tutti i manifest di tutte le stanza); pack più giovani della grazia (48 h) mai toccati e la deduplica contro un pack ne rinfresca l'mtime (stessa garanzia dei file: un backup senza manifest non perde mai un chunk riusato); pack tutto morto → cancellato; pack morto per ≥ 25 % → riscritto senza i chunk morti (nuovo pack sigillato **prima**, vecchio cancellato **dopo**: nessun momento senza copia). Un lettore con indice vecchio ricarica l'indice al primo ENOENT (un descrittore già aperto continua a leggere il pack cancellato, che è immutabile).

**Compatibilità.** I repository di formato 1 restano leggibili per sempre (file in `cas/aa/bb/`), si deduplica anche contro di essi e la GC li spazza come prima; i nuovi chunk vanno nei pack; `repo.json` passa a `format: 2` (un motore di sviluppo precedente a questa modifica **non** legge i pack: mai puntare un agent vecchio a un repository scritto da rc.1). La migrazione di destinazione copia i chunk blob-per-blob, verificati, nei pack della nuova sede.

**Misure (15/10, locale, 2 vCPU, zlib, 449 MB, `process_max=4`)**: backup full **7,2 s / 63 MB/s** (fase copia 5,1 s = 88 MB/s) contro 9,0–9,4 s / 48–50 MB/s delle misure precedenti sullo stesso banco: **+30 %** su disco locale, dove il costo per file è minimo. Su NFS/SMB il guadagno atteso è di un ordine di grandezza **[da misurare sul lab con una share reale]**. Micro-bench a parte (50 000 chunk, ext4): 229 µs/chunk con un file per chunk, 143 µs con il pack (hash compreso in entrambi).

**Lettura a run** (`Repo.get_chunks`, usata da `restore._write_one` a finestre di 128 chunk): i chunk di un file sono adiacenti nel pack (scritti in ordine dallo stesso thread), quindi un file di 8 MiB si legge con **una** `pread` invece di 128; su NFS sono 128 round trip in meno per ogni 8 MiB. Misura locale (`bench_restore 400 50`): estrazione di 674 MB in 4,3 s (157 MB/s); nessuna misura «prima» sullo stesso banco per questa fase. Il resto del restore è dominato da WAL (`wal_flush` 10-17 s, `recovery` 21-27 s per 172 segmenti): è lì che conviene lavorare dopo (read-ahead già presente).

**Verifica profonda** (`maintenance.verify(deep=True)`): ogni chunk viene localizzato e, se profondo, letto e controllato **una volta sola** anche se dieci set lo condividono, in ordine di pack e offset (I/O sequenziale, letture a run) invece che set per set in ordine di manifest (letture casuali, lo stesso chunk dieci volte). Il corrotto viene attribuito a tutti i set che lo riferiscono.

**Test**: `tests/test_packs.py` (15: roundtrip, deduplica tra processi, rollover, thread, fold, crash con pack aperto, re-indicizzazione, writer rotto abortito e dimenticato, GC cancella/riscrive/rispetta la grazia, lettore con indice vecchio, formato 1 letto/deduplicato/spazzato, sede precedente, scansione record); suite con PG16 reale rieseguite: engine 35, standby 6, failover 6, crash 2, restore_faults 6, destination_switch, destination_migrate, dest_standby, wal_rescue, targets — tutte verdi.

### 7h. Incrementali che leggono solo ciò che è cambiato (PostgreSQL 17+, WAL summaries) — 15/10 mattina
**Prima**: ogni incrementale leggeva **tutti** i file di relazione del cluster e teneva i chunk con pagine più recenti del backup padre: corretto, ma 500 GB letti per ogni incrementale di un cluster da 500 GB con l'1 % di churn. **Ora** (`engine/walsummary.py`, `_plan_with_summaries` in backup.py): con `summarize_wal = on` (PG 17+) l'agent legge `pg_available_wal_summaries()` e, dopo aver atteso che il summarizer raggiunga lo start LSN del backup (fino a 90 s; è ciò che fa `pg_basebackup --incremental`), unisce `pg_wal_summary_contents()` dei riassunti che coprono **contiguamente** [start LSN del padre, start LSN di questo backup]. Per ogni file di relazione (main fork): non citato e stessa taglia del padre → **non letto** (voce di manifest senza chunk, il merge del restore prende i chunk del padre); citato → letti **solo i chunk** con blocchi cambiati (test LSN di pagina ancora applicato); troncato (`is_limit_block`), nuovo, taglia diversa, fork FSM/VM/init e file non di relazione → letti per intero come prima.

**Sicurezza**: copertura non contigua, summarizer in ritardo, errori di lettura → scansione completa con `PGA-INC-011/012/013` nel log (mai un backup incompleto in silenzio). **Controllo a campione**: prima della copia, l'1 % dei file «non cambiati» (3-50) viene scansionato per intero alla vecchia maniera; un solo chunk cambiato lì e i riassunti **non vengono usati** per quel backup (`PGA-INC-014`, errore nel log). `PG_ARCA_WAL_SUMMARIES=0` li spegne. `meta.wal_summaries` registra l'esito; `stats.bytes_not_read`/`files_not_read` nel riepilogo. Finding della console `summarize_wal_off` (info) quando PG ≥ 17, policy con incrementali e parametro off (Patroni: via DCS).

**Stato delle prove**: `tests/test_walsummary.py` (7, sessione finta: copertura, mappatura riga → file/chunk, piano, lettura sparsa); `tests/test_wal_summary_pg.py` con PostgreSQL 17+ reale (incrementale che non legge la tabella grande, restore byte-per-byte, troncamento, tabella nuova, fallback con `summarize_wal` off) **non ancora eseguito: qui c'è solo PG 16** → nella matrice del lab (`tools/lab/matrix.sh`, versioni 17 e 18). Finché non passa lì, la funzione è **[non provata su PG17 reale]**; su PG ≤ 16 e con summaries off il percorso è quello di prima (suite PG16 verdi).

## 8. Registro delle modifiche

| Data | Modifica | Provato |
|------|----------|---------|
| 14/10 | **Il ripristino finisce nell'originale**: tabella rimessa a posto, tutte le righe riportate, database al posto dell'originale (§4.2); **server di produzione rimesso a posto al suo posto** (§4.1 punto 9: ricostruzione accanto a PGDATA, stop/scambio/avvio, rollback automatico, produzione ferma con i WAL non archiviati recuperati dal suo `pg_wal`) | PG16 reale: `test_db_swap_pg` (3), `test_engine_pg` (35), `test_replace_pg` (6: piano, rifiuti, rollback, PITR al suo posto, produzione in crash con WAL non archiviati, cartelle conservate), `test_replace_unit` (4); UI con agent simulato `tests/ui/e2e.cjs`; **lab non ancora** |
| 13/10 | **Ripristino d'istanza che inizia e finisce il lavoro**: destinazione proposta per volume, copia avviata e seguita fino al target, registro con scadenza, riavvio automatico, azioni dalla console; **recupero di tutte le righe** di una categoria (oltre le 200 mostrate); impronta del codice dell'agent e avviso «agent da aggiornare» | PG16 reale: `test_restored_pg` (10), `test_engine_pg` (35); via web UI sul lab: `tools/lab/ui/restore-ui.cjs` (tabella, righe, database, istanza) |
| 12/10 | Destinazione che cambia senza perdere PITR (posizioni precedenti in sola lettura), verifica dei due scrittori, verifica del primo segmento con ritorno automatico, migrazione verificata e riprendibile, eliminazione esplicita; ripristino «a ora» con cambio di segmento del primario | PG16 reale: `test_destination_switch_pg`, `test_destination_apply_pg`, `test_destination_migrate_pg` (anche cifrato), `test_destcheck_pg`, `test_wal_flush_pg`; prove a ritroso per PITR a cavallo e WAL «a ora». NFS/SMB reali non provati |
| 12/10 | Estensioni/collation, tipo riga di tabelle (colonne, funzioni), funzioni `BEGIN ATOMIC` riagganciate, cartelle di versione dei tablespace, copia/ripristino di subscriber (slot), librerie preload nella copia, ruoli segnaposto | PG16 reale: `test_objects_ext_pg` (12), `test_tablespace_later_pg`, `test_logical_copy_pg` (publisher reale), `test_restore_database_props_pg` (6); prove a ritroso per tablespace, slot e funzioni. pg_cron non provato (non installabile) |
| 12/10 | Sicurezza: tablespace creati dopo il full non toccano più il tablespace vivo; copia d'istanza senza archiviazione; annullamento e ripristini interrotti; forense DML; template FILE_COPY | PG16 reale: `test_tablespace_later_pg`, `test_cancel_restore_pg`, `test_forensics_dml_pg`, `test_late_created_pg` 6, `test_archive_enable_pg` |
| 12/10 | Casi reali del restore (§7d): partizioni singole, ereditarietà, statistiche estese, sequenze condivise, domini con funzioni, oggetti/database creati dopo il backup, proprietà del database, consegna a un altro server, regole/policy/pubblicazioni/default ricollegati, righe senza PK, lock | PG16 reale: `test_objects_exotic_pg` 9, `test_objects_deps_pg` 9, `test_late_created_pg` 5, `test_restore_database_props_pg` 3, `test_into_other_server_pg` 2, scala 300/1500 tabelle; anche con repository cifrato e segmenti WAL da 64 MB; matrice 14-18 da rieseguire |
| 11/10 | **Restore oggetti v2** (selezione multipla di tabelle/schemi, chiusura delle dipendenze, promozione `replace` atomica con FK in ingresso e viste riagganciate, `missing_only`, `as_new`, dry-run) | PG16 reale (`test_objects_v2.py`, 10 test); lab Patroni da rieseguire |
| 11/10 | **Istanza di recupero configurabile** (globale/ambiente/cartella/cluster; sul nodo del target o centralizzata; binari per versione; scratch, porte, memoria; preflight; installazione PG privata o di sistema) | unit (`test_ephcfg.py` 15, `scoped.test.ts`) + `test_05a` su PG16; installazione apt/dnf e posizionamento centrale su rete **non provati** |
| 11/10 | **Destinazione dei backup** (local / NFS / SMB montati; controllo reale per nodo: filesystem, scrittura O_EXCL+fsync+rename, spazio; applicazione solo dopo controllo riuscito su ogni nodo) | unit (`test_destcheck.py` 11, `destinations.test.ts`); mount NFS/SMB reali **non provati**; S3/Azure/GCS/SFTP = Anteprima |
| 11/10 | Target oltre fine archivio: recupero fino a fine archivio (`target_clamped`), errore chiaro `PGA-PITR-014`, race in `wait_target` | PG16 reale + lab Patroni |
| 11/10 | Restore di un database **cancellato** (`DROP DATABASE`): PostgreSQL lo rende invalido (in-place update, da PG15) e ne rimuove la cartella rigiocando il WAL **prima** del commit, quindi nessun target a tempo/xid basta. Il motore ora lo rileva (`pg_waldump`), si ferma con un LSN prima del DROP e lo dichiara (`stopped_before_drop`) | PG16 reale (`test_05c`); sul lab Patroni da ripetere |
| 11/10 | Catalogo: conteggi solo tabelle utente, dimensione reale (heap+TOAST+indici+partizioni), indice→tabella e partizione→padre nel catalogo | PG16 reale (`test_06c`) |
| 11/10 | `promote_object` in modalità replace su tabella sparita: torna con il suo nome e nel suo schema (prima prendeva il suffisso `_pitr_`) | PG16 reale (`test_06d`) |
| 11/10 | **Forense WAL veloce** (`walscan.py`), **read-ahead del restore_command** (`walprefetch.py`), `pg_dump` zstd:1, **pre-flight del restore** (`restorecheck.py`), conferma digitata per `replace`, finestra log dell'operazione, elenco database con DROPPED | PG16 locale, misure in §7c; lab Patroni da rieseguire |
| 11/10 | Patroni: parametri e pg_hba solo via DCS; mai file/ALTER SYSTEM; rifiuto se l'API non risponde; DCS senza `pg_hba` inizializzato con le regole in vigore | test con Patroni simulato (`test_patroni_dcs_only`); non ancora sul lab |
