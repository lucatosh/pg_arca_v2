# Compatibilità: cosa è garantito, cosa è da verificare

Principio: **nessuna assunzione sul layout**. L'agent legge cosa gira (processi, `SHOW data_directory`, Patroni REST), non cosa "dovrebbe" esserci.

| Ambiente | Stato | Note |
|---|---|---|
| VM / bare metal RHEL-famiglia (PGDG `/usr/pgsql-NN`, `/var/lib/pgsql`) | Previsto, **non provato su host reali** | discovery e ricerca binari coprono il layout PGDG |
| VM Debian/Ubuntu (`/usr/lib/postgresql/NN`, `/etc/postgresql`) | Previsto, **non provato su host reali** | idem |
| Layout custom (`/data/pg`, tablespace altrove, più istanze) | Previsto | l'istanza in esecuzione è l'autorità; override: `PG_ARCA_PGDATA`, `pg_port`, `pg_bin_dir`, `pg_user` |
| Container Docker (senza systemd) | Provato in parte (lab) | installer senza servizio (`PG_ARCA_NO_SERVICE`) |
| Patroni (etcd/consul/k8s DCS) | Parziale | lab Docker+etcd in prova; altri DCS non provati |
| Kubernetes con operatori (CloudNativePG, Zalando, Crunchy, StackGres) | **Non supportato** | l'agent deve stare nello stesso host/pod di PGDATA (sidecar con volume condiviso): serve un design dedicato |
| DB gestiti (RDS, Cloud SQL, Azure) | **Non supportato** | niente accesso al filesystem: solo funzioni via SQL |

Assunzioni residue note (da eliminare o verificare): agent sullo stesso host di PostgreSQL; accesso locale (socket/peer) come utente `pg_user`; `archive_command` punta a `/usr/local/bin/pg-arca-wal`; systemd unit con `ProtectSystem=full`.

## Versioni di PostgreSQL (rilevamento + compatibilità)
Un solo modulo conosce le differenze tra versioni: `unix-agent/pg_arca/pgcompat.py` (specchio per la console: `server/pgcompat.ts`). Rileva la versione dal server (`server_version_num`), da `PG_VERSION` (anche a server fermo) o da un binario (`--version`), con suffissi dei vendor (Debian/Ubuntu, EDB, Percona) e pre-release (`17beta1`, `18devel`).

| Livello | Versioni | Cosa fa il prodotto |
|---|---|---|
| non supportato | < 10 (9.6 e precedenti) | backup/restore/telemetria si **rifiutano** (`PGA-VER-001`) con spiegazione; avviso critico in console |
| legacy | 10, 11 | gestite (API di backup `pg_start_backup`, `recovery.conf` invece di `recovery.signal`, nessun `restore_command` come GUC), **non fanno parte della matrice di test**; avviso |
| supportato | 12 … 18 | percorso normale; API di backup `pg_start_backup` fino alla 14, `pg_backup_start` dalla 15; stato pausa del replay dalla 14 |
| più recente | > 18 | si usa il percorso della versione più nuova nota (tutto è condizionato con ">="), segnalato come «da verificare»: fai un ripristino di prova |

