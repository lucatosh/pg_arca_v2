# Demo presso il cliente: preparazione e percorso (17/10)

Documento interno per chi presenta. Le funzioni citate esistono e sono coperte dai test indicati in README («Real status of the features»); ciò che non è provato è elencato in fondo: non va promesso.

## 1. Ambiente (una VM basta)

- **Console**: pacchetto `pg-arca-console` (tar con runtime incluso + installer systemd, oppure container). Primo accesso: creazione dell'amministratore.
- **Database**: il lab Docker (`tools/lab`: Patroni 3 nodi PG16 + HAProxy) oppure 1–2 server PostgreSQL 14–18 qualsiasi. Aggancio da *Clusters → Connect cluster → With agent*: un comando da incollare come root.
- **Backup server** (consigliato, è il punto forte della demo «dove stanno i backup»): una macchina con l'agent in modalità worker (`PG_ARCA_ROLE=worker`), ruolo *Backup server* dalla sua pagina, cartella esportata via NFS e montata su ogni nodo con i comandi che la console stessa genera.
- **Utenti**: `admin` (amministratore) e un `viewer` (osservatore) per mostrare che i percorsi non sono visibili a chi non deve vederli.
- Prima della demo: un backup completo, una policy assegnata («Critical production»), qualche minuto di traffico (`./lab.sh bench`) così il WAL scorre.

## 2. Percorso consigliato (30–40 minuti)

1. **Today**: cosa richiede attenzione, con causa e prossimo passo; frase unica «è protetto?» per cluster.
2. **Pagina Backup del cluster → Where the backups are stored**: per ogni nodo backup server / condivisione / disco locale, spazio, condivisa da tutti i nodi (provata). «Show locations» rivela le cartelle (solo amministratori). **Configure…**: la sequenza guidata (backup server → controllo della cartella sul server → comandi export/mount → livello → riepilogo → controllo su ogni nodo che rifiuta una condivisione montata da un'altra macchina → applica).
3. **Backup policy**: modello «Critical production» (full, incrementali, retention in giorni di PITR, verifiche, drill di disaster recovery, RPO/RTO dichiarati).
4. **Run a backup** e la finestra di log dell'operazione; **Mark a restore point** («Before release 4.2»).
5. **Restore guidato** dal problema: «Put back a dropped or emptied table» → il WAL viene analizzato e propone l'istante prima del DROP/TRUNCATE → piano (dove avviene, spazio, controlli) → copia accanto → rimessa a posto con conferma. Poi «righe sbagliate» con confronto riga per riga.
6. **Disaster recovery drill**: RTO misurato e mostrato accanto all'obiettivo.
7. **Storage & recovery**: colonna «In use on the nodes» per tutta la flotta; dove avvengono i ripristini (istanza di recupero su nodo o host centrale).
8. **Sicurezza e governance**: accesso come `viewer` (percorsi nascosti ovunque, pulsanti di modifica assenti), approvazione a quattro occhi in produzione, Activity log, token API per l'automazione.
9. Se c'è tempo: **pg_hba** (matrice di accesso, modifiche via DCS su Patroni), **Geo-redundancy** (switchover pianificato tra due siti).

## 3. Reset fra una demo e l'altra

- Lab: `./lab.sh reset && ./lab.sh up`, poi riapprovare i nodi; console: `install-console.sh --backup-state` prima, `--restore-state` per tornare allo stato preparato.

## 4. Da non promettere (non ancora provato o non disponibile)

- Object storage come destinazione primaria (S3/Azure/GCS/SFTP: anteprima; esiste la copia offsite S3, provata con S3 simulato).
- Kubernetes/operatori (non supportato), FreeBSD/Alpine reali, SELinux enforcing reale, SMB reale, export NFS da un worker provato sul lab (NFS reale come destinazione sì), AD/LDAP reale, revisione di sicurezza esterna (gate della release finale).
- Confronti di velocità con pgBackRest senza benchmark sul hardware del cliente.
