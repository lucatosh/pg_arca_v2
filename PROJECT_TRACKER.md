# pg_arca — registro dei componenti

Ultimo aggiornamento: 2026-10-16. Ogni riga dice **cosa è stato davvero eseguito**; non c’è nulla di "validato" senza un test dietro.

## Componenti

| Componente | File | Stato | Verifica |
| --- | --- | --- | --- |
| Stato persistente atomico | `server/store.ts` | Reale | `tests/server/*` |
| Journal operazioni (idempotenza, lease, TTL, corsie, annullamento) | `server/ops.ts`, `server/optypes.ts` | Reale | `ops.test.ts` |
| Vista cluster da telemetria | `server/view.ts` | Reale | `view.test.ts` |
| Agent: iscrizione, heartbeat, report, log | `server/agents.ts` | Reale | `api.test.ts` + e2e Python |
| Autenticazione (admin al primo avvio, scrypt, sessioni, throttling) | `server/auth.ts` | Reale | `api.test.ts` |
| Inventario cluster, demo unico eliminabile | `server/clusters.ts`, `server/demo.ts` | Reale | `api.test.ts` |
| Collegamento senza agent | `server/direct.ts` | **Mai eseguito contro PostgreSQL reale** | solo stub |
| Scheduler backup | `server/scheduler.ts` | Reale | `scheduler.test.ts` |
| Store della console scalabile (undo journal, group commit, telemetria lazy, risultati grandi in file) | `server/store.ts`, `server/ops.ts` | Reale: 165 ms → 0,01 ms per mutazione (misurato); lab: regressione 56/56 | `tests/server/store.test.ts`, `ops.test.ts` |
| Macchine operative | `server/workers.ts`, `pg_arca/worker.py`, `src/pages/Workers.tsx` | Server/agent con test, UI e2e; lab no | `workers.test.ts`, `test_worker.py` |
| Conflitti tra DBA | `server/conflicts.ts` | Server con test | `conflicts.test.ts` |
| Forense WAL veloce (DROP/TRUNCATE, cache per segmento, corsia `analysis`) | `unix-agent/pg_arca/engine/walscan.py` | Reale su PG16 locale: 18 s → 2,1 s → 0,02 s (cache); lab 97 s → 8 s (misurati) | `test_walscan.py`, `bench_forensics.py` |
| Restore: read-ahead WAL, dump zstd:1, pre-flight (chunk, spazio, nome) | `walprefetch.py`, `engine/restorecheck.py`, `pgsession.run_dump` | Reale su PG16 locale: recovery −38 %, dump 3,5 → 1,1 s (misurati); **lab non ancora** | `test_walprefetch.py`, `test_restorecheck.py`, `bench_restore.py` |
| Restore oggetti v2 (dipendenze, schemi, replace/missing_only/as_new, dry-run) | `unix-agent/pg_arca/engine/objects.py`, `src/pages/Restore.tsx` | Reale su PG16 locale; **lab Patroni non ancora** | `test_objects_v2.py` (10) |
| Configurazione istanza di recupero a più livelli, preflight e installazione PG | `engine/ephcfg.py`, `server/scoped.ts` | Config + preflight reali; installazione apt/dnf e posizionamento centrale **non provati su rete reale** | `test_ephcfg.py` (15), `scoped.test.ts` |
| Indipendenza dal layout (psql, ruolo, archiviatore, Patroni REST, cgroup, validazione parametri) | `unix-agent/pg_arca/pgaccess.py`, `sysres.py`, `wal_archive.py`, `discovery.py` | Reale; provato su PG16 locale e sul lab (Patroni + nodo con layout insolito) | `test_universal.py` (22), `test_params_pg.py` (5) |
| Destinazione backup (local/NFS/SMB montati) con controllo per nodo | `engine/destcheck.py`, `server/destinations.ts` | Controllo reale su filesystem locale; **mount NFS/SMB non provati**; oggetti = Anteprima | `test_destcheck.py` (11), `destinations.test.ts` |
| Audit e rilevamento aggregato | `server/platform.ts` | Reale | `api.test.ts` |
| Log in tempo reale (WebSocket), scansione di rete | `server/logs.ts`, `server/netscan.ts` | Scritti; **non eseguiti** (mancano `ws`/`express` nell’ambiente di sviluppo): solo controllo sintattico | — |
| Agent: rilevamento, esecutore, Patroni, WAL, CLI | `unix-agent/pg_arca/*` | Reale | `unix-agent/tests` |
| Motore backup/ripristino | `unix-agent/pg_arca/engine/*` | Reale | 15 test su PostgreSQL 16 |
| Interfaccia web modulare | `src/*` | Reale, provata nel browser | `tests/ui/e2e.cjs` (agent simulato) |
| Strategie di backup per cartella / ambiente / cluster (modelli suggeriti e personalizzati, ereditarietà) | Reale |: risolte a ogni tick dello scheduler, nessuna copia | `tests/server/policies.test.ts`, `tests/ui/e2e.cjs` |
| Gestione pg_hba (Patroni DCS o file, simulazione anti lock-out, verifica con `pg_hba_file_rules`, rollback) | Agent provato su PostgreSQL 16 reale; **DCS Patroni mai provato su un cluster reale** | `unix-agent/tests/test_hba*.py`, `tests/server/hba.test.ts`, `tests/ui/hbalogic.test.ts` |
| Assistente HBA nella UI (duplicati, regole oscurate, ordine, descrizioni, modelli) | Reale | nel browser con agent simulato | `tests/ui/e2e.cjs` |
| Rilevamento: consigli dell'agent e differenze tra nodi | Reale | | `tests/server/discovery.test.ts`, `unix-agent/tests/test_discovery_advisor.py` |
| Riporta una tabella ripristinata nel database (`as_new` / `replace`, non distruttivo) | Agent provato su PG16; | `test_engine_pg.py` |
| Utenti e ruoli | `server/auth.ts`, `src/pages/Users.tsx` | Reale | `rbac.test.ts` |
| Cifratura repository | `unix-agent/pg_arca/engine/crypt.py`, `repo.py`, `wal_manager.py` | Reale (opzionale, richiede `cryptography`) | `test_crypto.py` + suite PG16 cifrata |
| Recupero righe, prova di disaster recovery | `engine/granular.py` | Reale | `test_engine_pg.py` (PG16) |
| Salute, briefing, notifiche | `server/health.ts`, `server/notify.ts`, `src/pages/Today.tsx` | Reale; webhook non provati contro servizi reali | `health.test.ts` |
| Approvazioni a due persone, impostazioni avanzate | `server/approvals.ts`, `src/pages/Settings.tsx` | Reale | `approvals.test.ts` |
| HBA: adozione e regole temporanee | `hba.py`, `hba_ops.py`, `server/scheduler.ts::hbaExpiryTick` | Reale (non su Patroni) | `test_hba_pg.py`, `hba.test.ts` |
| LDAP/AD | `server/ldap.ts` | Implementato; **mai provato contro un AD vero** | `ldap.test.ts` |

