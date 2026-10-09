# pg_arca — PostgreSQL Physical Resilient Archiver & Enterprise Cluster Manager
=============================================================================

**pg_arca** è la suite aziendale completa per l'amministrazione, il backup fisico a livello di pagina (block-level CAS deduplication), il ripristino chirurgico granulare (**Granular PITR** a zero downtime), l'orchestrazione ad alta disponibilità (**Patroni 3-node HA & etcd3**) e l'auto-rilevamento intelligente dell'infrastruttura Unix.

---

## 📑 Indice dei Contenuti
1. [Architettura Generale](#-1-architettura-generale)
2. [Guida Installazione Lato Macchina Unix / Ubuntu](#-2-guida-installazione-lato-macchina-unix--ubuntu)
3. [Guida Installazione Piattaforma Web & Backend](#-3-guida-installazione-piattaforma-web--backend)
4. [Guida Creazione Cluster Patroni 3 Nodi su KVM / Ubuntu VM](#-4-guida-creazione-cluster-patroni-3-nodi-su-kvm--ubuntu-vm)
5. [Riferimento Comandi CLI (`pg-arca-cli`)](#-5-riferimento-comandi-cli-pg-arca-cli)
6. [Guida Operativa Granular Point-In-Time Recovery (PITR)](#-6-guida-operativa-granular-point-in-time-recovery-pitr)
7. [Tracciamento delle Funzionalità & Test](#-7-tracciamento-delle-funzionalità--test)

---

## 🏛️ 1. Architettura Generale

La soluzione si compone di tre livelli sinergici:
1. **pg_arca Unix Node Agent (`/unix-agent`)**:
   - Demone residente in Python 3 su porta locale `9898` (servizio systemd `pg-arca-agent.service`).
   - Gestore continuità registri WAL con archiviazione atomica ad alta velocità e compressione (Zstd/LZ4).
   - Content-Addressable Storage (CAS) con deduplicazione dei blocchi su filesystem e storage object/NFS.
   - Motore di ripristino selettivo granulare (database singolo, schema o tabella) senza sovrascrivere l'intero cluster.
   - Discovery Engine intelligente per il rilevamento automatico di percorsi e cluster su macchine Unix.
2. **pg_arca Control Plane Backend (`server.ts`)**:
   - Server full-stack Node.js / Express con API REST enterprise per inventario multi-cluster, storico audit immutabile e coordinamento policy.
   - Cache store ad alte prestazioni con sincronizzazione bidirezionale con i nodi fisici.
3. **pg_arca Web Console (`src/App.tsx`)**:
   - Console reattiva single-page con Command Palette globale (`⌘K` / `Ctrl+K`), visualizzatore diff di configurazione multi-nodo, studio temporale 30 giorni e ispettore di sicurezza dei registri WAL.

---

## 🐧 2. Guida Installazione Lato Macchina Unix / Ubuntu

### Requisiti di Sistema
- **Sistema Operativo**: Ubuntu Server 20.04 LTS, 22.04 LTS o 24.04 LTS.
- **PostgreSQL**: Versioni supportate 14, 15, 16 o 17.
- **Python**: Python 3.8+ con modulo `venv` e `pip`.
- **Utente di sistema**: `postgres` (UID convenzionale 26 o 1001).

### Procedura di Installazione Guidata

1. **Clonazione o trasferimento della cartella `unix-agent` sul nodo:**
   ```bash
   sudo mkdir -p /opt/pg-arca
   sudo chown -R $(whoami):$(whoami) /opt/pg-arca
   # Copia i file da unix-agent/ verso /opt/pg-arca/
   cp -r unix-agent/* /opt/pg-arca/
   cd /opt/pg-arca
   ```

2. **Esecuzione dell'installer con Auto-Discovery:**
   Lo script esegue automaticamente la scansione della macchina, individua l'istanza PostgreSQL, l'eventuale configurazione Patroni in `/etc/patroni` e genera la configurazione personalizzata:
   ```bash
   chmod +x install-agent.sh pg-arca-cli
   sudo ./install-agent.sh
   ```

   Durante l'esecuzione, lo script:
   - Crea le directory `/var/lib/pg-arca/repo` (CAS Storage), `/var/lib/postgresql/wal_archive` (Continuous WAL Archive) e `/var/log/pg-arca`.
   - Genera il file `/etc/pg-arca/agent.conf` con un token crittografico univoco.
   - Configura il wrapper `/usr/local/bin/pg-arca-wal-archive.sh`.
   - Installa e abilita il servizio systemd `pg-arca-agent.service`.

3. **Verifica dello Stato del Demone:**
   ```bash
   sudo systemctl status pg-arca-agent
   # Test con la CLI
   /opt/pg-arca/pg-arca-cli status
   /opt/pg-arca/pg-arca-cli wal-check
   ```

4. **Collegamento con PostgreSQL (`postgresql.conf` o `patroni.yml`):**
   Aggiungere nel file di configurazione PostgreSQL dell'istanza o nel modello bootstrap di Patroni:
   ```ini
   wal_level = replica
   archive_mode = on
   archive_command = '/usr/local/bin/pg-arca-wal-archive.sh %p %f'
   archive_timeout = 60
   restore_command = '/opt/pg-arca/pg-arca-cli wal-get %f %p'
   ```
   Ricaricare la configurazione:
   ```bash
   sudo -u postgres psql -c "SELECT pg_reload_conf();"
   ```

---

## 🌐 3. Guida Installazione Piattaforma Web & Backend

### Requisiti
- **Node.js**: Versione 18.x, 20.x o successiva.
- **NPM**: Versione 9.x+.

### Avvio in Ambiente di Sviluppo & Test
```bash
# 1. Installazione pacchetti
npm install

# 2. Controllo coerenza tipi e sintassi
npm run lint

# 3. Avvio server integrato (Backend Express + Frontend Vite su porta 3000)
npm run dev
```
La console risponderà su `http://localhost:3000` (o sull'indirizzo IP della macchina).

### Deploy in Produzione con Systemd & Nginx Reverse Proxy
```bash
# 1. Compilazione del frontend
npm run build

# 2. Configurazione file di avvio systemd per la web app (/etc/systemd/system/pg-arca-web.service)
sudo tee /etc/systemd/system/pg-arca-web.service > /dev/null << 'EOF'
[Unit]
Description=pg_arca Enterprise Control Plane & Web Suite
After=network.target

[Service]
Type=simple
User=postgres
WorkingDirectory=/opt/pg-arca-web
ExecStart=/usr/bin/node /opt/pg-arca-web/dist/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now pg-arca-web
```

---

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

## 🛠️ 5. Riferimento Comandi CLI (`pg-arca-cli`)

La CLI interagisce automaticamente con il demone locale (o esegue il fallback diagnostico diretto se offline):

```bash
# 1. Ispezione stato nodo, ruolo DCS e LSN
pg-arca-cli status

# 2. Controllo salute e continuità dell'archivio WAL (0 Gap Check)
pg-arca-cli wal-check

# 3. Scansione deep di auto-rilevamento configurazioni e cluster
pg-arca-cli discover

# 4. Creazione backup blocco-deduplicato CAS
pg-arca-cli backup --scope sparse --database billing --type incremental

# 5. Lista backup disponibili nel catalogo
pg-arca-cli list-backups

# 6. Ripristino chirurgico non distruttivo (Granular PITR Sandbox)
pg-arca-cli restore \
  --scope object \
  --database billing \
  --schema public \
  --tables invoices \
  --target-time "2026-10-08T11:42:00Z" \
  --mode clone \
  --clone-name invoices_pitr_recovered

# 7. Hot reload sicuro configurazioni senza stop del servizio
pg-arca-cli reload

# 8. Switchover controllato del nodo leader Patroni
pg-arca-cli switchover pg-node-02
```

---

## ⏱️ 6. Guida Operativa Granular Point-In-Time Recovery (PITR)

### Scenario Tipico: TRUNCATE o DELETE accidentale su tabella di produzione

1. **Apertura Studio PITR**:
   Dalla web UI o tramite `pg-arca-cli`, selezionare il cluster (`cluster-prod-emea`) e accedere alla scheda **Granular PITR Studio**.
2. **Scelta Ambito Chirugico**:
   Selezionare `Oggetto Singolo (Tabella)` o `Singolo Database (Sparse OID)` per evitare di dover ripristinare i centinaia di gigabyte dell'intero cluster.
3. **Selezione delle Coordinate Temporali Immutabili**:
   - Scegliere il punto temporale esatto prima dell'incidente (es. `2026-10-08T11:42:00Z`).
   - L'Ispettore WAL mostra il file esatto da riprodurre (`00000001000000000000002E`). **Il nome è rigidamente bloccato e protetto da manomissioni.**
4. **Modalità Sandbox Isolato (Consigliata)**:
   - Specificare il nome della tabella o database di destinazione clonato (`invoices_recovered`).
   - `pg_arca` estrae solo i blocchi e i segmenti WAL necessari, materializza la sandbox separata e permette ai DBA di verificare i dati prima di qualsiasi DDL.
5. **Modalità In-Place con Safety Snapshot & Rollback**:
   - Se eseguito in-place, `pg_arca` crea automaticamente uno snapshot binario preventivo di salvataggio.
   - In caso di anomalie o discrepanze, è disponibile il tasto **Rollback Istantaneo a 1-Click** per ritornare allo stato esatto pre-ripristino.

---

## 📊 7. Tracciamento delle Funzionalità & Test

Per consultare la cronologia dettagliata di tutte le feature implementate, la matrice dei test superati e la tracciabilità delle modifiche, fare riferimento al file dedicato:
👉 **[PROJECT_TRACKER.md](./PROJECT_TRACKER.md)**
