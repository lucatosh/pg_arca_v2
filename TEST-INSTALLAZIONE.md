# Test di installazione 1.0.0-rc.1 (su una macchina tua)

Ramo: `release/1.0.0-rc.1`. Guida completa in inglese: [INSTALL.md](INSTALL.md). Qui solo i comandi, nell'ordine.

## 0. Cosa serve
- **Macchina console**: Linux x86_64 con systemd (Debian 12, Ubuntu 22.04/24.04, Rocky/Alma 9), accesso root, 2 GB di RAM. Node.js NON serve: è dentro il pacchetto.
- **Server PostgreSQL** (può essere la stessa macchina o un'altra): PostgreSQL 14-18 già installato e in funzione, Python 3.6+.
- I file della release (cartella `pg-arca-1.0.0-rc.1`):
  `pg-arca-console-1.0.0-rc.1-linux-x64.tar.gz`, `pg-arca-agent-1.0.0-rc.1.tar.gz`, `pg-arca-agent_1.0.0~rc.1_all.deb`, `pg-arca-agent-1.0.0~rc.1-1.noarch.rpm`, `SHA256SUMS`, `BUILDINFO`.

I file sono sulla VM del lab in `~/release-rc1` (costruiti dal ramo `release/1.0.0-rc.1`). Prima controlla che la build sia finita (l'ultima riga deve essere `== artifacts in /home/lab/release-rc1` seguita dall'elenco):
```powershell
ssh lab@192.168.1.179 "tail -12 lablogs/release-rc1.log"
```
Poi, da PowerShell sul PC (`<IP-CONSOLE>` = indirizzo della macchina di test):
```powershell
scp -r lab@192.168.1.179:release-rc1 "$HOME\Downloads\pg-arca-1.0.0-rc.1"
scp -r "$HOME\Downloads\pg-arca-1.0.0-rc.1" root@<IP-CONSOLE>:/root/
```
(oppure direttamente dalla macchina di test: `scp -r lab@192.168.1.179:release-rc1 /root/pg-arca-1.0.0-rc.1`, con la password dell'utente lab.)

## 1. Console
```bash
cd /root/pg-arca-1.0.0-rc.1
sha256sum -c SHA256SUMS                      # tutte "OK"
tar xzf pg-arca-console-1.0.0-rc.1-linux-x64.tar.gz
cd pg-arca-console-1.0.0-rc.1-linux-x64
sudo ./install-console.sh --tls-self-signed --port 8443
```
Alla fine stampa l'indirizzo e il **codice di setup**. Apri `https://<IP-CONSOLE>:8443` (il browser avvisa del certificato autofirmato: accetta), crea l'amministratore con il codice.

Firewall, se attivo: Debian/Ubuntu `sudo ufw allow 8443/tcp`; Rocky/Alma `sudo firewall-cmd --permanent --add-port=8443/tcp && sudo firewall-cmd --reload`.

Variante senza TLS (solo laboratorio): `sudo ./install-console.sh` → `http://<IP-CONSOLE>:3000`.

Controlli:
```bash
sudo /opt/pg-arca-console/current/install-console.sh --status
journalctl -u pg-arca-console -f
curl -k https://127.0.0.1:8443/api/health          # {"ok":true,...,"version":"1.0.0-rc.1"}
```

Variante container (al posto dell'installer, macchina con Docker):
```bash
cd pg-arca-console-1.0.0-rc.1-linux-x64
docker build -t pg-arca-console:1.0.0-rc.1 .
docker run -d --name pg-arca-console -p 3000:3000 -v pg-arca-console:/var/lib/pg-arca-console pg-arca-console:1.0.0-rc.1
docker logs pg-arca-console                         # codice di setup
```

## 2. Agent sul server PostgreSQL
Con il certificato autofirmato l'agent deve conoscerlo. Sul server PostgreSQL:
```bash
scp root@<IP-CONSOLE>:/etc/pg-arca-console/tls/console.crt /root/console.crt
```
(con la console in http salta questo passo e togli `--cacert …` e `PG_ARCA_TLS_CA=…` dai comandi sotto).

Il token: console → **Clusters → Connect cluster → With agent → Generate the install command**, copia il valore `arca_enr_…` (vale 1 ora, per un server).

**A. Dalla console (curl)** — nella finestra del comando spunta «The console uses a private or self-signed certificate»: il comando scarica e fissa il certificato della console da solo. Equivale a:
```bash
curl -fsSL --cacert /root/console.crt https://<IP-CONSOLE>:8443/agent/install.sh | \
  sudo PG_ARCA_URL=https://<IP-CONSOLE>:8443 PG_ARCA_TLS_CA=/root/console.crt PG_ARCA_ENROLL_TOKEN=arca_enr_XXXX bash
```

**B. Offline (tarball)**:
```bash
cd /root/pg-arca-1.0.0-rc.1
tar xzf pg-arca-agent-1.0.0-rc.1.tar.gz && cd pg-arca-agent-1.0.0-rc.1
sudo PG_ARCA_URL=https://<IP-CONSOLE>:8443 PG_ARCA_TLS_CA=/root/console.crt PG_ARCA_ENROLL_TOKEN=arca_enr_XXXX ./install-agent.sh
```

**C. Pacchetto** (Debian/Ubuntu o Rocky/Alma), poi la registrazione una volta sola:
```bash
sudo apt install ./pg-arca-agent_1.0.0~rc.1_all.deb           # Debian/Ubuntu
sudo dnf install ./pg-arca-agent-1.0.0~rc.1-1.noarch.rpm      # Rocky/Alma/RHEL
sudo PG_ARCA_URL=https://<IP-CONSOLE>:8443 PG_ARCA_TLS_CA=/root/console.crt PG_ARCA_ENROLL_TOKEN=arca_enr_XXXX /usr/share/pg-arca-agent/install-agent.sh
```

Senza token: togli `PG_ARCA_ENROLL_TOKEN=…`; il server compare nella console come “New server detected” e lo approvi tu. Host senza database (backup server, host di recupero): aggiungi `PG_ARCA_ROLE=worker`.

Controlli sul server:
```bash
systemctl status pg-arca-agent
journalctl -u pg-arca-agent -f
```
Poi nella console: il cluster compare in **Clusters**; scheda **Backup → Enable WAL archiving**, poi un backup completo.

## 2b. Facoltativo: copia e ripristino dello stato della console, token API
```bash
sudo /opt/pg-arca-console/current/install-console.sh --backup-state /root/arca-bk          # stampa il percorso dell'archivio
sudo /opt/pg-arca-console/current/install-console.sh --restore-state /root/arca-bk/console-state-*.tar.gz --yes   # ferma, salva lo stato attuale in backups/, carica, riparte
```
Da Users → *API tokens* crea un token (ruolo Read-only, scadenza 1 giorno) e prova: `curl -sk -H "Authorization: Bearer arca_api_…" https://<IP-CONSOLE>:8443/api/clusters`.

Nota: questi tre percorsi (installazione pulita, rollback automatico, pacchetti agent) sono già passati da `tools/lab/release-test.sh` su container Debian 12 / Rocky 9 / Ubuntu 24 **solo con la build ≥ 9c8c987**: una build precedente dà «install exits 2» alla fine della prima installazione (la console funziona lo stesso) e `install-agent.sh: Permission denied` dai pacchetti.

## 3. Pulizia
```bash
# agent (tutti i metodi; tiene backup e archivio WAL, rifiutato se PostgreSQL archivia ancora con pg_arca: prima spegni l'archiviazione)
sudo PG_ARCA_UNINSTALL=1 /usr/share/pg-arca-agent/install-agent.sh      # se installato col pacchetto: oppure apt remove / dnf remove pg-arca-agent
curl -fsSL --cacert /root/console.crt https://<IP-CONSOLE>:8443/agent/install.sh | sudo PG_ARCA_UNINSTALL=1 bash   # se installato con A
# console
sudo /opt/pg-arca-console/current/install-console.sh --uninstall                 # tiene lo stato
sudo /opt/pg-arca-console/current/install-console.sh --uninstall --purge --yes   # cancella tutto
```

## Cosa annotare
Distribuzione e versione, metodo usato, il messaggio esatto e `journalctl -u pg-arca-console -n 50` / `journalctl -u pg-arca-agent -n 50` per qualsiasi errore.