## Cosa coprono i test del motore (PostgreSQL 16)
backup completo; incrementale (più piccolo, a catena); deduplica; PITR di un’istanza; ripristino sparso di un database; ripristino di un oggetto; ripristino fallito che non lascia nulla; `target_time` senza fuso rifiutato; percorsi protetti; verifica e info; prova di ripristino; rilevamento di blocchi corrotti; ricerca DROP/TRUNCATE; sicurezza dopo un backup interrotto; pulizia.

## Decisioni
- Un solo cluster demo; nessun altro dato fittizio.
- Nessuna simulazione presentata come reale: ciò che non funziona è "Anteprima" o risponde con un errore chiaro.
- Ripristino che finisce nell’originale (tabella, righe, database, server standalone) partendo sempre da una copia: l’originale viene sostituito solo alla fine, con conferma, e resta conservato; rollback automatico per il server.
- UI riscritta da zero in moduli (CSS semplice, nessuna dipendenza oltre React); il vecchio monolite da 4247 righe, Tailwind e lucide sono stati rimossi.
- Prodotto in inglese tecnico (14/10): interfaccia, messaggi di server e agent, parole di conferma (le italiane restano accettate); guardia `tests/ui/i18n.test.ts`; README e COMPAT in inglese, documenti interni in italiano.
- Prima versione ufficiale (14/10): **1.0.0-rc.1, release candidate, non GA**. Due prodotti con una sola versione (`VERSION`): console (tarball con runtime Node incluso + `install-console.sh` + immagine container) e agent (tarball offline, .deb, .rpm, oltre al `curl | bash` dalla console). Nessuna riscrittura in Go: l'agent Python 3.6 solo stdlib è voluto (gira ovunque senza dipendenze). Criteri per la GA in RELEASE.md.
- `server.ts` ridotto da ~2700 a ~90 righe: le rotte simulate (HA, HBA, LDAP, RBAC, PITR, stanze, politiche, parametri, tuning) sono state eliminate; HA e parametri passano dal motore operazioni.

