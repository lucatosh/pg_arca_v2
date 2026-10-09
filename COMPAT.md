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

## Percorsi e variabili personalizzate (`Nodi` → «Percorsi e rilevamento»)
- L'agent mostra per ogni impostazione il valore rilevato, quello impostato e la fonte (rilevato / agent.conf / impostato qui / ambiente).
- Modificabili solo da un amministratore, solo le impostazioni in elenco (PGDATA, binari, porta, socket/host, utente, repository, archivio WAL, cartella temporanea, URL Patroni).
- L'agent controlla ogni valore sul server prima di salvarlo (PGDATA deve contenere PG_VERSION e global/pg_control; i percorsi di scrittura non possono essere cartelle di sistema; niente `..`; URL senza credenziali). Salvataggio tutto-o-niente su `agent.local.json` (0640), applicato subito.
- Precedenza: default < agent.conf < agent.local.json < variabili d'ambiente del servizio.
- Provato: validazione, salvataggio, precedenza, handler dell'agent (unit test), operazioni lato console. **Non provato nel browser** con un agent reale.
