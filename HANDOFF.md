# HANDOFF — stato del lavoro (aggiornato a ogni commit)

Branch di lavoro: `claude/enterprise-overhaul` (mai toccare `main`). Ultimo aggiornamento: vedi `git log`.

## Regole del progetto (decise con l'utente)
- Un solo cluster demo (`isSandbox`, id `cluster-demo`), eliminabile. Nessun altro dato fittizio.
- Nessuna simulazione presentata come reale: o funziona davvero o risponde 501/"non supportato".
- Cluster collegabili da UI con agente (enrollment token) **e senza agente** (connessione diretta PostgreSQL).
- Python agent: solo stdlib, compatibile Python 3.6+ (RHEL 8).
- Ambiente di lavoro: niente PostgreSQL, niente `npm install` (registry irraggiungibile) => verifiche solo sintattiche
  (`python3 -m py_compile`, `tsc` solo errori TS1xxx). **Mai dichiarare "testato" ciò che non è stato eseguito.**

## FATTO
- [x] `unix-agent/pg_arca/discovery.py` riscritto: discovery reale (/proc, PGDATA, pg_control, postmaster.pid, Patroni REST, etcd, pgbouncer, pgBackRest). Testato su PGDATA sintetico.
- [x] `server.ts`: 3 cluster finti -> 1 solo `buildDemoCluster()` (in corso: persistenza + rotte).

## IN CORSO / DA FARE (ordine consigliato)
1. server.ts: caricare/salvare inventario su `DATA_DIR/inventory.json` (flag `demoDeleted`), rimuovere rotte duplicate (clear-sandbox/seed-sandbox/DELETE x2), svuotare seed: `casStore`, `storageBackends`, `systemAuditEntries`, `pitrMilestones`, `pitrWeeklyHistory`, `latestDiscoveryScan`, `backupPolicies`, `clusterParametersStore`, `registeredAgentNodes`.
2. server: gateway agenti autenticato (enrollment token, heartbeat con token, proxy per nodeId — NO host arbitrario/SSRF, niente fallback "simulato").
3. server: attach diretto senza agente (modulo `pg`, aggiungere a package.json), introspezione ruolo/versione/DB/replica.
4. Agent: config senza default pericolosi (token vuoto => rifiuta l'avvio; CORS `*` rimosso; listen 127.0.0.1), `handle_create_backup` finto -> motore reale.
5. Agent: motore backup/restore reale portato da `pgarca.py` (CAS con verifica hash in lettura, walk_pgdata con tablespace, incrementali via pd_lsn, sparse restore, istanza effimera isolata). `granular_restore.py` oggi è simulato (sleep, numeri fissi).
6. UI (`src/App.tsx`): wizard "Collega cluster" (agente / diretto), stato vuoto, fluidità.
7. README.md + PROJECT_TRACKER.md riscritti onestamente; integrare design v1.0–v1.2.
8. Verifiche finali sintattiche + test unitari agent.

## Note
- `pgarca.py` corretto (3 bugfix) è andato perso nel reset del container; in /mnt/user-data/outputs c'è la versione pre-fix + tar del lab. Bug da riapplicare: backup_label sempre dal full base (`redo_source_set(chain)=chain[0]`), tablespace inclusi nel walk, `--config` errato non va ignorato in silenzio.
- Push: funziona dopo l'installazione della GitHub App di Claude.