## Da fare
- **[16/10 notte — semplicità e allarmi veri]** fatto: frase «è protetto?», data unica, verdetto unico del restore, vocabolario unico con test di guardia, navigazione per compiti («What do you need?» + Ctrl+K), Activity log unico, storage in un posto, editor policy in giorni, pg_hba leggibile, set di backup con nomi leggibili, RPO vero su cluster inattivi, quarantena WAL classificata dall'agent, set con WAL in ritardo completati invece che buttati, bozze dimenticate davvero al logout. Da fare: livelli base/esperto (idea 5), editor date 24 h nel passo «When» del restore, matrice PG14-18 completa (in corso sulla VM: `/tmp/matrix-summary.txt`).
- **[release 1.0.0-rc.1 — ramo `release/1.0.0-rc.1`]** (dettagli in HANDOFF, checkpoint 1-6 del 15/10):
  - [x] Build di release sulla VM: tar, deb, rpm, `npm audit` clean (BUILDINFO).
  - [x] `tools/lab/release-test.sh` su Debian 12 / Rocky 9 / Ubuntu 24: primo giro 13 fallimenti per distro = 3 bug dell'installer, corretti (9c8c987). [x] Secondo ciclo: 4 fallimenti per distro = CA della console non leggibile dall'agent, corretto (e26b656). [ ] Terzo ciclo (`~/lablogs/reltest.log`).
  - [ ] L'utente prova l'installazione su un'altra macchina (`TEST-INSTALLAZIONE.md`): raccogliere l'esito.
  - [x] F1 fencing geo (c9de688, df5e233, 5ddd942), F2 ritiro del ramo morto (4f848ef), F3 badge della testata (0acc185 e seguenti), 9 copie in `conflicts/` spiegate (tentativi prima della deduplica), `package-lock.json` versionato.
  - [x] Rejoin di hy-mi: cause trovate e corrette nel prodotto (rejoin falso, timeline abbandonate, job interrotti, peer noti); dal 15/10 sera hy-mi è standby di hy-rm in streaming su TL12 (verificato 16/10 00:40).
  - [x] Deploy del ramo sul lab (15/10 22:20, poi a ogni correzione) e aggiornamento di tutti gli agent con il comando di upgrade della console (16/16 online, nessun nodo duplicato); backup su NFS vero OK. [ ] misura di velocità del formato 2 su NFS.
  - [ ] Formato 2 del repository (pack file, 3934597): fatto e provato su PG16; [ ] pack su storage di rete reale; [x] cache dell'indice in layout nativo (`cas/packs/index.cache`, 1,6 M voci in 0,09 s — checkpoint 11).
  - [x] Obiettivi RPO/RTO dichiarati nella policy con finding e metriche (e719e8c). [x] Revisione di sicurezza agent + console con sub-agent indipendenti, 19 segnalazioni corrette (77d5c3f, 2f43eda); [ ] revisione esterna (gate).
