# Campagna di test per rafforzare il prodotto (17/10)

Test da fare in autonomia su infrastruttura vera (lab sulla VM, Proxmox, macchine dei clienti), in ordine di valore. Per ognuno: cosa si fa, cosa deve succedere, dove guardare se non succede. Quello che è già coperto dai test automatici (unit, 60 suite PostgreSQL, e2e della console, matrice 14–18) **non** è ripetuto qui: qui c'è ciò che solo un ambiente reale prova.

Prima di ogni giro: `tools/lab/deploy.sh release/1.0.0-rc.1` (build, console, tutti gli agenti aggiornati e verificati: la tabella finale deve dire «every online agent is current»).

## A. Dove stanno i backup (funzioni nuove: priorità massima)

| # | Test | Esito atteso |
|---|---|---|
| A1 | **Backup server vero**: su `bk1` (worker, ruolo Backup server) esportare via NFS una cartella con i comandi della sequenza guidata; montarla su pg1–pg3; Backup → Where the backups are stored → Configure… → backup server bk1 → livello «ambiente» → controllo → applica. Poi backup completo e ripristino a un istante | ogni nodo «Backup server bk1 · NFS», «shared by all nodes»; sotto la base compaiono da sole `prod/<cluster>-<id>/backup` e `/wal`; il ripristino a un istante funziona |
| A2 | **Più cluster sulla stessa condivisione** (lab Patroni + solo1 + s14 sulla stessa base) | una directory per cluster, nessun file mescolato; colonna «In use on the nodes» coerente |
| A3 | **Rinomina un cluster** già applicato, poi backup | continua a scrivere nella stessa directory (nessuna modifica pendente) |
| A4 | **Condivisione montata dalla macchina sbagliata** (stesso export su un altro host, oppure disco locale) e controllo | il controllo rifiuta con «mounted from X, not from the backup server bk1» e non crea nulla; se il cambio avviene dopo l'applicazione: avviso «Backups are not written to the backup server…» in Today |
| A5 | **NFS con `nolock`** | il controllo rifiuta il repository (lock locali al nodo) |
| A6 | **Condivisione persa durante un backup** (`exportfs -u` o stop di nfs-server a metà backup, poi ripristino) | il backup fallisce con un messaggio chiaro, niente scritto sul disco locale, l'archiviazione WAL riprende da sola quando la condivisione torna, nessun buco nell'archivio |
| A7 | **SMB vero** (Samba in un container) come archivio WAL | il controllo verifica i link fisici; con una condivisione senza link fisici (es. opzioni Samba che li negano) rifiuta l'archivio WAL |
| A8 | **Osservatore e operatore**: entrare con un utente `viewer` e uno `operator` e girare tutte le pagine (Backup, Storage & recovery, Worker hosts, nodi, Activity, approvazioni) | nessun percorso, mount o indirizzo visibile; nessuna pagina rotta |
| A9 | **Cambio di storage con migrazione** su un cluster con backup veri: piano, migrazione con limite di banda, interruzione (stop agent) e ripresa, cancellazione della vecchia posizione | copia verificata e ripresa; cancellazione rifiutata finché qualcosa esiste solo lì; PITR attraverso il cambio funziona |

## B. WAL: duplicazioni e divergenze

