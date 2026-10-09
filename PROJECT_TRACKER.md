# pg_arca — registro dei componenti

Ultimo aggiornamento: 2026-10-09. Ogni riga dice **cosa è stato davvero eseguito**; non c’è nulla di "validato" senza un test dietro.

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
| Audit e rilevamento aggregato | `server/platform.ts` | Reale | `api.test.ts` |
| Log in tempo reale (WebSocket), scansione di rete | `server/logs.ts`, `server/netscan.ts` | Scritti; **non eseguiti** (mancano `ws`/`express` nell’ambiente di sviluppo): solo controllo sintattico | — |
| Agent: rilevamento, esecutore, Patroni, WAL, CLI | `unix-agent/pg_arca/*` | Reale | `unix-agent/tests` |
| Motore backup/ripristino | `unix-agent/pg_arca/engine/*` | Reale | 15 test su PostgreSQL 16 |
| Interfaccia web modulare | `src/*` | Reale, provata nel browser | `tests/ui/e2e.cjs` (agent simulato) |
| HBA, LDAP/AD, RBAC, tuning, modelli globali | — | **Anteprima** (marcati in UI) | — |

## Cosa coprono i test del motore (PostgreSQL 16)
backup completo; incrementale (più piccolo, a catena); deduplica; PITR di un’istanza; ripristino sparso di un database; ripristino di un oggetto; ripristino fallito che non lascia nulla; `target_time` senza fuso rifiutato; percorsi protetti; verifica e info; prova di ripristino; rilevamento di blocchi corrotti; ricerca DROP/TRUNCATE; sicurezza dopo un backup interrotto; pulizia.

## Decisioni
- Un solo cluster demo; nessun altro dato fittizio.
- Nessuna simulazione presentata come reale: ciò che non funziona è "Anteprima" o risponde con un errore chiaro.
- Ripristino sempre non distruttivo (nome nuovo / quarantena / cartella vuota).
- UI riscritta da zero in moduli (CSS semplice, nessuna dipendenza oltre React); il vecchio monolite da 4247 righe, Tailwind e lucide sono stati rimossi.
- `server.ts` ridotto da ~2700 a ~90 righe: le rotte simulate (HA, HBA, LDAP, RBAC, PITR, stanze, politiche, parametri, tuning) sono state eliminate; HA e parametri passano dal motore operazioni.

## Da fare
1. Provare `direct.ts`, `logs.ts` e `netscan.ts` con `npm install` su una macchina con rete.
2. Provare HA e parametri su un cluster Patroni reale.
3. Operazione "promuovi" per spostare una tabella dalla quarantena al database di produzione.
4. Benchmark contro pgBackRest prima di qualsiasi affermazione di velocità.
5. HBA, LDAP/AD, RBAC, tuning, modelli globali: oggi anteprima.
6. Integrare i documenti di progetto v1.0–v1.2 (non presenti nel repository).
