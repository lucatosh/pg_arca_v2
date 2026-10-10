# HANDOFF — stato del lavoro (aggiornato a ogni commit)

> Come funzionano backup e restore (formato, algoritmi, limiti, confronto onesto con pgBackRest): vedi [ARCHITETTURA-BACKUP-RESTORE.md](ARCHITETTURA-BACKUP-RESTORE.md) — da aggiornare a ogni modifica del motore.


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

### Aggiornamento notte 10/10 (ssh alla VM)
- **Accesso VM:** funzionava tramite il plugin Desktop Commander (`mcp__claude-device__lcl-Desktop_Commander-start_process`, `ssh -o BatchMode=yes lab@192.168.1.179`). Lo strumento è disponibile solo durante un turno in cui l'utente ha scritto dall'app: la chiamata è stata annullata quando l'utente si è allontanato. Se non è disponibile, lavorare in locale (sandbox) e lasciare i comandi da lanciare nel messaggio finale.
- **Causa vera delle repliche del lab che non partono** (trovata e corretta nel repo, NON ancora applicata alla VM): `tools/lab/docker/entrypoint.sh` esportava `PGPASSWORD` (superuser) → ereditato da Patroni/pg_basebackup → "password authentication failed for user replicator". Per applicarla sulla VM: `cd /opt/pg_arca_v2 && git pull --ff-only && cd tools/lab && sg docker -c "./lab.sh up"` (ricrea i container, i dati restano), poi `sg docker -c "./lab.sh agent-update"` e `./lab.sh diag`.
- **Console sulla VM:** dopo `git pull` serve `sudo systemctl restart pg-arca-console` (sudo richiede password: non eseguibile da ssh non interattivo). Suggerimento: regola sudoers `lab ALL=(root) NOPASSWD: /bin/systemctl restart pg-arca-console`.
- **Richiesta dell'utente (da fare):** creare un SECONDO cluster di prova con configurazione diversa (es. istanza singola senza Patroni, oppure Patroni 2 nodi con PG17/porta diversa/cartella dati custom, senza systemd) per verificare l'universalità di discovery e di tutte le funzioni; testare ogni funzione una per una (backup full/diff/incr, WAL, PITR, restore database/oggetto/istanza, HBA, log, azioni per nodo, switchover/failover) e migliorare la web UI; ripetere il ciclo analizza→migliora→testa. L'utente ha dato consenso a ogni operazione e non risponderà fino al mattino.

### Avanzamento (ssh non disponibile da questa sessione)
- FATTO: `archive_enable` (agent + server + UI nella scheda Backup, con fallback manuale). Test PG16 reale verde, suite TS/Python/UI verdi.
- DA FARE sulla VM (serve shell): `git pull --ff-only`, `./lab.sh up`, `./lab.sh agent-update`, `./lab.sh diag`, `sudo systemctl restart pg-arca-console`; verificare repliche pg1/pg3 sane.
- DA FARE: secondo cluster di test (istanza singola senza Patroni, versione/porta/data dir diverse) e prova di ogni funzione; poi TODO elencati sopra (strategia backup/RPO, wizard restore, doctor agent, update agent da console).

### Sessione pomeriggio 10/10 (ssh alla VM: sudo senza password attivo, utente console `claude-test`)
- Strumenti lab nuovi (tools/lab): `mkuser.ts`, `api.sh`, `op.py` (esegue un'operazione via API e attende; `op.py last N`; `op.py - /api/...`), `q.sh` (SQL sul leader), `where.sh`, `eph.sh <nodo>` (ispeziona un'istanza di restore bloccata), `scenario-ha.sh`, `scenario-backup.sh`.
- Da PowerShell non passare comandi con virgolette/`$` a `ssh "..."`: mettere la logica in uno script del repo e lanciare `ssh lab@192.168.1.179 "cd /opt/pg_arca_v2 && git pull -q --ff-only && sg docker -c 'tools/lab/<script>'"`. `read_process_output` senza offset rilegge tutto lo storico: usare `offset:-15`.
- Il tool del dispositivo smette di funzionare dopo molti minuti di turno: vedi sopra, rilanciare dopo un nuovo messaggio utente.
- FATTO e verificato sul lab: HA 8/8 (vedi NOTES 25), backup full/incr/diff/verify/deep, restore object/diff/apply/promote, restore instance, drill, expire dry-run, PITR con orario ISO (NOTES 26).
- DA VERIFICARE SUL LAB (fix scritto e testato solo in locale): restore di tabella eliminata + restore database (NOTES 27). Procedura: `git pull`, `sg docker -c "./lab.sh agent-update"` (dentro tools/lab), poi `sg docker -c ./scenario-backup.sh > /tmp/scn.log` e `grep -E "^(PASS|FAIL|SUMMARY)" /tmp/scn.log`. Se un'operazione resta bloccata: `eph.sh pg2`, poi `docker exec pg2 pkill -f eph-`.
- PROSSIMI PASSI: secondo cluster di test (istanza singola senza Patroni, porta/dir/versione diverse), prova da UI reale di switchover/backup/restore (ricompilare: `npm run build` sulla VM, già fatto per archive_enable), failover (kill leader), HBA, log, PITR dalla UI, test di carico ridotto.

