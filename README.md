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
| Prova di ripristino (recupera davvero l’ultimo backup in un’istanza temporanea) | Funziona | idem |
| Pulizia (retention, garbage collection dei blocchi, WAL) | Funziona | idem |
| Ricerca DROP/TRUNCATE nei WAL (`pg_waldump`) | Funziona | idem |
| Pianificazione backup (idempotente, back-off, retention, verifica periodica) | Funziona | `tests/server/scheduler.test.ts` |
| Alta affidabilità: switchover, failover, riavvio membro, manutenzione (Patroni) | Scritto con precondizioni e verifica dell’effetto; **mai provato su un cluster Patroni reale** | Test con Patroni simulato |
| Parametri (`ALTER SYSTEM` + reload) | Scritto; provato con psql simulato | `unix-agent/tests` |
| Interfaccia web | Funziona nel browser (Chromium) con agent simulato | `tests/ui/e2e.cjs` |
| Strategie di backup per cartella / ambiente / cluster (modelli suggeriti e personalizzati, ereditarietà) | Funziona: risolte a ogni tick dello scheduler, nessuna copia | `tests/server/policies.test.ts`, `tests/ui/e2e.cjs` |
| Gestione pg_hba (Patroni DCS o file, simulazione anti lock-out, verifica con `pg_hba_file_rules`, rollback) | Agent provato su PostgreSQL 16 reale; **DCS Patroni mai provato su un cluster reale** | `unix-agent/tests/test_hba*.py`, `tests/server/hba.test.ts`, `tests/ui/hbalogic.test.ts` |
| Assistente HBA nella UI (duplicati, regole oscurate, ordine, descrizioni, modelli) | Funziona nel browser con agent simulato | `tests/ui/e2e.cjs` |
| Rilevamento: consigli dell'agent e differenze tra nodi | Funziona | `tests/server/discovery.test.ts`, `unix-agent/tests/test_discovery_advisor.py` |
| Riporta una tabella ripristinata nel database (`as_new` / `replace`, non distruttivo) | Agent provato su PG16; | `test_engine_pg.py` |
| LDAP/AD, RBAC, tuning | **Anteprima**: visibili e marcate, senza funzione dietro | — |
| Promozione di una tabella ripristinata nel database di produzione | **Non c’è**: la tabella resta in quarantena, il comando di spostamento è mostrato | — |
| Velocità rispetto a pgBackRest | **Mai misurata**: nessuna affermazione | — |

Limiti noti: il ripristino di una tabella non include chiavi esterne, viste, sequenze; i backup da standby richiedono `archive_mode=always`; gli incrementali richiedono `data_checksums` o `wal_log_hints`; backup e ripristino richiedono l’agent sul server.

## Architettura

```
Browser ──HTTPS──> Console (server.ts) <──HTTPS (solo uscente)── Agent (su ogni nodo) ── psql / pg_ctl / Patroni REST
                      │  store.json (atomico)                         │  repository: cas/ + stanza/<cluster>/backup/<set>/
                      └─ operazioni, audit, scheduler                 └─ archivio WAL condiviso (write-once, fsync)
```

- **Repository**: archivio *content-addressed* — blocchi da 64 KiB, hash blake2b-256 verificato a ogni lettura, compressione zstd/zlib. Ogni backup è un manifesto di `[offset, lunghezza, hash]`; i blocchi uguali si memorizzano una volta sola.
- **Incrementali**: si confrontano le LSN di pagina (solo file principali; FSM/VM e altri fork interi). La catena viene validata prima di partire, altrimenti il backup diventa completo.
- **Sicurezza dei backup**: i blocchi scritti attorno a un’esecuzione interrotta vengono riverificati prima della deduplica; un solo `sync` prima del commit del backup; la garbage collection ha 48 h di tolleranza.
- **Ripristino**: non scrive mai nella data directory in uso (percorsi protetti, controllo dei symlink, mai come root). I database ripristinati prendono sempre un **nome nuovo**; una tabella arriva in un database di **quarantena**; in caso di errore ciò che è stato creato viene eliminato. L’istanza temporanea usata per il recovery è isolata (nessuna rete, archiviazione spenta, sola lettura).
- **PITR**: `target_time` richiede il fuso orario; il backup di partenza è il più recente concluso prima dell’istante scelto; la copertura WAL è controllata *prima* di iniziare.
- **Operazioni**: ogni azione ha una Idempotency-Key; backup e ripristino non vengono mai ripetuti automaticamente dopo un crash; corsia *controllo* (HA, parametri) separata dalla corsia *dati* (backup, ripristino) così un backup di ore non blocca uno switchover.

## Avvio rapido

Console (serve Node 20+):

```bash
npm install
npm test                 # suite TypeScript + test Python dell’agent
npm run dev              # http://localhost:3000 — il primo accesso crea l’amministratore
# produzione: npm run build && NODE_ENV=production tsx server.ts
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
