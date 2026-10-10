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

## Percorsi e variabili personalizzate (`Nodi` → «Percorsi e rilevamento»)
- L'agent mostra per ogni impostazione il valore rilevato, quello impostato e la fonte (rilevato / agent.conf / impostato qui / ambiente).
- Modificabili solo da un amministratore, solo le impostazioni in elenco (PGDATA, binari, porta, socket/host, utente, repository, archivio WAL, cartella temporanea, URL Patroni).
- L'agent controlla ogni valore sul server prima di salvarlo (PGDATA deve contenere PG_VERSION e global/pg_control; i percorsi di scrittura non possono essere cartelle di sistema; niente `..`; URL senza credenziali). Salvataggio tutto-o-niente su `agent.local.json` (0640), applicato subito.
- Precedenza: default < agent.conf < agent.local.json < variabili d'ambiente del servizio.
- Provato: validazione, salvataggio, precedenza, handler dell'agent (unit test), operazioni lato console. **Non provato nel browser** con un agent reale.
