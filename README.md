# pg_arca

Console e agent per **backup, ripristino a un istante preciso (PITR) e gestione dei cluster PostgreSQL**.

- **Console web** (Node/Express + React): inventario cluster, nodi, alta affidabilità (Patroni), parametri, backup, ripristino, registro attività.
- **Agent Unix** (Python 3.6+, solo libreria standard): gira sul server del database, apre la connessione verso la console (nessuna porta in ingresso), esegue le operazioni e contiene il motore di backup/ripristino.

> Questo documento descrive **ciò che esiste ed è stato eseguito**. Le parti non ancora reali sono elencate esplicitamente in [Stato](#stato-reale-delle-funzioni).

## Stato reale delle funzioni

| Area | Stato | Come è stato verificato |
| --- | --- | --- |
| Collegamento cluster con agent (token monouso, iscrizione, heartbeat, long-poll) | Funziona | Test end-to-end agent↔console su HTTP con le route reali |
| Collegamento cluster **senza** agent (connessione PostgreSQL, Patroni REST opzionale) | Scritto, **mai eseguito contro un PostgreSQL reale** (il pacchetto `pg` non è installabile nell'ambiente di sviluppo) | Solo test con stub: provarlo prima di fidarsene |
| Operazioni (idempotency-key, lease, ri-consegna, TTL, annullamento, corsie controllo/dati) | Funziona | `tests/server/ops.test.ts`, `api.test.ts` |
| Backup completo / differenziale / incrementale a livello di pagina, deduplica, verifica di ogni blocco in lettura | Funziona | 15 test su **PostgreSQL 16 reale** (`unix-agent/tests/test_engine_pg.py`) |
| Ripristino istanza con PITR (tempo / LSN / xid / nome), verifica copertura WAL prima di partire | Funziona | idem |
| Ripristino di **un database** (estrae solo i suoi file) e di **una tabella** (in database di quarantena) | Funziona | idem |
| **Il ripristino finisce nell'originale** (scelta «Alla fine»): tabella rimessa a posto, righe riportate, database al posto dell'originale (l'attuale conservato), **server di produzione rimesso com'era al suo posto** (ricostruito accanto ai dati, stop/scambio/avvio, rollback automatico, anche a produzione ferma senza perdere i WAL non archiviati; non su Patroni) | Provato su PG16 reale; UI con agent simulato; lab non ancora | `test_replace_pg.py`, `test_db_swap_pg.py`, `test_engine_pg.py`, `tests/ui/e2e.cjs` |
| Prova di ripristino (recupera davvero l’ultimo backup in un’istanza temporanea) | Funziona | idem |
| Pulizia (retention, garbage collection dei blocchi, WAL) | Funziona | idem |
| Ricerca DROP/TRUNCATE nei WAL (`pg_waldump`) | Funziona | idem |
| Pianificazione backup (idempotente, back-off, retention, verifica periodica) | Funziona | `tests/server/scheduler.test.ts` |
| Alta affidabilità: switchover, failover, riavvio membro, manutenzione (Patroni) | Precondizioni e verifica dell’effetto; switchover provati dalla console sul lab Patroni reale (3 nodi e coppia geo) | Test con Patroni simulato, `tools/lab/scenario-geo.py`, `scenario-ha.sh` |
| Parametri (`ALTER SYSTEM` + reload) | Scritto; provato con psql simulato | `unix-agent/tests` |
| Interfaccia web | Funziona nel browser (Chromium) con agent simulato | `tests/ui/e2e.cjs` |
| Ripristino guidato per situazione (tabella eliminata o svuotata, righe sbagliate, database com'era, tutto il server), momento proposto dai WAL, controllo in parole semplici | Funziona nel browser con agent simulato | `tests/ui/e2e.cjs` |
| Fluidità: ciò che si scrive o sceglie resta quando si cambia scheda, si apre un'impostazione dall'interno di un modulo o si torna indietro (bozze in memoria e nella sessione del browser, mai per password, token o URL dei webhook; cancellate a salvataggio, annullamento e logout); finestre con dati inseriti protette dai clic fuori; posizione di scorrimento ripristinata con Indietro | Funziona nel browser con agent simulato | `tests/ui/fluidity.cjs` |
| Layout su desktop e telefono (nessuna pagina più larga dello schermo, nessun testo tagliato) | Controllato su tutte le pagine e schede | `tests/ui/sweep.cjs` |
| Strategie di backup per cartella / ambiente / cluster (modelli suggeriti e personalizzati, ereditarietà) | Funziona: risolte a ogni tick dello scheduler, nessuna copia | `tests/server/policies.test.ts`, `tests/ui/e2e.cjs` |
| Gestione pg_hba (Patroni: SOLO DCS, il file non viene mai letto né scritto; altrimenti file; simulazione anti lock-out, verifica con `pg_hba_file_rules`, versioni precedenti / rollback) | Agent provato su PostgreSQL 16 reale (Patroni simulato che riscrive e ricarica); DCS su lab Patroni provato il 11/10 (9/9) prima delle ultime modifiche, da rieseguire `tools/lab/hba-all.sh` | `unix-agent/tests/test_hba*.py`, `tests/server/hba.test.ts`, `tests/ui/hbalogic.test.ts` |
| Assistente HBA nella UI (duplicati, regole oscurate, ordine, descrizioni, modelli) | Funziona nel browser con agent simulato | `tests/ui/e2e.cjs` |
| Rilevamento: consigli dell'agent e differenze tra nodi | Funziona | `tests/server/discovery.test.ts`, `unix-agent/tests/test_discovery_advisor.py` |
| Riporta una tabella ripristinata nel database (`as_new` / `replace`, non distruttivo) | Agent provato su PG16; | `test_engine_pg.py` |
| Restore di oggetti con dipendenze e di schemi interi (FK, viste, sequenze, tipi, ACL; `replace` atomico / `missing_only` / `as_new`; anteprima prima di toccare nulla) | Provato su PG16 reale; lab Patroni da rieseguire | `test_objects_v2.py` |
| Istanza di recupero configurabile (globale/ambiente/cartella/cluster; sul nodo o centralizzata; binari per versione; installazione PG privata o di sistema) | Configurazione e preflight provati; installazione e posizionamento centrale **non provati su rete reale** | `test_ephcfg.py`, `scoped.test.ts` |
| Destinazione dei backup per cluster/ambiente/cartella/globale: cartella locale o condivisione NFS/SMB montata (S3/Azure/GCS/SFTP: Anteprima). Controllo su ogni nodo con **entrambe le utenze che scrivono** (agent e server PostgreSQL via `COPY … TO PROGRAM`, come l'archive_command), permessi, mappatura utenti delle condivisioni, inode, `soft`/`ro`, archivio WAL di un altro cluster, comandi di correzione. Applicazione con verifica del primo segmento WAL (altrimenti ritorno automatico alla cartella precedente) e approvazione a quattro occhi sugli ambienti protetti. La posizione precedente resta **leggibile dai ripristini** (anche PITR a cavallo del cambio); **migrazione in background** verificata, riprendibile, con limite di banda, spazio e durata stimata prima di partire; eliminazione della vecchia solo esplicita | PG16 reale: cambio, PITR a cavallo, migrazione interrotta e ripresa, cifrato, rollback del WAL; utenze diverse provate con `runuser`. Mount NFS/SMB reali **non provati** (lab) | `test_destcheck.py`, `test_destcheck_pg.py`, `test_destination_switch_pg.py`, `test_destination_apply_pg.py`, `test_destination_migrate_pg.py`, `destinations.test.ts`, e2e UI |
| Tuning guidato (RAM/core dell'agent + carico → parametri, applicati con `pg_set_param`) | Funziona; regole generali di dimensionamento, non misure | `tests/ui/tuning.test.ts` |
| Utenti e ruoli (amministratore / operatore / sola lettura), sessioni revocate al cambio ruolo | Funziona; negazione per default su ogni rotta che modifica | `tests/server/rbac.test.ts` |
| Cifratura del repository (AES-256-GCM su blocchi, manifest, cataloghi e archivio WAL; identificativi dei blocchi con chiave; chiave fuori dal repository) | Funziona; provata con l'intera suite su PG16 con repository cifrato (`PG_ARCA_TEST_ENCRYPT=1`). Un repository esistente non si cifra sul posto: ne serve uno nuovo. Richiede il pacchetto Python `cryptography`. File `.history`/label dei WAL restano in chiaro | `unix-agent/tests/test_crypto.py`, `test_engine_pg.py` |
| Macchine operative (backup server, host di recupero): agent senza ricerca del database, inventario, pagina dedicata, uso come nodo dei ripristini | Server e agent con test; UI con agent simulato; lab non ancora | `tests/server/workers.test.ts`, `test_worker.py`, `tests/ui/e2e.cjs` |
| Più DBA sullo stesso cluster: conflitti rifiutati con chi/cosa/da quando, attività in corso visibile | Server con test; UI con agent simulato | `tests/server/conflicts.test.ts` |
| Spazio su disco per volume prima di ripristini e promozioni (scratch + dati del cluster sommati) | Agent provato su PG16; UI con agent simulato | `test_restorecheck.py`, `test_objects_v2.py` |
| Analisi dei WAL per trovare DROP/TRUNCATE (parallela, con cache) e DROPPED in rosso nella scelta del database | Agent provato su PG16 (2,1 s a freddo, 0,02 s con cache sul test locale); UI con agent simulato | `test_walscan.py`, `tests/ui/e2e.cjs` |
| Controlli prima del restore (catena di chunk, spazio, nome occupato) e read-ahead dei WAL | Agent provato su PG16 (recovery −38 % misurato); UI con agent simulato; lab non ancora | `test_restorecheck.py`, `test_walprefetch.py`, `tests/ui/e2e.cjs` |
| Recupero di singole righe (confronto per chiave primaria tra tabella ripristinata e attuale, copia di sicurezza, una sola transazione) | Agent provato su PG16; UI provata con agent simulato | `test_engine_pg.py::test_06b0`, `tests/ui/e2e.cjs` |
| Prova di disaster recovery (ripristina l'intero cluster in scratch, lo avvia, controlla ogni database, misura il tempo) | Provata su PG16 (cluster di test piccolo): il tempo misurato vale per quel server e volume di dati | `test_engine_pg.py::test_06x` |
| Pagina «Oggi»: problemi con causa e passo successivo (backup mancanti/vecchi, buchi WAL, archiviazione che fallisce, slot inattivi, repliche in ritardo, dischi, connessioni, verifica/drill in ritardo) | Funziona sulla telemetria; soglie generali, non tarate | `tests/server/health.test.ts` |
| Notifiche webhook (JSON o testo Slack/Teams): nuovo problema, promemoria, risolto; ritenta dopo un errore; l'URL non torna mai al browser | Funziona (provato contro un server HTTP locale); **non provato contro Slack/Teams reali; niente email** | `tests/server/health.test.ts` |
| Georidondanza: siti primario/replica (standby_cluster Patroni o standby fisico), relazioni rilevate o indicate a mano, albero nella flotta, switchover pianificato e promozione DR tramite il DCS di ogni sito | Console con agent simulati (`tests/server/geo.test.ts`, e2e); lab geo (2 siti Patroni + bk1) verificato con `geo.sh verify`; **switchover reale tra i siti del lab non ancora eseguito** | `tests/server/geo.test.ts`, `tools/lab/geo.sh` |
| Approvazione a due persone per ambiente (pg_hba, parametri, HA, sostituzione tabella, recupero righe) | Funziona; richiede almeno due amministratori attivi | `tests/server/approvals.test.ts` |
| HBA: adozione delle regole esistenti nel blocco gestito (ordine di valutazione invariato) e regole temporanee con scadenza | Agent provato su PG16; scadenza guidata dallo scheduler; anche su Patroni (nel DCS, un solo membro la applica) | `test_hba_pg.py::test_5`, `tests/server/hba.test.ts` |
| Nuovi server che si annunciano da soli (agent installato senza token → richiesta in attesa → approvazione nella UI con scelta di ambiente/cluster) | Funziona, provato con l'agent reale contro la console reale; il segreto lo genera l'agent e alla console arriva solo l'hash. Endpoint non autenticato, quindi limitato (100 in attesa, 10 per indirizzo, scadenza 48 h) e disattivabile in Impostazioni | `tests/server/join.test.ts`, `unix-agent/tests/test_e2e_console.py`, `tests/ui/e2e.cjs` |
| LDAP/AD | **Anteprima**: visibile e marcata, senza funzione dietro | — |
| Velocità rispetto a pgBackRest | **Mai misurata**: nessuna affermazione | — |

| Restore: oggetti con nomi insoliti (spazi, unicode, punti, 63 caratteri), RLS, exclusion, ereditarietà, **singola partizione** (riattaccata alla tabella viva), statistiche estese, sequenze condivise, domini con funzioni, viste/sequenze da sole, oggetti e database **creati dopo l'ultimo backup**, proprietari/permessi/impostazioni del database, consegna a un altro server senza i suoi tablespace/ruoli, pubblicazioni/regole/policy/default di altre tabelle ricollegati, schema di 1500 tabelle (limite dei lock detto prima) | Provato su PostgreSQL 16 reale; matrice 14-18 da rieseguire con questi test | `test_objects_exotic_pg.py`, `test_objects_deps_pg.py`, `test_late_created_pg.py`, `test_restore_database_props_pg.py`, `test_into_other_server_pg.py`, `test_scale_schema_pg.py` (opt-in) |
| Riavvio di un PostgreSQL singolo dalla console (unità systemd del server via polkit limitato, o pg_ctl senza systemd) | `pg_ctl` provato su PG16 reale; systemd/polkit con test simulati, **da provare sul lab** | `test_pgrestart.py`, `test_archive_enable_pg.py` |
| Aggancio: token per più server (nodi Patroni), esito dell'iscrizione stampato dall'installer, token scaduto/usato → annuncio per approvazione | Agent reale contro console reale | `tests/server/api.test.ts`, `test_e2e_console.py` |

Limiti noti: i backup da standby richiedono `archive_mode=always`; gli incrementali richiedono `data_checksums` o `wal_log_hints`; backup e ripristino richiedono l’agent sul server; una vista materializzata ripristinata da sola viene ricalcolata sui dati attuali; il recupero riga per riga richiede una chiave primaria o un indice univoco su colonne NOT NULL; una tabella creata dopo l'ultimo backup ed eliminata prima del successivo non ha un nome nell'analisi dei WAL (si ripristina l'intero database a un istante prima dell'eliminazione).

## Architettura

```
Browser ──HTTPS──> Console (server.ts) <──HTTPS (solo uscente)── Agent (su ogni nodo) ── psql / pg_ctl / Patroni REST
                      │  store.json (atomico)                         │  repository: cas/ + stanza/<cluster>/backup/<set>/
                      └─ operazioni, audit, scheduler                 └─ archivio WAL condiviso (write-once, fsync)
```

- **Repository**: archivio *content-addressed* — blocchi da 64 KiB, hash blake2b-256 verificato a ogni lettura, compressione zstd/zlib. Ogni backup è un manifesto di `[offset, lunghezza, hash]`; i blocchi uguali si memorizzano una volta sola.
- **Incrementali**: si confrontano le LSN di pagina (solo file principali; FSM/VM e altri fork interi). La catena viene validata prima di partire, altrimenti il backup diventa completo.
- **Sicurezza dei backup**: i blocchi scritti attorno a un’esecuzione interrotta vengono riverificati prima della deduplica; un solo `sync` prima del commit del backup; la garbage collection ha 48 h di tolleranza.
- **Ripristino**: non scrive mai nella data directory in uso (percorsi protetti, controllo dei symlink, mai come root). Il ripristino lavora sempre prima su una copia (nome nuovo, quarantena, cartella accanto) e solo alla fine, se scelto e confermato, la mette al posto dell'originale, che resta conservato (`<db>_before_<ts>`, tabelle `_old_<data>`, `<pgdata>.pgarca-before-<ts>`); in caso di errore ciò che è stato creato viene eliminato e l'originale non viene toccato. L’istanza temporanea usata per il recovery è isolata (nessuna rete, archiviazione spenta, sola lettura).
- **PITR**: `target_time` richiede il fuso orario; il backup di partenza è il più recente concluso prima dell’istante scelto; la copertura WAL è controllata *prima* di iniziare.
- **Operazioni**: ogni azione ha una Idempotency-Key; backup e ripristino non vengono mai ripetuti automaticamente dopo un crash; corsia *controllo* (HA, parametri) separata dalla corsia *dati* (backup, ripristino) così un backup di ore non blocca uno switchover.

## Avvio rapido

Console (serve Node 20+):

```bash
npm install
npm test                 # suite TypeScript + test Python dell’agent
npm run dev              # http://localhost:3000 — il primo accesso crea l’amministratore
# produzione: npm run build && NODE_ENV=production tsx server.ts

> Come funzionano backup e restore (formato, algoritmi, limiti, confronto onesto con pgBackRest): vedi [ARCHITETTURA-BACKUP-RESTORE.md](ARCHITETTURA-BACKUP-RESTORE.md) — da aggiornare a ogni modifica del motore.

```

Variabili: `PORT`, `PG_ARCA_DATA_DIR` (stato persistente, default `./data`), `PG_ARCA_ADMIN_USER` / `PG_ARCA_ADMIN_PASSWORD` (creazione non interattiva dell’amministratore). Metti la console dietro un reverse proxy TLS.

Agent: dalla console, **Cluster → Collega cluster → Con agent**, copia il comando e lancialo come root sul server. L’installer rileva PostgreSQL/Patroni, crea utente, directory e servizio systemd. Poi, sul primario, abilita l’archiviazione WAL (la scheda Backup mostra le righe esatte):

```ini
wal_level = replica
archive_mode = on
archive_command = '/usr/local/bin/pg-arca-wal archive %p %f'
```

Il primo backup deve essere completo; poi attiva la pianificazione dalla scheda Backup.

## Riga di comando (sul nodo)

```bash
pg-arca-cli status                    # telemetria locale
pg-arca-cli discover                  # rilevamento reale di PostgreSQL, Patroni, etcd, pgbouncer, pgBackRest
pg-arca-cli wal-check                 # continuità archivio WAL (exit 3 se ci sono buchi)
pg-arca-cli backup --type full        # full | diff | incr
pg-arca-cli info                      # backup, intervallo WAL, deduplica
pg-arca-cli verify [--deep] [--restore-test]
pg-arca-cli expire [--dry-run]
pg-arca-cli forensics                 # DROP/TRUNCATE nei WAL
pg-arca-cli restore database --db billing --target-time '2026-10-08 11:42:00+02' --rename billing_pitr
pg-arca-cli restore object --object billing.public.invoices --target-time '2026-10-08 11:42:00+02'
pg-arca-cli restore instance --destination /var/lib/postgresql/restore --target-time '2026-10-08 11:42:00+02' [--dry-run]
```

## Sviluppo e test

| Cosa | Comando |
| --- | --- |
| Server (ops, vista, API, scheduler) | `tsx tests/server/<nome>.test.ts` |
| Agent (WAL, esecutore, e2e con la console) | `cd unix-agent && python3 -m unittest discover -s tests -t .` |
| Motore con PostgreSQL 16 reale | come utente **non root** (PostgreSQL rifiuta root): `su postgres -c 'cd unix-agent && python3 -m unittest tests.test_engine_pg'` — salta da solo se manca PostgreSQL o se sei root |
| Interfaccia nel browser | `esbuild src/main.tsx --bundle --outfile=<dir>/app.js --loader:.css=css --jsx=automatic`, poi `tsx tests/ui/devserver.ts 5188 <dir>` e `node tests/ui/e2e.cjs` (Playwright; il server di test usa le route reali con un agent simulato — solo per i test) |

## Guida: cluster Patroni di prova a 3 nodi

> Procedura di laboratorio ereditata dalla prima versione del progetto: **non è stata rieseguita** durante il rifacimento. Verifica versioni e percorsi prima di usarla.

## 🚀 4. Guida Creazione Cluster Patroni 3 Nodi su KVM / Ubuntu VM

Questa guida descrive la creazione di un cluster reale con **3 Virtual Machine Ubuntu 22.04 LTS su hypervisor KVM** per una topologia ad alta disponibilità a zero downtime con quorum etcd distribuito.

### Schema Rete & Assegnazione IP

| Macchina Virtuale | Nome Host | Indirizzo IP | Ruolo Componenti |
| :--- | :--- | :--- | :--- |
| **VM 1** | `pg-node-01` | `192.168.100.11` | etcd member 1 + Patroni + PostgreSQL 16 + pg_arca Agent |
| **VM 2** | `pg-node-02` | `192.168.100.12` | etcd member 2 + Patroni + PostgreSQL 16 + pg_arca Agent |
| **VM 3** | `pg-node-03` | `192.168.100.13` | etcd member 3 + Patroni + PostgreSQL 16 + pg_arca Agent |

---

### Passo 4.1: Configurazione Base su Tutte e 3 le VM

Eseguire su **tutti e tre i nodi**:
```bash
# Aggiornamento pacchetti
sudo apt update && sudo apt upgrade -y

# Installazione repository ufficiale PostgreSQL
sudo apt install -y curl ca-certificates gnupg lsb-release
sudo install -d /etc/apt/keyrings
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg
echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list

# Installazione PostgreSQL 16, etcd, patroni e strumenti di supporto
sudo apt update
sudo apt install -y postgresql-16 postgresql-client-16 patroni etcd-server etcd-client python3-psycopg2 jq zstd lz4

# Fermare l'istanza standard di postgres creata di default (sarà gestita da Patroni)
sudo systemctl stop postgresql
sudo systemctl disable postgresql
sudo rm -rf /var/lib/postgresql/16/main/*
```

---

### Passo 4.2: Configurazione del Quorum etcd3

#### Su `pg-node-01` (`192.168.100.11`):
Modificare `/etc/default/etcd`:
```bash
ETCD_NAME="etcd-01"
ETCD_DATA_DIR="/var/lib/etcd/default.etcd"
ETCD_LISTEN_PEER_URLS="http://192.168.100.11:2380"
ETCD_LISTEN_CLIENT_URLS="http://192.168.100.11:2379,http://127.0.0.1:2379"
ETCD_INITIAL_ADVERTISE_PEER_URLS="http://192.168.100.11:2380"
ETCD_INITIAL_CLUSTER="etcd-01=http://192.168.100.11:2380,etcd-02=http://192.168.100.12:2380,etcd-03=http://192.168.100.13:2380"
ETCD_INITIAL_CLUSTER_STATE="new"
ETCD_INITIAL_CLUSTER_TOKEN="etcd-patroni-cluster"
ETCD_ADVERTISE_CLIENT_URLS="http://192.168.100.11:2379"
```

#### Su `pg-node-02` (`192.168.100.12`):
```bash
ETCD_NAME="etcd-02"
ETCD_DATA_DIR="/var/lib/etcd/default.etcd"
ETCD_LISTEN_PEER_URLS="http://192.168.100.12:2380"
ETCD_LISTEN_CLIENT_URLS="http://192.168.100.12:2379,http://127.0.0.1:2379"
ETCD_INITIAL_ADVERTISE_PEER_URLS="http://192.168.100.12:2380"
ETCD_INITIAL_CLUSTER="etcd-01=http://192.168.100.11:2380,etcd-02=http://192.168.100.12:2380,etcd-03=http://192.168.100.13:2380"
ETCD_INITIAL_CLUSTER_STATE="new"
ETCD_INITIAL_CLUSTER_TOKEN="etcd-patroni-cluster"
ETCD_ADVERTISE_CLIENT_URLS="http://192.168.100.12:2379"
```

#### Su `pg-node-03` (`192.168.100.13`):
```bash
ETCD_NAME="etcd-03"
ETCD_DATA_DIR="/var/lib/etcd/default.etcd"
ETCD_LISTEN_PEER_URLS="http://192.168.100.13:2380"
ETCD_LISTEN_CLIENT_URLS="http://192.168.100.13:2379,http://127.0.0.1:2379"
ETCD_INITIAL_ADVERTISE_PEER_URLS="http://192.168.100.13:2380"
ETCD_INITIAL_CLUSTER="etcd-01=http://192.168.100.11:2380,etcd-02=http://192.168.100.12:2380,etcd-03=http://192.168.100.13:2380"
ETCD_INITIAL_CLUSTER_STATE="new"
ETCD_INITIAL_CLUSTER_TOKEN="etcd-patroni-cluster"
ETCD_ADVERTISE_CLIENT_URLS="http://192.168.100.13:2379"
```

Avviare etcd su tutti e 3 i nodi e verificare il quorum:
```bash
sudo systemctl restart etcd
sudo systemctl enable etcd
# Verifica salute cluster
ETCDCTL_API=3 etcdctl --endpoints=http://192.168.100.11:2379,http://192.168.100.12:2379,http://192.168.100.13:2379 endpoint health
```

---

### Passo 4.3: Configurazione Patroni su Ogni Nodo

Creare su ciascun nodo il file `/etc/patroni/patroni.yml` (adattando `name` e gli indirizzi IP `192.168.100.X`):

```yaml
scope: pg-cluster-prod
namespace: /service
name: pg-node-01  # Modificare in pg-node-02 o pg-node-03 sugli altri nodi

etcd3:
  hosts:
    - 192.168.100.11:2379
    - 192.168.100.12:2379
    - 192.168.100.13:2379

restapi:
  listen: 0.0.0.0:8008
  connect_address: 192.168.100.11:8008

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    synchronous_mode: 'on'
    synchronous_mode_strict: false
    synchronous_node_count: 1
    postgresql:
      use_pg_rewind: true
      use_slots: true
      parameters:
        max_connections: 200
        shared_buffers: 4GB
        effective_cache_size: 12GB
        maintenance_work_mem: 1GB
        work_mem: 32MB
        wal_level: replica
        archive_mode: 'on'
        archive_command: '/usr/local/bin/pg-arca-wal-archive.sh %p %f'
        archive_timeout: 60
        hot_standby: 'on'
        hot_standby_feedback: 'on'
      pg_hba:
        - hostssl replication replicator 192.168.100.0/24 scram-sha-256
        - hostssl all all 192.168.100.0/24 scram-sha-256
        - local all postgres peer

  initdb:
    - encoding: UTF8
    - data-checksums

  pg_hba:
    - hostssl replication replicator 192.168.100.0/24 scram-sha-256
    - hostssl all all 192.168.100.0/24 scram-sha-256
    - local all postgres peer

  users:
    admin:
      password: StrongAdminPassword2026!
      options:
        - superuser
        - createdb

postgresql:
  listen: 0.0.0.0:5432
  connect_address: 192.168.100.11:5432
  data_dir: /var/lib/postgresql/16/main
  bin_dir: /usr/lib/postgresql/16/bin
  pgpass: /var/lib/postgresql/.pgpass
  authentication:
    replication:
      username: replicator
      password: StrongReplPassword2026!
    superuser:
      username: postgres
      password: StrongPostgresPassword2026!

tags:
  nofailover: false
  noloadbalance: false
  clonefrom: false
  nosync: false
```

Assegnare i permessi corretti e avviare il cluster:
```bash
sudo chown postgres:postgres /etc/patroni/patroni.yml
sudo chmod 0600 /etc/patroni/patroni.yml

# Avviare Patroni (avviare prima il nodo 1, poi nodo 2 e nodo 3)
sudo systemctl enable --now patroni
```

Verificare la topologia su qualsiasi nodo con `patronictl`:
```bash
sudo patronictl -c /etc/patroni/patroni.yml topology pg-cluster-prod
sudo patronictl -c /etc/patroni/patroni.yml list
```

---

## Documenti correlati
- [HANDOFF.md](./HANDOFF.md): stato del lavoro e come riprenderlo.
- [PROJECT_TRACKER.md](./PROJECT_TRACKER.md): registro dei componenti, dei test e delle decisioni.
