# HANDOFF — stato del lavoro (aggiornato a ogni commit)

Branch di lavoro: **`main`** (decisione dell'utente: si scrive sempre direttamente su main, niente branch/PR). Dopo ogni push: `git update-ref refs/remotes/origin/main HEAD`. Ultimo aggiornamento: vedi `git log`.

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

- [x] Strategie di backup (`server/policies.ts`, `src/pages/Strategy.tsx`): modelli predefiniti + personalizzati, assegnazione a globale/ambiente/cartella/cluster, risoluzione a ogni tick (cluster > cartella più lunga > ambiente > globale).
- [x] HBA: agent (`hba.py`, `hba_ops.py`, provato su PG16), API di propagazione (`server/hba.ts`), assistente UI (`src/pages/Hba.tsx` + `src/hbaLogic.ts`, test `tests/ui/hbalogic.test.ts`). Ordine predefinito "specifico prima" (pg_hba usa la prima regola che corrisponde); modalità "rete più ampia in alto" segnala le regole rese irraggiungibili.
- [x] Rilevamento: `advise()` sull'agent + differenze tra nodi sul server (UI non ancora aggiornata). Promozione tabella (`engine/granular.py::promote_object`, UI mancante).

- [x] Utenti/ruoli, cifratura repository, recupero righe, prova di disaster recovery, pagina Oggi + salute, notifiche webhook, approvazioni a due persone + Impostazioni, HBA adozione/regole temporanee (vedi README per limiti e test).

- [x] Auto-annuncio dei server: `install-agent.sh` senza `PG_ARCA_ENROLL_TOKEN` → la console mostra «Nuovo server rilevato» (admin) e chiede se aggiungerlo. Il token resta valido come prima.

## DA FARE (ordine consigliato)
0. UI: restyling grafico ulteriore; UI delle strategie su più cluster in blocco; prove periodiche di disaster recovery pianificate dalla strategia (oggi la prova è manuale); notifiche email; controlli aggiuntivi (scadenza certificati, archive_command cambiato, spiegazioni di causa più ricche).
1. Provare dal vivo (con `npm install`): `direct.ts`, `/ws/logs`, `/api/network/*`, avvio di `server.ts`.
2. HA e parametri su un cluster Patroni reale.
4. Benchmark vs pgBackRest (nessun claim finché non misurato).
5. Anteprima: LDAP/AD.
6. Integrare i design v1.0–v1.2 (non nel repo).
7. UI: tema scuro rivisto a vista, grafici di tendenza.

## Come testare
- Server: `npm test` (ops, view, api, scheduler, policies, hba, discovery, rbac, health, approvals + tests/ui/hbalogic e tuning + unittest agent)
- Agent: `cd unix-agent && python3 -m unittest discover -s tests -t .`
- Motore su PG16 con repository cifrato: aggiungere `PG_ARCA_TEST_ENCRYPT=1` al comando seguente. Motore su PG16: NON come root. `chown -R postgres /home/claude/pgtest; su postgres -s /bin/bash -c 'cd /home/claude/pg_arca_v2/unix-agent && PG_ARCA_TEST_DIR=/home/claude/pgtest/e2e python3 -m unittest tests.test_engine_pg'` (`V=1` per i log del motore). Non usare `pkill -f` con pattern larghi: uccide la propria shell.
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

## Lab Patroni 3 nodi (tools/lab)
Script pronti (setup-host.sh, lab.sh, docker-compose, Dockerfile, haproxy) per CentOS: etcd×3 + Patroni/PG16×3 + agent installato dal vero install-agent.sh (nuovo `PG_ARCA_NO_SERVICE` / auto-skip senza systemd) + HAProxy. **Mai eseguiti**: il sandbox non ha il daemon Docker; verificati solo sintassi bash, YAML e il ramo no-systemd dell'installer. Vedi tools/lab/README.md.

## Revisione del 10/10 (lab Patroni + revisione indipendente)
- Elenco problemi/correzioni e **backlog non fatto**: `tools/lab/NOTES.md`. Compatibilità e limiti noti: `COMPAT.md` (K8s con operatori e DB gestiti NON supportati).
- Nuovo: scheda «Percorsi e rilevamento» (operazioni `agent_config_get/set`, `agent.local.json`), nodi Patroni senza agent visibili + avviso di salute, `lab.sh agent-update/agent-reset`.
- Test eseguiti e verdi in questa sessione: server (12 suite), UI (hbalogic, tuning, e2e browser), agent unit (wal, crypto, discovery, hba, overrides, restore_safety, pgdata_resolve, agent_flow, e2e_console), PG16 (engine anche cifrato, hba_pg). **Mai eseguito su Docker/CentOS/Ubuntu reali**: il lab Patroni è provato solo dall'utente in VM, gli esiti sono da raccogliere.

## STATO e PIANO (aggiornato 10/10 notte) — leggere per primo se si riparte da zero
**Obiettivo dell'utente:** pg_arca = prodotto enterprise per amministrazione avanzata di cluster PostgreSQL (Patroni) **e istanze singole**. Priorità: (1) schedulazione backup con i nostri standard, (2) restore vari e PITR, (3) UI web fluida/ordinata, (4) agent lato macchina robusto. Ogni soluzione deve valere per QUALSIASI infrastruttura (VM, container, K8s con Patroni), mai solo per il lab. Mai dichiarare "testato" ciò che non è stato eseguito.

**Ambiente:** il sandbox non ha Docker né rete npm. Il lab Patroni (VirtualBox Ubuntu, IP 192.168.1.179, `/opt/pg_arca_v2/tools/lab`) è eseguito solo dall'utente: si lavora incollando output (`./lab.sh diag` raccoglie tutto). Collegamento SSH alla VM dall'app desktop richiesto dall'utente ma **in questa sessione non c'è alcuno strumento di shell remota** (solo controllo schermo): se compare `mcp__remote-devices__device_bash`, usarlo (`ssh lab@192.168.1.179`).

**Fatto in questa tornata (vedi `tools/lab/NOTES.md` righe 12–20):** riannuncio automatico dell'agent dopo cancellazione (`node_unknown`), identità cluster da Patroni scope + fusione automatica dei duplicati (`reconcileCluster`), diagnosi nel modale di approvazione, ricerca PG ogni 15 s quando non visibile, scelta del nodo con PG attivo per backup/ripristino, HBA che salta i nodi irraggiungibili, log da `log_directory`/patroni dir, finestre per "Installa agent"/"Aggiungi nodo", azioni HA spiegate, **bug corretto: `patroni_restart` ignorava `member`**, nuove azioni per nodo (`NodePanel.tsx`: riavvia, ricarica, checkpoint, WAL switch, promuovi, ricostruisci replica `patroni_reinit`, rileva di nuovo, revoca), badge "Istanza singola / Cluster Patroni".

**Aperto adesso (lab):** le repliche pg1/pg3 alternano `creating replica` ↔ `stopped`. Causa non nota. Ipotesi principale: `pg_basebackup`/Patroni resta in attesa dell'archiviazione WAL perché `archive_command` (`pg-arca-wal archive`) fallisce o è lento; altre: spazio disco, permessi, slot. Azione: far lanciare `./lab.sh diag` e leggere `pg_stat_archiver`, log di pg1/pg3. Se è l'archive_command, rendere l'archiviazione non bloccante/diagnosticata (e mostrare l'errore nella UI Backup).

