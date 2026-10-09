# Lab: problemi osservati e miglioramenti (aggiornato man mano)

| # | Data | Segnalazione | Stato |
|---|------|--------------|-------|
| 1 | 10/10 | Setup lento su VM (apt 98 kB/s, build immagine 28 min): rete VirtualBox/IPv6 | Consigli dati (ForceIPv4, virtio-net); da aggiungere ForceIPv4 a setup-host.sh se confermato |
| 2 | 10/10 | Console `:3000` "Not Found": UI `dist/` non compilata in modalità production | Corretto (setup-host/lab.sh fanno `vite build`) — non verificato su Ubuntu |
| 3 | 10/10 | Smoke: "0 repliche streaming" lanciato troppo presto | Corretto (attesa fino a ~3 min) |
| 4 | 10/10 | "Approva e collega" non chiude la finestra: passava alla richiesta successiva (stale `all`), ricliccando si approvava un altro server | Corretto: la finestra si chiude dopo l'approvazione |
| 5 | 10/10 | "PostgreSQL non rilevato" sui nodi → nessun cluster_key → ogni nodo crea un cluster separato "arca-lab" | Corretto: l'agent rifà discovery mentre non trova PG (agent parte prima di Patroni). Per i nodi già approvati: `./lab.sh agent-reset`, cancella i cluster nella console, riapprova |