| # | Test | Esito atteso |
|---|---|---|
| B1 | **Split-brain simulato** sul lab Patroni: isolare il primario (`docker network disconnect`) mentre ha traffico (`./lab.sh bench`), lasciare che Patroni promuova un altro nodo, riconnettere il vecchio | finding critico «Timeline N continued after its promotion point» se il vecchio ha archiviato; «File away» nella pagina Backup li mette in quarantena; nessun segmento sovrascritto |
| B2 | **Ripristino dopo due o tre failover** (timeline 3+), con un ramo morto messo da parte (buco nella numerazione) | il ripristino «ultimo istante» arriva alla timeline viva più recente (nel `postgresql.auto.conf` del ripristino c'è un numero, non `latest`) |
| B3 | **Ripristino a un istante prima di un failover** | dati coerenti con quella timeline, nessun «not a child of this server's history» |
| B4 | **Archiviazione asincrona sotto carico** (pgbench pesante 30 min, poi kill -9 dell'agent e del postmaster) | spool svuotato in ordine dopo il riavvio, nessun buco, RPO mostrato coerente |
| B5 | **Geo**: switchover pianificato e failover DR con ritorno del vecchio sito (fencing) | i due siti condividono la stessa directory/archivio; il sito che torna non archivia una timeline divergente |

## C. Ripristini (campagna su versioni e layout reali)

| # | Test | Esito atteso |
|---|---|---|
| C1 | `scenario-restore-matrix.py` su Patroni PG16, standalone PG15 personalizzato, PG14, Patroni PG18, Rocky/RHEL | ogni tipo di ripristino (tabella, righe, schema, database, server) verde |
| C2 | Database grande (`big.sh`, 50–100 GB): backup completo, incrementale, ripristino di una tabella e del server, drill | tempi annotati; RTO misurato vicino all'obiettivo dichiarato |
| C3 | Server di produzione perso (PGDATA cancellata su uno standalone): ripristino «server» | torna primario, dati all'ultimo segmento archiviato, l'originale conservato |
| C4 | Ripristino su un host centrale (worker «Recovery host») di una versione diversa dal nodo | binari corretti installati e usati, consegna al primario |

## D. Resistenza

| # | Test | Esito atteso |
|---|---|---|
| D1 | Console spenta 1 ora durante il traffico | gli agenti continuano ad archiviare; al ritorno lo stato si riallinea senza duplicati di operazioni |
| D2 | Disco del repository o dell'archivio WAL pieno | avvisi in Today prima del pieno; dopo aver liberato spazio tutto riparte da solo |
| D3 | Riavvio di un nodo (o kill dell'agent) durante backup, verifica, ripristino, migrazione | operazioni chiuse con stato chiaro, ripresa o pulizia dal registro; nessuna istanza temporanea rimasta accesa |
| D4 | Orologio di un nodo avanti di 10 minuti | finding «clock ahead», età dei backup non falsate |
| D5 | Rete lenta verso il backup server (`tc qdisc add … delay 200ms loss 1%`) | backup più lenti ma corretti; nessun timeout che lasci set a metà come COMPLETE |

## E. Installazione, aggiornamento, sicurezza

| # | Test | Esito atteso |
|---|---|---|
| E1 | `TEST-INSTALLAZIONE.md` su VM pulite Debian 12, Rocky 9, Ubuntu 24.04 (console + 2 agenti) | installazione, aggiornamento e ritorno automatico verdi |
| E2 | Aggiornamento da una build precedente con nodi in funzione (`deploy.sh`) | nessuna interruzione dell'archiviazione; `agents-sync.sh` termina «every online agent is current» |
| E3 | RHEL 9 con **SELinux enforcing** | archiviazione WAL funzionante; nessun AVC (`ausearch -m avc -ts recent`) |
| E4 | Console con TLS e CA privata, token API per uno script, approvazione a quattro occhi in produzione | flussi completi; senza approvazione nulla parte |
| E5 | LDAP/Active Directory reale | login con ruoli dai gruppi; utente disabilitato non entra |

## F. Prestazioni e durata

| # | Test | Esito atteso |
|---|---|---|
| F1 | Soak di 48–72 ore con la policy «Critical production» (fulls, incrementali, verifiche, drill programmati) | nessun finding inatteso, spazio stabile con la retention, nessuna perdita di memoria dell'agent o della console |
| F2 | Confronto con pgBackRest sullo stesso hardware (stesso database, full e incrementale, ripristino) | numeri da usare nelle demo solo se misurati qui |
| F3 | Velocità del formato a pack su NFS reale (`iobench.py` + backup) | throughput annotato in ARCHITETTURA §7g |

Esiti: annotare ogni giro in `tools/lab/NOTES.md` (data, build, esito, problemi) e aprire un'attività per ogni difetto trovato; un difetto di perdita dati o ripristino sbagliato blocca la release finale.