000. **Studio (richiesta utente 12/10): destinazione dei backup personalizzabile dalla console per ambiente e per cluster**, sia **in locale** sia su una **macchina di destinazione o un servizio** (backup server come bk1, NAS, S3/MinIO, SFTP...). Secondo l'utente oggi dal webtool non si può fare. Esiste una base (`server/destinations.ts`, pagina Ripristino e archivi → Destinazione dei backup: ambiti globale/ambiente/cartella/cluster, segnaposto {env}/{cluster}, controllo per nodo prima di applicare), ma è limitata a cartelle locali o condivisioni NFS/SMB **già montate**; S3/Azure/GCS/SFTP sono solo «Anteprima», rifiutati. Da capire: (a) perché l'utente non la trova o non la ritiene sufficiente (visibilità dal cluster/ambiente, flusso), verificandolo sul lab; (b) quale soluzione offrire per una macchina remota senza mount: repository sul backup server raggiunto tramite il suo agent (push via agent worker), SFTP/SSH, oppure backend a oggetti (S3 compatibile) nel motore; (c) migrazione dei backup esistenti al cambio di destinazione (oggi non vengono spostati), archivio WAL per cluster, cifratura, conservazione, effetti su PITR/restore e sull'istanza di recupero centrale. Requisiti aggiunti dall'utente (11:39): configurare l'utente che scrive (o un servizio), prove di scrittura/permessi, migrazione in background del contenuto vecchio con occupazione attuale e spazio sulla nuova. **Progetto scritto: `DESTINAZIONE-BACKUP.md`** (due identità agent/postmaster provate entrambe, prove estese, cambio senza perdere PITR, migrazione riprendibile e verificata, sicurezza, fase 2 agent ricevitore/S3/SFTP). **§1-4 implementati e provati su PG16 (12/10 sera)**; restano prove sul lab con NFS/SMB veri e Patroni, e la fase 2 (agent ricevitore, S3, SFTP).
00. Dal 11/10: provare sul lab Patroni i restore oggetti v2 (`tools/lab/run-scn.sh`), l'istanza di recupero configurabile (preflight/installazione/posizionamento centrale) e la destinazione backup (NFS/SMB reali). Dettagli in HANDOFF «Sessione 11/10».
0. Ancora da misurare (richiedono il lab): copia offsite S3 contro MinIO/AWS reale (fatta con S3 simulato, §7j), archiviazione WAL asincrona con pgbench (fatta su PG16 reale in locale, §7k), riassunti WAL di PG17 (solo simulati qui; `test_wal_summary_pg.py` nella matrice), benchmark contro pgBackRest (`tools/lab/bench.sh`, mai eseguito). Fatti il 15/10: pack file (§7g), RPO/RTO dichiarati (§7l), revisione di sicurezza (§7m).
1. Provare `direct.ts`, `logs.ts` e `netscan.ts` con `npm install` su una macchina con rete.
2. Provare HA e parametri su un cluster Patroni reale.
3. Provare "promuovi tabella" dalla UI contro un agent reale (l'agent è provato su PG16).
4. Benchmark contro pgBackRest prima di qualsiasi affermazione di velocità.
5. LDAP/AD: implementato (15/10, `server/ldap.ts`), **da provare contro un AD vero**; RBAC: completo con sweep automatico. Revisione di sicurezza da parte di una persona esterna (gate). Poi: restyling grafico.
6. Integrare i documenti di progetto v1.0–v1.2 (non presenti nel repository).

- [ ] Lab Patroni Docker (tools/lab): scritto, NON testato su Docker reale — primo run da fare su CentOS, poi bench.sh.
