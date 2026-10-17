# Destinazione dei backup: progetto e stato (12/10)

Richiesta dell'utente: dal webtool scegliere **dove** vanno repository e archivio WAL **per ambiente e per cluster**, in locale o verso una macchina/servizio; capire **chi scrive** (utente di sistema o servizio); **provare la scrittura** e i permessi; se la cartella cambia, **migrare in background** il contenuto vecchio mostrando occupazione attuale e spazio sulla nuova. Organizzazione enterprise e sicura.

## Stato (12/10 sera)

Fatto e provato su PostgreSQL 16 reale (§1-4): due identità provate (agent + server via `pg-arca-wal probe` in `COPY … TO PROGRAM`), prove estese e comandi di correzione (`engine/destcheck.py`); cambio senza perdere la storia PITR (`repo_previous` / `wal_previous` tenute dall'agent da solo, lette da ripristini, piani e `restore_command`, mai da backup/deduplica/scadenza); verifica del primo segmento con ritorno automatico; approvazione a quattro occhi (`destination_apply`); migrazione `destination_migrate` (piano + copia verificata e riprendibile, `engine/migrate.py`); eliminazione `destination_drop_old` (conferma ELIMINA, rifiuto se qualcosa esiste solo lì o se la nuova non ha un backup completo); interfaccia (pagina Backup → «Controlla», «Migra o elimina»; Ripristino e archivi → Destinazione dei backup). Il marcatore di proprietà dell'archivio WAL esisteva già (`ARCHIVE_OWNER.json`): il controllo lo legge.

Da fare: prove sul lab con NFS (root_squash, uid diversi) e SMB veri, Patroni con più nodi (il cambio va su ogni nodo; la verifica del WAL solo sul primario), utenze diverse reali (agent ≠ postgres); un backup completo avviato subito dopo l'applicazione (oggi lo fa il prossimo backup pianificato, che nella nuova posizione diventa completo da sé: la continuità PITR è garantita dalla posizione precedente leggibile); fase 2 (§6). Un fallimento isolato di `test_destination_migrate_pg.test_03` (1 su 7 esecuzioni, non riprodotto: errore nel recupero `_recover_once`) va osservato nella matrice.

Base esistente: `server/destinations.ts` (ambiti globale > ambiente > cartella > cluster, segnaposto `{env}` `{cluster}` `{id}`, applicazione solo dopo `destination_check` riuscito su ogni nodo), `unix-agent/pg_arca/engine/destcheck.py` (tipo di filesystem, scrittura O_EXCL + fsync + rename, spazio), pagina Ripristino e archivi → Destinazione dei backup. Solo locale e NFS/SMB già montati; i backup esistenti non vengono spostati.

## 1. Chi scrive: due identità, non una

Su ogni nodo scrivono **due processi**, che possono avere utenti diversi:
- l'**agent** (backup, scadenza, salvataggio WAL, migrazione) — utente del servizio `pg-arca-agent`;
- l'**`archive_command`**, eseguito dal **server PostgreSQL** (utente del postmaster, di solito `postgres`, ma non sempre: container, pacchetti personalizzati, Patroni).

Il controllo deve provare **entrambe** le identità:
- agent: come oggi, da sé;
- server: attraverso PostgreSQL stesso — `COPY (SELECT 1) TO PROGRAM '<pg-arca-wal> probe <dir> <token>'` (superuser, già richiesto) esegue la prova con l'utente e l'ambiente reali dell'`archive_command`. Nessun `sudo`.

Il piano mostra per nodo: utente/gruppo di ciascuno, uid/gid **numerici** (contano su NFS), proprietario e modi della cartella, ACL, risultato delle prove.

Modello consigliato e proposto dalla console (sempre mostrato come comandi, eseguiti dall'amministratore):
- stessa utenza per agent e server (caso comune: `postgres`), cartella `0700`;
- utenze diverse: gruppo dedicato `pgarca`, cartella `2770` (setgid: i file nuovi ereditano il gruppo), `umask 0007` per l'agent, ACL di default `setfacl -d -m g:pgarca:rwX` dove il filesystem le supporta;
- **mai root**; mai `0777`.

Casi di rete (spiegati nel piano, con il controllo che li riconosce):
- **NFS**: uid/gid devono coincidere su tutti i nodi (o `all_squash,anonuid,anongid` sull'export); `root_squash` è normale e non è un problema perché nessuno scrive come root; con NFSv4 + idmap e domini diversi i file appaiono `nobody` → il controllo lo rileva confrontando il proprietario letto con l'uid che ha scritto. Opzioni di mount consigliate `hard` (mai `soft`: perdita silenziosa di scritture), `noatime`.
- **SMB/CIFS**: proprietario e modi li decidono le opzioni di mount (`uid=`, `gid=`, `file_mode=`, `dir_mode=`), non chmod; credenziali in un file `0600` di root sul nodo (`credentials=`), **mai nella console**. Il rename atomico e l'fsync vengono provati davvero (alcuni server SMB mentono).
- **Montato?** Se `requireMount` è attivo, la cartella deve stare sul filesystem di rete atteso: un mount mancante al momento del backup non deve mai scrivere sul disco di sistema (già nel controllo) — da estendere: lo stesso controllo **a ogni scrittura** dell'archivio WAL (file marcatore sulla destinazione, assente sul disco locale).

Servizi (fase 2, vedi §6): l'identità è una credenziale, non un utente di sistema.

## 2. Prove di scrittura (estensione di `destination_check`)

Per ogni nodo del cluster (primario, repliche, nodi del sito di replica geo) e per l'eventuale backup server centrale:
1. esistenza / creabilità del percorso (se manca: proposta di comando, non creazione silenziosa fuori da cartelle dell'agent);
2. filesystem e mount (tipo, sorgente, opzioni `soft`/`hard`, sola lettura);
3. scrittura come l'agent: O_EXCL, scrittura, fsync file e cartella, rename atomico, rilettura e confronto, cancellazione;
4. **scrittura come il server** (`archive_command`) tramite `COPY … TO PROGRAM` e verifica che l'agent legga quel file (e viceversa): incrocio delle identità;
5. permessi effettivi dei file creati (umask, gruppo ereditato, ACL) e che nessun altro utente li legga (repository non cifrato = dati in chiaro);
6. spazio e **inode** liberi; prestazione indicativa (latenza fsync, MB/s su 64 MB) con soglie di avviso;
7. **unicità dell'archivio WAL**: file marcatore `.pgarca-owner.json` con system identifier e stanza; un archivio già usato da un altro cluster = blocco (due cluster sovrascriverebbero gli stessi nomi di segmento);
8. per lo stesso repository visto da più nodi: un nodo scrive un file, gli altri devono vederlo (stessa condivisione davvero, non cartelle locali omonime).

Risultato: semaforo per nodo e per prova, con il comando di correzione per ogni prova rossa. L'applicazione resta bloccata finché un nodo è rosso; un nodo offline è un blocco salvo conferma esplicita.

## 3. Applicare una destinazione nuova (senza perdere la continuità PITR)

Flusso: bozza → controllo su ogni nodo → piano → **approvazione a quattro occhi** (operazione rischiosa) → applicazione.
- Il catalogo della console registra le destinazioni **storiche** del cluster (`locations[]` con date): i backup restano ripristinabili da dove si trovano; il restore legge da tutte (repository «catena» per il catalogo e l'archivio WAL: `restore_command` cerca il segmento nella nuova e poi nelle vecchie).
- Cambio dell'archivio WAL: `archive_command` nuovo (Patroni: **solo via DCS**, come da regola), seguito da `pg_switch_wal()`; l'agent verifica che il primo segmento arrivi nella nuova destinazione prima di dichiarare riuscito.
- Subito dopo: **backup COMPLETO** nella nuova destinazione (lo scheduler lo avvia da sé); fino ad allora la vecchia resta necessaria e la console lo dice.
- Annullamento: finché non è arrivato il primo segmento nella nuova, ritorno automatico alla vecchia.

## 4. Migrazione in background del contenuto vecchio

Opzione nel piano, con i numeri prima di iniziare:
- **occupazione attuale** della vecchia destinazione (repository + WAL, per cluster; misurata dall'agent, non stimata), numero di file;
- **spazio libero sulla nuova** e quanto ne resterebbe dopo (anche inode), per volume (stessa logica dei controlli di spazio del restore); blocco se non basta, avviso sotto il 10% libero;
- tempo stimato da una misura reale di velocità.

Esecuzione (operazione `destination_migrate` dell'agent, una per cluster, mai due insieme):
- copia **riprendibile** (stato su disco: si riprende dopo riavvio dell'agent o del nodo), limitata in banda (MB/s regolabile), annullabile;
- ordine: blocchi/chunk del repository (contenuto indirizzato da hash: la copia si verifica ricalcolando l'hash, i duplicati non si ricopiano), poi manifest e metadati dei set, poi i WAL; ogni file scritto con O_EXCL + fsync + rename;
- **verifica** finale: conteggi, hash a campione o completa (scelta), `repo_info` dalla nuova destinazione;
- solo dopo la verifica il catalogo punta alla nuova per quei set; la vecchia **non viene cancellata**: la rimozione è un'azione separata, con conferma digitata, dopo un periodo di sicurezza, e registrata nell'audit;
- i backup e l'archiviazione continuano durante la migrazione (nella nuova); i restore leggono da entrambe;
- repository cifrato: i file si copiano cifrati, la chiave non cambia e non transita.

UI: avanzamento (byte, file, velocità, ETA), pausa/riprendi/annulla, esito con verifica, notifica (webhook) a fine o in errore.

## 4b. Dove sono i backup, per nodo, e la sequenza guidata (17/10)

Richiesta: rendere chiaro dove stanno i backup rispetto a ogni nodo/ambiente; scegliere la macchina (tra i worker «Backup server»), una condivisione o il disco locale; i percorsi sono configurazione sensibile, non vanno mostrati in chiaro ma con le sequenze giuste.

- **Agent:** ogni nodo riporta `storage.repo_mount` / `storage.wal_mount` (`runtime.mount_info`: punto di mount, fstype, sorgente, `remote_host` estratto da `server:/export`, `[ipv6]:/x`, `//server/share`). I worker riportano `worker.identity` (hostname, FQDN, indirizzi non loopback).
- **Console, `GET /api/clusters/:id/storage`:** per nodo e per repository/WAL dice *backup server X* (worker con ruolo `repository` riconosciuto dal `remote_host` per nome, nome corto, FQDN o indirizzo), *condivisione da un worker senza ruolo*, *condivisione di rete*, *disco locale*, *non riportato*; spazio libero; stesso disco dei dati; **condivisa / divisa / sconosciuta** provata dall'id scritto nella cartella (`.pgarca-id`), non dedotta dai percorsi. Percorsi, sorgenti di mount e indirizzi dei server solo agli amministratori.
- **Mascheramento:** per operatori e osservatori `(hidden)` al posto di percorsi/sorgenti/indirizzi in: `/destination`, `/placement` (parte backup), `/api/scoped/destination`, `/api/clusters/:id/scoped/destination`, operazioni `destination_check/migrate/drop_old`, `agent_config_set`, `destination_apply` (parametri e risultati, anche nelle approvazioni), audit `destination.*`, `repo_path` del riepilogo backup. `source` è mascherato solo se ha l'aspetto di un percorso o di un host (la «sorgente» agent/direct di un cluster resta). Anche la pagina e l'API dei worker (indirizzi, mount, directory) sono mascherate per i non amministratori; per gli amministratori i percorsi compaiono solo con «Show locations» (riquadro della pagina Backup, Storage & recovery, dialogo «Check and apply», testi dei controlli compresi). Anche le impostazioni dell'agent (repository, archivio WAL, posizioni precedenti) sono mascherate per i non amministratori.
- **Destinazione con backup server:** campi `server` (id del worker) e `serverPath` (cartella sul server). `type` deve essere NFS o SMB; `server` vale solo se impostato allo stesso livello che sceglie `type` (un livello sotto che passa a un'altra condivisione o al disco locale non eredita il controllo). Confronto dei nomi: indirizzi IP solo esatti, nome corto contro FQDN solo se il server non ha un FQDN proprio. Comandi NFS proposti: cartella di proprietà di uid:gid di PostgreSQL sui nodi (uguale su tutti), export `rw,sync,no_subtree_check` senza squash degli utenti normali (con `all_squash` i file apparivano di un altro proprietario e il controllo del proprietario falliva). Il controllo sui nodi riceve `expect_server {name, hosts}` e **rifiuta** (livello bad, nulla creato) un percorso montato da un'altra macchina (`destcheck._same_server`: nome, nome corto, risoluzione DNS). Se il worker viene rimosso, l'applicazione è rifiutata (`server_missing`).
- **Deriva**: finding `backup_server_mismatch` (avviso, conta per «è protetto?») quando la destinazione applicata nomina un backup server ma un nodo scrive attraverso un mount da un'altra macchina o dal disco locale (export uguale su un altro server, NAS sostituito).
- **Interfaccia:** pagina Backup → riquadro «Backup storage» (tabella per nodo in termini operativi, «Show locations» solo per amministratori, avvisi divisa/stesso disco/pendente/precedente); «Configure…» apre la sequenza guidata (`src/pages/StorageWizard.tsx`): Dove (backup server / condivisione esistente / disco locale) → Dettagli (scelta del server, protocollo, cartella sul server con controllo dal server, punto di mount sui nodi, comandi export/fstab pronti da copiare, avanzate) → A chi si applica (cluster, ambiente, cartella, tutti) → Riepilogo e Salva → «Check and apply on the nodes» (stesso controllo per nodo e applicazione di prima). Anche da Storage & recovery → Backup storage («Configure backup storage…»). La pagina del worker mostra «backup server for …» (configurazione) e «Holds the backups of» (i cluster i cui nodi montano davvero da lui). Storage & recovery → Backup storage: colonna «In use on the nodes» (`GET /api/storage-overview`: tipo reale, server, condivisa/divisa, stesso disco dei dati, senza percorsi) accanto al configurato; percorsi mostrati solo con «Show locations».
- **Test:** `tests/server/storage.test.ts` (riconoscimento server, condivisa/divisa, mascheramento di tutte le risposte, validazione, `expect_server`, server rimosso), `tests/test_destcheck.py::test_the_share_must_come_from_the_chosen_backup_server`, e2e (riquadro, rivelazione percorsi, sequenza guidata completa fino ad applicazione).

## 5. Sicurezza e governance

- Ruoli: solo amministratori impostano destinazioni; approvazione a quattro occhi per applicare e per cancellare la vecchia.
- Nessuna credenziale di storage in chiaro nella console: per SMB/NFS stanno sui nodi; per i servizi (fase 2) in un archivio segreti cifrato con chiave fuori dal database, mai restituite dalle API.
- Audit di ogni passo (chi, cosa, da→a, esiti per nodo).
- Repository non cifrato su condivisione di rete = avviso esplicito nel piano (proposta di cifratura).
- Retention e immutabilità: opzione «sola aggiunta» (nessuna cancellazione dalla destinazione per N giorni) per difesa da ransomware, dove il servizio la supporta (S3 Object Lock; su filesystem: separazione delle utenze per la scadenza).

## 6. Fase 2: macchina di destinazione e servizi senza mount

In ordine di valore/rischio:
1. **Backup server con agent worker come ricevitore** (bk1): i nodi inviano blocchi e WAL all'agent del backup server su canale TLS mutuo con certificati rilasciati dalla console; la destinazione è una cartella locale del backup server (valgono §1-4 lì). Nessun mount, nessuna credenziale condivisa.
2. **S3 compatibile** (AWS, MinIO, Ceph RGW): backend nativo del motore per repository e WAL (multipart, retry, checksum, Object Lock); poi Azure/GCS.
3. **SFTP**: solo se richiesto (prestazioni e atomicità del rename dipendono dal server).

## 7. Test previsti

- Unit: risoluzione per ambito, validazione percorsi, piano di migrazione, ripresa da stato.
- PG reale locale: utenze diverse per agent e postmaster (gruppo + setgid), prova via `COPY TO PROGRAM`, archivio già usato da un altro cluster, cambio di destinazione con PITR attraverso il cambio, migrazione interrotta e ripresa, cifrato.
- Lab: NFS vero (export con `root_squash` e con uid diversi), SMB vero, Patroni (archive_command via DCS), sito geo, backup server centrale.