### Stato a fine pomeriggio 10/10 (leggere prima di ripartire)
- Deploy sulla VM: `ssh lab@192.168.1.179 "cd /opt/pg_arca_v2 && sg docker tools/lab/deploy.sh"` (pull + build UI + restart console + agent-update, anche solo1 se esiste).
- IN CORSO sulla VM (verificare i log): `/tmp/stby.log` (scenario-standby.sh), `/tmp/matrix.out` + `/tmp/matrix-<v>.log` (matrix.sh), `/tmp/solo-up.log` (build immagine solo). Il contenitore `solo1` quando parte annuncia l'agent alla console: approvarlo dall'UI, poi provare le funzioni.
- Da fare: rieseguire `scenario-backup.sh` completo dopo il deploy (include "restore dropped table" con il fix del lock), `scenario-standby.sh`, `conc.sh`; approvare solo1 e testarlo; leggere la matrice PG 12–17 e correggere ciò che fallisce; secondo giro UI (switchover reale da web, PITR da web con orario ISO, pulsante Aggiorna).
- Limite operativo: il tool del dispositivo funziona solo per alcuni minuti dopo un messaggio dell'utente; lavorare con script nel repo lanciati in background (`nohup ... &`) e leggere i log al giro successivo.
- **20:30 (10/10)**: la VM 192.168.1.179 non rispondeva più (nessun host con SSH in 192.168.1.x) → fix del drill su set da replica fatto e provato in LOCALE (vedi NOTES riga 34, `tests/test_engine_standby_pg.py`; esecuzione: `su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_engine_standby_pg'`). Ancora da fare appena la VM torna: pull, leggere i 7 errori + 1 failure del PG12 della matrice (`/tmp/matrix-12.log`), approvare solo1 (`tools/lab/approve.sh solo1 erp-solo prod`), rieseguire scenari.

### Sessione sera 10/10 (VM spenta: lavoro svolto in locale su PostgreSQL 16 reale)
Nuovi test con PG reale (tutti `su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.<modulo>'`): `test_engine_standby_pg` (backup full/incr da standby, drill, restore), `test_engine_failover_pg` (PITR prima/al/dopo failover), `test_engine_targets_pg` (restore point, xid incl./escl., LSN, latest), `test_wal_rescue_pg` (buco WAL da failover + rescue), `test_engine_stress_pg` (backup sotto carico di scrittura: checksum + amcheck), `test_engine_enospc_pg` (repo pieno; richiede un tmpfs, vedi NOTES 38). Manopole: `PG_ARCA_TEST_WALSEG=1..1024` (segmenti WAL non standard), `PG_ARCA_TEST_WALDIR=1` (pg_wal su volume separato), `PG_ARCA_TEST_ENCRYPT=1`, `PG_ARCA_TEST_REPO`. Combinazioni 2MB+waldir+cifratura e 1/16/64MB provate: OK.
Bug reali trovati e corretti (NOTES 34–38): drill/restore di set da standby (target LSN a confine di segmento), timeline sbagliata di un backup subito dopo failover, buchi WAL tra timeline non rilevati, rimedio WAL rescue, errori ENOSPC grezzi.
Da fare appena la VM è raggiungibile: `git pull` + `tools/lab/deploy.sh`; leggere gli errori PG12 (`/tmp/matrix-12.log`) e il resto della matrice; approvare solo1; rieseguire scenari; provare WAL rescue su Patroni vero (switchover/failover con archive_command rotto); UI: mostrare nella pagina Backup il buco "attraverso failover" (campo `across_failover` nei gaps) e l'attività del rescue.

### Compatibilità versioni PostgreSQL (10/10 notte)
Vedi COMPAT.md «Versioni di PostgreSQL» e NOTES riga 39. Punto d'ingresso unico: `unix-agent/pg_arca/pgcompat.py` (`Profile`); ogni differenza fra versioni va aggiunta LÌ, mai con `version_num >= N` sparsi. Verificata (VERIFIED) = solo 16. Prossimo passo sulla VM: `sg docker -c "tools/lab/matrix.sh"` e, solo per le major con PASS, aggiungerle a `VERIFIED`. Aperto: le major 10/11 (recovery.conf) non hanno mai girato su un server reale; PG 12 ha ancora 1 failure + 7 errori da leggere (ora `matrix.sh` salva il log completo).

### Interfaccia rifatta, dock attività, log su richiesta (10/10 notte)
- Nuovo tema e navigazione: barra laterale a gruppi e compressibile, filtro cluster se > 6, briciole di pane; le 13 schede del cluster in 4 aree (`src/tabs.ts`, barra sticky). Il test UI (`tests/ui/e2e.cjs`) usa l'helper `tab(area, pagina)`.
- **Dock attività** (`src/Dock.tsx`, Ctrl J, anche dalla palette): in corso / terminate (1 h), Annulla, Apri, Log, toast d'esito per le proprie operazioni. Feed leggero `GET /api/operations?slim=1&recent=<s>`; ogni scrittura su `/operations` o `/approvals` lo aggiorna subito (evento `arca:ops`).
- **Log su richiesta** (decisione: NON tenere sempre il tail con molti cluster). Console: `server/logring.ts` (buffer per cluster + policy, senza dipendenze) e `server/logs.ts` (WebSocket a pacchetti 250 ms). Agent: `LogShipper.mode` ('alerts' di default, 'full' quando la console risponde `log_mode: full` all'heartbeat/logs; 60 s di coda dopo l'ultimo spettatore). Un agent vecchio che ignora `log_mode` continua a spedire tutto: funziona, solo meno efficiente.
- Test nuovi: `tests/server/logs.test.ts`, `tests/server/logs_ws.test.ts` (richiede il pacchetto `ws`; in locale `ln -s /opt/npm-tools/node_modules/ws node_modules/ws`), `unix-agent/tests/test_logshipper.py`.
- Da fare sulla VM: `tsc && vite build` reale; provare il log su richiesta con più cluster/agent veri (latenza di attivazione = fino a un ciclo di heartbeat, ~8 s) e misurare il carico; verificare i colori/contrasti nei temi su schermi reali.