- **Fine vita (EOL)** calcolata dalla regola della comunità (secondo giovedì di novembre, cinque anni dopo la prima uscita) e mostrata come avviso: oggi 12 e 13 sono EOL, 14 lo diventa il 2026-11-12.
- **«Verificata»** significa solo: la suite completa è passata su quella major in una esecuzione reale. Elenco `VERIFIED` in `pgcompat.py`: oggi **solo la 16**. Le altre si aggiungono solo dopo `tools/lab/matrix.sh` con esito PASS (non prima).
- **Binari**: l'agent controlla che `postgres`, `pg_waldump`, `pg_controldata`, `pg_ctl` siano della stessa major del server (`PGA-VER-002`/avviso `tool_major`: un `pg_waldump` di un'altra major non legge i WAL) e che `psql`/`pg_basebackup` non siano più vecchi. Operazione «Verifica compatibilità PostgreSQL» (`compat_check`) nel pannello del nodo.
- **Ripristino**: un backup si recupera solo con la STESSA major (`PGA-VER-002` con rimedio se i binari sono di un'altra); la versione del backup è nei metadati del set.
- Provato oggi: **solo PostgreSQL 16** con server reale (le altre major richiedono la matrice sulla VM). Le differenze 10/11/14/15 sono coperte da test unitari del modulo (SQL generato, file di recovery), non da un server di quella versione.
- **Obiettivo di prodotto: 14, 15, 16, 17, 18** (matrice di default `tools/lab/matrix.sh`, con le suite reali: backup/PITR/oggetti, standby, failover, layout, archivio, HBA, live sotto carico, parametri, disco pieno, DCS Patroni). Differenze trovate dalla matrice e gestite: il database `postgres` ha OID 5 solo dalla 15 (fino alla 14 l'OID è assegnato da initdb: un ripristino parziale lo legge dal catalogo del backup); la marcatura «invalido» del DROP DATABASE (dalla 15 e nelle minor 2023 di 12-14) può cadere nel segmento WAL precedente al DROP.

## Percorsi e variabili personalizzate (`Nodi` → «Percorsi e rilevamento»)
- L'agent mostra per ogni impostazione il valore rilevato, quello impostato e la fonte (rilevato / agent.conf / impostato qui / ambiente).
- Modificabili solo da un amministratore, solo le impostazioni in elenco (PGDATA, binari, porta, socket/host, utente, repository, archivio WAL, cartella temporanea, URL Patroni).
- L'agent controlla ogni valore sul server prima di salvarlo (PGDATA deve contenere PG_VERSION e global/pg_control; i percorsi di scrittura non possono essere cartelle di sistema; niente `..`; URL senza credenziali). Salvataggio tutto-o-niente su `agent.local.json` (0640), applicato subito.
- Precedenza: default < agent.conf < agent.local.json < variabili d'ambiente del servizio.
- Provato: validazione, salvataggio, precedenza, handler dell'agent (unit test), operazioni lato console. **Non provato nel browser** con un agent reale.
- Restore oggetti v2, istanza di recupero configurabile e destinazione backup: provati solo su PostgreSQL 16 reale; l'installazione dei binari di altre major (`ephemeral_install`) usa apt/dnf e non è mai stata eseguita su un sistema reale.

## Indipendenza dal layout (audit 11/10) — niente percorsi, ruoli o PATH presupposti
Ogni punto qui sotto era un'assunzione trovata nel codice; ora è rilevato o configurabile. Test: `unix-agent/tests/test_universal.py` (21, senza PostgreSQL), `test_params_pg.py` (5, PostgreSQL 16 reale con superuser `dba_root`), scenari lab `scenario-solo.py` (PG15 con PGDATA/conf/socket/tablespace insoliti), `scenario-params.py`, `scenario-hba-dcs.py`.

| Punto | Prima | Ora |
|---|---|---|
| `psql` e strumenti client | sempre `psql` dal PATH (su RHEL `/usr/pgsql-N/bin` non è nel PATH del servizio: telemetria muta) | `pgaccess.find_tool`: `pg_bin_dir` configurato → cartella del postmaster IN ESECUZIONE (`/proc/<pid>/exe`) → PATH → cartelle dei vendor (Debian, PGDG, `/opt/...`, EDB), versione più alta per prima. `pg_amcheck` cerca accanto a quello `psql` |
| Ruolo di connessione | `postgres` fisso | `pg_user` vuoto = automatico: proprietario di PGDATA → utente OS dell'agent → `postgres`, il primo che si connette davvero. Superuser con nome scollegato dall'utente OS (`initdb -U dba`): impostare `pg_user` |
| Cartella dei binari dell'istanza | mai rilevata (campo `bin_dir` letto ma mai scritto) | scritta dalla discovery (eseguibile del postmaster, riga di comando, o cartella vendor della stessa major) |
| `archive_command` | `/usr/local/bin/pg-arca-wal` anche se inesistente | percorso VERIFICATO (wal_bin, `PG_ARCA_WAL_BIN`, PATH, accanto al pacchetto, `/usr/local/bin`); rifiuta se non esiste; con config/home non standard antepone `env PG_ARCA_CONF=… PG_ARCA_HOME=…` |
| **Archiviatore e `agent.local.json`** | `pg-arca-wal` leggeva solo `agent.conf`: una cartella WAL cambiata dalla console (o dall'applicazione della destinazione) NON arrivava ad `archive_command` | legge `agent.conf` → `agent.local.json` → ambiente, come l'agent |
| `pg-arca-wal` e dove sta il pacchetto | `/opt/pg-arca` fisso | `PG_ARCA_HOME`, o la cartella dello script (anche via symlink), o `/opt/pg-arca` |
| REST API di Patroni | sempre `http://127.0.0.1:porta` | indirizzo di `restapi.listen` (jolly → loopback; IP specifico → quello), `https` se c'è il certificato, configurazione solo da variabili d'ambiente (`PATRONI_RESTAPI_LISTEN`) o `patroni.yml` illeggibile → porta su cui ascolta il processo |
| CPU e RAM per i consigli di tuning e il preflight | `os.cpu_count()` e `/proc/meminfo` (in un container: quelli dell'host) | `sysres`: affinità CPU + quota cgroup (v1/v2), RAM limitata dal cgroup |
| Parametri sotto Patroni | scritti nel DCS senza controllo: un nome sbagliato o un valore fuori range raggiunge TUTTI i membri | validati su `pg_settings` del nodo (esistenza nella versione, tipo, enum, unità, minimo/massimo) PRIMA di toccare il DCS; `listen_addresses`/`port` rifiutati (vengono dalla configurazione locale di Patroni) |
| pg_hba su file in cartella non scrivibile | `OSError` grezzo | messaggio con il rimedio (permessi, `ReadWritePaths`); utente della sonda anti lock-out = ruolo reale |
| Socket Unix dell'istanza effimera | `<scratch>/<nome>/.s` (oltre ~107 byte PostgreSQL non parte) | cartella corta in `/run/user`, `/tmp` o `/var/tmp` se il percorso non ci sta |
| Link simbolici in PGDATA | ignorati in silenzio (come `pg_basebackup`) | ignorati come `pg_basebackup` ma elencati nell'avviso del backup e in `meta.skipped_links` |
| Installer | utente OS `postgres` fisso, `pg_user` scritto in `agent.conf` | utente OS rilevato dal postmaster in esecuzione (`PG_ARCA_USER` lo forza), nessun `pg_user` fisso; `PG_ARCA_WAL`, `PG_ARCA_SCRATCH` |

Limiti noti (non risolti): `unix_socket_directories` con più voci usa la prima esistente; blocchi da 16/32 kB nel tuning UI (le unità sono assunte da 8 kB); i servizi systemd con `ProtectSystem=full` non possono scrivere un `pg_hba.conf` sotto `/etc` fuori dalle cartelle riaperte dall'installer; l'installazione automatica dei binari non copre SUSE.


## Macchine operative (backup server, host di recupero) — 11/10
- Ruolo dell'agent `node_role`: `auto` (predefinito: decide la console), `database`, `worker`. All'installazione `PG_ARCA_ROLE=worker`; senza utente `postgres` l'installer crea l'utente di sistema `pgarca`.
- In modalità `worker` l'agent **non cerca PostgreSQL** (nessuna discovery di istanze, nessun cluster creato) e riporta: installazioni PostgreSQL per versione (sistema, private di pg_arca, configurate), filesystem reali con tipo (locale, NFS, SMB, Ceph, …) e spazio, cartelle pg_arca (scratch, repository, archivio WAL), CPU/RAM e permessi (root / sudo senza password).
- Un ruolo impostato localmente vince sempre su quello della console. Test: `unix-agent/tests/test_worker.py`, `tests/server/workers.test.ts`.

## Autenticazione verso PostgreSQL senza peer
L'agent eredita l'ambiente: con `pg_hba` che vieta `peer` sul socket, un `~/.pgpass` (o `PGPASSFILE`) dell'utente dell'agent e, se serve, `PGSSLMODE` vengono usati da psql/pg_dump/pg_restore. Lo stesso vale per la consegna al primario dal nodo centrale (`centralInto`): la password va nel `.pgpass` del nodo centrale. Non verificato sul lab.
