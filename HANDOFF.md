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

## FATTO
- [x] Server reale (`server/*.ts`): store atomico, operazioni idempotenti con corsie control/data e annullamento cooperativo, vista da telemetria, auth, agent enroll/heartbeat/report, inventario cluster (demo unico), direct (mai provato su PG reale), scheduler backup, audit/discovery, log WebSocket (`logs.ts`), scansione rete (`netscan.ts`). `server.ts` è ora solo il montaggio (~90 righe); le rotte simulate sono state eliminate.
- [x] Agent 2.0 (`unix-agent/`): discovery reale, esecutore con journal su disco, Patroni bridge, archivio WAL write-once, CLI, installer, telemetria con riepilogo repository.
- [x] Motore backup/restore (`unix-agent/pg_arca/engine/`): CAS blake2b/zstd, full/diff/incr con LSN di pagina, deduplica, restore istanza/DB sparso/oggetto con PITR, istanza effimera isolata, verify/restore-test/expire/forensics. 15 test su PG16 reale.
- [x] UI modulare (`src/`): auth, shell + palette Ctrl+K, elenco cluster, wizard di collegamento (agent / diretto), vista cluster (panoramica, nodi, HA, parametri, backup, ripristino con timeline, operazioni, log), registro attività, rilevamento. Sezioni senza backend marcate "Anteprima". Provata in Chromium (`tests/ui`).

## DA FARE (ordine consigliato)
1. Provare dal vivo (con `npm install`): `direct.ts`, `/ws/logs`, `/api/network/*`, avvio di `server.ts`.
2. HA e parametri su un cluster Patroni reale.
3. Operazione "promuovi tabella" (quarantena -> database di produzione).
4. Benchmark vs pgBackRest (nessun claim finché non misurato).
5. Anteprime: HBA, LDAP/AD, RBAC, tuning, modelli globali.
6. Integrare i design v1.0–v1.2 (non nel repo).
7. UI: tema scuro rivisto a vista, grafici di tendenza.

## Come testare
- Server: `tsx tests/server/{ops,view,api,scheduler}.test.ts`
- Agent: `cd unix-agent && python3 -m unittest discover -s tests -t .`
- Motore su PG16: NON come root. `chown -R postgres /home/claude/pgtest; su postgres -s /bin/bash -c 'cd /home/claude/pg_arca_v2/unix-agent && PG_ARCA_TEST_DIR=/home/claude/pgtest/e2e python3 -m unittest tests.test_engine_pg'` (`V=1` per i log del motore). Non usare `pkill -f` con pattern larghi: uccide la propria shell.
- UI: bundle `esbuild src/main.tsx --bundle --outfile=/tmp/claude-0/ui/app.js --loader:.css=css --jsx=automatic`; server di test `tsx tests/ui/devserver.ts 5188 /tmp/claude-0/ui`; `NODE_PATH=/opt/npm-tools/node_modules node tests/ui/e2e.cjs`. Dopo un login sbagliato il server impone 1 s di attesa (throttling).

## Note
- `pgarca.py` corretto (3 bugfix) è andato perso nel reset del container; in /mnt/user-data/outputs c'è la versione pre-fix + tar del lab. Bug da riapplicare: backup_label sempre dal full base (`redo_source_set(chain)=chain[0]`), tablespace inclusi nel walk, `--config` errato non va ignorato in silenzio.
- Push: funziona dopo l'installazione della GitHub App di Claude.

## Esiti test del vecchio prototipo su PG16 reale (lab) — tutti già risolti nel nuovo motore
- t10 (backup full) OK.
- `cmd_verify` crasha sui nomi WAL `.backup` (parse nome segmento) -> da gestire nel nuovo engine (ignorare .backup/.partial/.meta).
- Sparse restore (t30) si blocca: `could not open file "base/5/pg_filenode.map"`. Causa: il readiness-probe si connette al DB `postgres` (oid 5)
  che lo scheletro non conteneva. FIX da applicare nell'engine: estrarre SEMPRE oid 1 (template1) e 5 (postgres) + DB target;
  per ogni DB scheletro serve `pg_filenode.map` + `PG_VERSION`.
- t20: l'argomento `--pg1-path` non era accettato dal sottocomando restore (API CLI incoerente).
- Processi di test residui possibili: /home/claude/pgtest/pgdata e /home/claude/pgtest/lab/src (non usare `pkill -f` largo).
- WAL archive: fallback .gz in wal_manager.py.
