# HANDOFF — stato del lavoro (aggiornato a ogni commit)

Branch di lavoro: `claude/enterprise-overhaul` (mai toccare `main`). Ultimo aggiornamento: vedi `git log`.

## Regole del progetto (decise con l'utente)
- Un solo cluster demo (`isSandbox`, id `cluster-demo`), eliminabile. Nessun altro dato fittizio.
- Nessuna simulazione presentata come reale: o funziona davvero o risponde 501/"non supportato".
- Cluster collegabili da UI con agente (enrollment token) **e senza agente** (connessione diretta PostgreSQL).
- Python agent: solo stdlib, compatibile Python 3.6+ (RHEL 8).
- Ambiente di lavoro: **PostgreSQL 16 è installato** (test reali possibili sul lato agent/engine; cluster di prova in /home/claude/pgtest, porta 54320).
  `npm install` del pacchetto `pg` NON è possibile (stub in node_modules, gitignored) => `server/direct.ts` mai eseguito contro PG reale.
  **Mai dichiarare "testato" ciò che non è stato eseguito.**

## FATTO (aggiornato)
- [x] `unix-agent/pg_arca/discovery.py` riscritto: discovery reale (/proc, PGDATA, pg_control, postmaster.pid, Patroni REST, etcd, pgbouncer, pgBackRest). Testato su PGDATA sintetico.
- [x] `server/` nuovi moduli (testati con `tests/server/*.test.ts`, 3 suite passano): `store.ts` (stato atomico tmp+fsync+rename, serializzato, .bak), `ops.ts` (journal operazioni: idempotency-key, lease/redelivery, 1 op/cluster, TTL, transizioni monotone), `view.ts` (vista cluster da telemetria reale), `optypes.ts` (whitelist+validazione), `agents.ts` (enroll one-time token, heartbeat, report, log ingest, API token/nodi/operazioni), `auth.ts` (setup admin al primo avvio, scrypt, sessioni cookie, throttling), `direct.ts` (attach SENZA agente via `pg` + Patroni REST opzionale, segreti AES-256-GCM), `clusters.ts` (inventario, demo unico eliminabile/ripristinabile, detach atomico idempotente), `platform.ts` (audit reale, discovery aggregata), `selftest.ts` (selftest reale).
- [x] `server.ts`: rimossi 3 cluster finti, generatore log finti, hub discovery finto (file di config inventati!), audit/PITR seed di audit, CORS aperto, endpoint agent non autenticati, `/api/tests/run` e selftest finti. Montato il nuovo motore. Rotte legacy simulate bloccate (501) per cluster reali (`legacyDemoOnly`).
- NB: `pg`/`express` non installabili qui => `direct.ts` NON è mai stato eseguito contro un PostgreSQL reale. Test con stub. Va provato dal cliente: `npm install && npm test` poi attach-direct verso un PG vero.

- [x] Agent 2.0 (unix-agent/): `config.py` (niente token di default, credenziali per-nodo 0600), `db_client.py` (psql con variabili legate: nessuna interpolazione SQL; snapshot JSON reale), `discovery.py` reale, `patroni_bridge.py` (auth + attesa/verifica effetti), `executor.py` (journal su disco: effectively-once, precondizioni, verifica post-azione, op non idempotenti mai ripetute dopo crash), `console_client.py` (enroll one-time, long-poll, backoff, keep-alive lease, report ripetuti), `runtime.py` (telemetria + log shipper reale), `wal_manager.py`+`wal_archive.py`+`pg-arca-wal` (archivio WAL write-once, fsync, link(2) atomico, quarantena split-brain PGA-WAL-031, restore verificato exit 126 su corruzione, gap detection timeline-aware corretta al rollover logid), `api_server.py` (inbound opzionale, no CORS, niente endpoint finti), `install-agent.sh` (RHEL/Debian, idempotente, systemd hardened, scarica bundle dalla console), `pg-arca-cli` Python (status/discover/wal-check/archive-setup/op).
- [x] Test: `npm test` = 3 suite TS + `unix-agent/tests` (WAL, executor con psql/Patroni finti, e2e agent<->console su HTTP reale con le route vere). Tutti verdi.
- [x] Rimosso `granular_restore.py` (era simulato). Il motore reale di backup/restore NON esiste ancora (vedi DA FARE).

## IN CORSO / DA FARE (ordine consigliato)
1. (FATTO lato server, vedi sopra). Restano da sostituire con versioni reali le rotte legacy: `/api/ha/*`, `/api/hba/*`, `/api/auth/ldap*`, `/api/clusters/:id/parameters*`, `reload-conf`, `rolling-restart`, `/api/pitr/*`, `/api/stanzas/*`, `/api/backup-policies*`, `/api/storage/*` (oggi: solo demo).
2. Agent esecutore operazioni (poll heartbeat -> journal su disco -> dispatch -> report), snapshot reale (`db_client.get_snapshot`), enroll/credenziali su disco 0600, log shipping reale, install script che scarica da `/agent/`.
4. Agent: config senza default pericolosi (token vuoto => rifiuta l'avvio; CORS `*` rimosso; listen 127.0.0.1), `handle_create_backup` finto -> motore reale.
5. Agent: motore backup/restore reale portato da `pgarca.py` (CAS con verifica hash in lettura, walk_pgdata con tablespace, incrementali via pd_lsn, sparse restore, istanza effimera isolata). `granular_restore.py` oggi è simulato (sleep, numeri fissi).
6. UI (`src/App.tsx`): wizard "Collega cluster" (agente / diretto), stato vuoto, fluidità.
7. README.md + PROJECT_TRACKER.md riscritti onestamente; integrare design v1.0–v1.2.
8. Verifiche finali sintattiche + test unitari agent.

## Note
- `pgarca.py` corretto (3 bugfix) è andato perso nel reset del container; in /mnt/user-data/outputs c'è la versione pre-fix + tar del lab. Bug da riapplicare: backup_label sempre dal full base (`redo_source_set(chain)=chain[0]`), tablespace inclusi nel walk, `--config` errato non va ignorato in silenzio.
- Push: funziona dopo l'installazione della GitHub App di Claude.

## Esiti test del vecchio prototipo su PG16 reale (lab)
- t10 (backup full) OK.
- `cmd_verify` crasha sui nomi WAL `.backup` (parse nome segmento) -> da gestire nel nuovo engine (ignorare .backup/.partial/.meta).
- Sparse restore (t30) si blocca: `could not open file "base/5/pg_filenode.map"`. Causa: il readiness-probe si connette al DB `postgres` (oid 5)
  che lo scheletro non conteneva. FIX da applicare nell'engine: estrarre SEMPRE oid 1 (template1) e 5 (postgres) + DB target;
  per ogni DB scheletro serve `pg_filenode.map` + `PG_VERSION`.
- t20: l'argomento `--pg1-path` non era accettato dal sottocomando restore (API CLI incoerente).
- Processi di test residui possibili: /home/claude/pgtest/pgdata e /home/claude/pgtest/lab/src (non usare `pkill -f` largo).
- WAL archive: fallback .gz in wal_manager.py.
