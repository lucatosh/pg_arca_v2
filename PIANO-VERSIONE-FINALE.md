# Versione finale e distribuzione in tre pacchetti: studio e proposta (17/10)

Richiesta dell'utente (17/10, 03:27): a lavori finiti, ragionare su una versione finale professionale («python e shell non mi sembrano professionali, meglio Go secondo me, ma studia tu») e su tre pacchetti semplici da installare: pg-arca-client (client Unix), pg-arca-cli e pg-arca-console. **Nessuna riscrittura parte senza il comando dell'utente.**

## 1. Com'è fatto oggi (misurato)

| Parte | Linguaggio | Dimensione | Dipendenze a runtime | Test che la reggono |
|---|---|---|---|---|
| Agent sui nodi (motore di backup/restore, archive/restore_command, operazioni, discovery) | Python ≥ 3.6, solo libreria standard | ~1,4 MB di sorgente (~25 000 righe dense, 40+ moduli) | `python3` di sistema, binari PostgreSQL; **nessun pip** | ~440 test unitari + 61 suite su PostgreSQL 16 reale + matrice 14–18 sulla VM + varianti (cifrato, segmenti 1/64 MB, pg_wal esterno) |
| Console (API + pianificatore + UI) | TypeScript: Express sul server, React nell'interfaccia | ~0,6 MB server, ~0,7 MB UI | Node.js (nel pacchetto è incluso il runtime) | ~60 test server, e2e Playwright, sweep di tutte le pagine |
| CLI | `pg-arca-cli` Python sul nodo (motore locale) | piccolo | come l'agent | parte dei test agent |
| Installazione | shell (`install-agent.sh`, `install-console.sh`, postinst) | — | — | `tools/lab/release-test.sh` su Debian 12 / Rocky 9 / Ubuntu 24 |

Pacchetti già prodotti da `tools/release/build.sh`: agent in tar offline, `.deb`, `.rpm`; console in tar con runtime Node, installer systemd con aggiornamento e ritorno automatico, immagine container.

## 2. Go sì o no? Valutazione onesta

**Dove Go è davvero meglio**
- Un binario statico per architettura: niente dipendenza dal Python della distribuzione (RHEL 8 ha 3.6: oggi lo reggiamo con una guardia di sintassi, ma è un vincolo permanente).
- Avvio in pochi millisecondi: conta per `archive_command` / `restore_command`, che PostgreSQL lancia **una volta per segmento WAL** (Python: misurati 26–44 ms solo per avviare `pg-arca-wal` su questa macchina, prima di qualsiasi lavoro; con centinaia di segmenti al minuto pesa, oggi attenuato dall'archiviazione asincrona; Go: pochi millisecondi).
- Concorrenza vera (hash, compressione, cifratura su più core senza GIL), cross-compilazione (linux amd64/arm64, FreeBSD), percezione «enterprise» del prodotto, firma dei binari semplice.

**Dove il cambio costa o non serve**
- Il motore è il cuore del valore e oggi è **provato**: centinaia di casi reali di restore, due scrittori sull'archivio, timeline, migrazioni, cifratura. Una riscrittura completa riparte da zero su tutto questo: stimata in **6–10 settimane** per un ingegnere esperto più un nuovo banco di prova a scatola nera (i test attuali chiamano le funzioni Python, non i binari).
- Nel mondo PostgreSQL Python non è amatoriale: **Patroni** (lo standard HA) e **Barman** (EDB) sono in Python; pgBackRest è in C, WAL-G in Go. I clienti giudicano installazione, affidabilità e supporto, non il linguaggio.
- La console in TypeScript/React è lo standard di mercato per interfacce web (Grafana, pgAdmin 4 lato UI, ecc.): riscriverla in Go non porta nulla all'utente.

**Conclusione**: Go dove porta un vantaggio misurabile (avvio per segmento, binario unico, CLI sui portatili degli amministratori), **non** una riscrittura totale prima delle prime demo. Il motore passa a Go per parti, dietro un banco di conformità, solo se e quando i clienti lo chiedono.

## 3. Proposta: tre pacchetti

| Pacchetto | Dove si installa | Cosa contiene | Come |
|---|---|---|---|
| **pg-arca-agent** (il «client» Unix; nome di mercato consigliato: *agent*) | ogni nodo PostgreSQL e ogni worker host (backup server, host di recupero) | servizio dell'agent, motore, `pg-arca-wal` (archive/restore_command), `pg-arca-cli` locale per i casi senza console | `.deb` / `.rpm` / tar offline (già esistenti) + repository apt/dnf firmato; un comando generato dalla console («Add a node») |
| **pg-arca-cli** | portatile o jump host dell'amministratore (Linux, macOS, Windows) | **nuovo, in Go**: un solo binario che parla con l'API della console (token API già esistenti): stato dei cluster, backup, restore con piano e conferma, approvazioni, esportazione report, uso negli script CI/Ansible | binario firmato per OS/architettura, `brew`/`apt`/`dnf`/zip |
| **pg-arca-console** | un server (o un container) | API + interfaccia + pianificatore, runtime incluso | `.deb` / `.rpm` / tar con installer systemd (già esistente) e immagine container; aggiornamento con ritorno automatico già provato |

## 4. Piano in fasi (da avviare solo col comando dell'utente)

1. **Fase A — pacchetti puliti (1–2 giorni)**: nomi e metadati definitivi dei tre pacchetti, repository apt/dnf firmato, pagine `man`, `pg-arca-console` e `pg-arca-agent` come oggi più pulizia degli script; documentazione di installazione in tre pagine.
2. **Fase B — `pg-arca-cli` in Go (3–5 giorni)**: binario unico sull'API esistente (nessun cambiamento lato server), comandi `login`, `clusters`, `backup run|list`, `restore plan|run`, `approvals`, `wal conflicts`, output tabellare e `--json`; test contro la console di sviluppo (stesso devserver dell'e2e).
3. **Fase C — `pg-arca-wal` in Go (1–2 settimane)**: il percorso per segmento (archive/restore_command, spool) riscritto in Go con **lo stesso formato su disco** (meta, quarantena, proprietario, chiave); banco di conformità che fa girare le suite WAL Python contro il binario Go; misura prima/dopo con pgbench.
4. **Fase D — motore in Go (facoltativa, 6–10 settimane)**: solo dopo C e con il banco di conformità esteso a backup e restore; finché non è verde su tutta la matrice, il motore Python resta quello distribuito.

Rischi: la fase D è l'unica che può introdurre regressioni sui dati; le fasi A–C non toccano il motore di restore.
