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

Target supportati: ultimo istante disponibile, tempo, LSN, xid, nome (restore point), "immediate" (fine del backup).
**Target oltre la fine dell'archivio** (tempo o LSN): il motore recupera fino all'ultimo WAL disponibile e lo dichiara (`target_clamped`) invece di fallire con `PGA-PITR-010`. Per xid/nome inesistenti o archivio con buchi dà un errore chiaro (`PGA-PITR-014`) con posizione raggiunta e coda del log. Provato su PG16 reale e sul lab Patroni.

### 4.2 Restore granulare (`engine/granular.py`)

Per database, tabella o righe **non** si ricostruisce il cluster intero:

1. **Estrazione sparse** (`sparse_filter`): si materializzano solo i file del database richiesto, `template1` e `global`; degli altri database restano solo `PG_VERSION` e `pg_filenode.map`.
2. Si avvia un'**istanza effimera** isolata (porta e socket propri, configurazione di produzione neutralizzata: niente archiviazione, niente repliche), che rigioca il WAL fino al target.
3. I dati escono con `pg_dump`/`pg_restore` verso la destinazione (stesso cluster, un altro, o un database di quarantena `pgarca_stage_*`).
4. L'istanza effimera viene distrutta; i database di quarantena sono riconoscibili e mai confusi con database utente.

Operazioni: `restore_database` (nome nuovo, mai sovrascrive), `restore_object` (una tabella in quarantena), `restore_diff` (confronto riga per riga con la tabella viva), `restore_apply_rows` (reinserisce/elimina solo le righe scelte, con copia di sicurezza), `restore_promote` (riporta la tabella: `as_new` accanto all'originale, `replace` con l'originale rinominato e mai cancellato; una tabella già sparita ritorna con il **suo nome nel suo schema**, schema ricreato se serve).

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
| Restore oggetto = una tabella, senza dipendenze | FK, viste, sequenze, trigger non vengono ricreati | restore oggetto v2: calcolo delle dipendenze, ricreazione, modalità schema (in lavorazione: `engine/objects.py`, non ancora collegato) |

## 8. Registro delle modifiche

| Data | Modifica | Provato |
|------|----------|---------|
| 11/10 | Target oltre fine archivio: recupero fino a fine archivio (`target_clamped`), errore chiaro `PGA-PITR-014`, race in `wait_target` | PG16 reale + lab Patroni |
| 11/10 | Restore di un database **cancellato** (`DROP DATABASE`): PostgreSQL lo rende invalido (in-place update, da PG15) e ne rimuove la cartella rigiocando il WAL **prima** del commit, quindi nessun target a tempo/xid basta. Il motore ora lo rileva (`pg_waldump`), si ferma con un LSN prima del DROP e lo dichiara (`stopped_before_drop`) | PG16 reale (`test_05c`); sul lab Patroni da ripetere |
| 11/10 | Catalogo: conteggi solo tabelle utente, dimensione reale (heap+TOAST+indici+partizioni), indice→tabella e partizione→padre nel catalogo | PG16 reale (`test_06c`) |
| 11/10 | `promote_object` in modalità replace su tabella sparita: torna con il suo nome e nel suo schema (prima prendeva il suffisso `_pitr_`) | PG16 reale (`test_06d`) |
| 11/10 | Patroni: parametri e pg_hba solo via DCS; mai file/ALTER SYSTEM; rifiuto se l'API non risponde; DCS senza `pg_hba` inizializzato con le regole in vigore | test con Patroni simulato (`test_patroni_dcs_only`); non ancora sul lab |