**DA FARE, in ordine (backup/restore/PITR prima):**
1. Backup: UI strategie con prova di restore automatica periodica (DR drill pianificata), retention e policy visibili per cluster/nodo, avvisi quando l'archiviazione WAL è ferma (RPO), stima spazio/tempo prima del backup, scelta del nodo sorgente (primario/replica) esplicita.
2. Restore: procedura guidata (istanza intera / database / oggetto / PITR con selettore data+ora e LSN), anteprima "cosa verrà fatto", ripristino su nuovo nodo/cluster, verifica post-restore (checksum, connessione, conteggi). Test su PG16 reale per ogni scenario.
3. PITR: grafico della finestra recuperabile (WAL continui, timeline dopo failover), conferma esplicita del punto di arrivo, `archive_mode` del cluster ripristinato (decisione utente aperta: lasciarlo spento?).
4. Agent: journald/stderr dei container come sorgente log, `pg-arca-cli doctor`, installazione via SSH dalla console (decisione utente aperta), aggiornamento dell'agent dalla console, supporto K8s (pod con Patroni) documentato in `COMPAT.md`.
5. UI generale: tema/ordine, navigazione per nodo, pagina nodo dedicata, stati vuoti utili, notifiche email, ricerca globale.
6. Storage: S3/oggetti, pack file, WAL asincrono, riepiloghi PG17 (roadmap M2–M6); benchmark `tools/lab/bench.sh` (mai eseguito: nessun claim di prestazioni).
7. Test mancanti: `direct.ts` contro PG reale, `/ws/logs`, `/api/network/*`, avvio di `server.ts` (richiedono `npm install`).
