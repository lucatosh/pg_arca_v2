#!/usr/bin/env python3
"""Lab: LAB-ACCESS.md - every machine of the lab and how to get in, from the live inventory of the Proxmox host (inventory.sh) plus what each one is for.
ONE password for everything the lab creates (root of every container, postgres / replicator / rewinder roles): LAB_PW (on the VM: ~/.arca-lab-pw).
Regenerated every time something is created on Proxmox:
  ssh root@192.168.1.5 bash -s < tools/lab/proxmox/inventory.sh | LAB_PW=$(cat ~/.arca-lab-pw) python3 tools/lab/proxmox/access-table.py > LAB-ACCESS.md
The repository must be PRIVATE before this file is committed (it holds the lab password)."""
import os
import sys
import time

PW = os.environ.get("LAB_PW") or "(vedi ~/.arca-lab-pw sulla VM)"
ROLE = {   # what each container is for (name -> text); unknown names are listed anyway
    "deb12-pg15": "server vergine: Debian 12, PostgreSQL 15 della distribuzione (systemd postgresql@15-main)",
    "ubu24-pg16": "server vergine: Ubuntu 24.04, PostgreSQL 16 della distribuzione",
    "deb12-pg17-custom": "server vergine: PostgreSQL 17 PGDG in /srv/pgdata/17, porta 5544, un tablespace",
    "rocky9-pg14": "server vergine: Rocky 9, PostgreSQL 14 PGDG (systemd postgresql-14)",
    "deb12-pg18-two": "server vergine: PostgreSQL 18 PGDG, due istanze (5432 e 5433)",
    "pat1": "cluster Patroni pat (1/3), PostgreSQL 16, etcd", "pat2": "cluster Patroni pat (2/3)", "pat3": "cluster Patroni pat (3/3)",
    "hyb1": "georidondanza: sito hy-rm (Patroni, Rocky 9, PG16) nodo 1", "hyb2": "georidondanza: sito hy-rm nodo 2",
    "hybx": "georidondanza: sito hy-rm, etcd + HAProxy :5000 (leader del sito)",
}
PORT = {"deb12-pg17-custom": "5544", "deb12-pg18-two": "5432, 5433"}

host, rows, vms = None, [], []
for ln in sys.stdin:
    f = ln.rstrip("\n").split("|")
    if f[0] == "host":
        host = f
    elif f[0] == "ct":
        rows.append(f)
    elif f[0] == "vm":
        vms.append(f)

out = ["# Accesso al lab", "",
       "> Generato da `tools/lab/proxmox/access-table.py` il %s. **Una sola password per tutto ciò che il lab crea: `%s`** "
       "(root di ogni container, ruoli PostgreSQL `postgres` / `replicator` / `rewinder`). Repository privato: non renderlo pubblico con questo file." % (time.strftime("%Y-%m-%d %H:%M"), PW), "",
       "## Macchine principali", "",
       "| Macchina | Indirizzo | Accesso | Note |", "|---|---|---|---|",
       "| VM Ubuntu del lab (VirtualBox `ubuntu26` sul PC) | 192.168.1.179 | `ssh lab@192.168.1.179` — password `lab` | console pg_arca su http://192.168.1.179:3000 (utente di test `claude-test` / `claude-lab-test-pass-1`); Docker dei lab; chiave ssh verso Proxmox |",
       "| Host Proxmox `%s` | %s | `ssh root@%s` dalla VM (chiave); web https://%s:8006 | password di root del proprietario (non gestita dal lab). %s |" % (
           host[1] if host else "proxmox", host[2] if host else "192.168.1.5", host[2] if host else "192.168.1.5", host[2] if host else "192.168.1.5", host[3] if host else ""),
       "", "## Container su Proxmox", "",
       "| CT | Nome | Indirizzo | Sistema | Stato | Accesso | PostgreSQL | A cosa serve |", "|---|---|---|---|---|---|---|---|"]
for f in rows:
    _, cid, name, ip, os_, st, sshd, pg = (f + [""] * 8)[:8]
    access = ("`ssh root@%s` (password standard)" % ip) if sshd == "yes" else ("`pct enter %s` dall'host (ssh non installato)" % cid)
    pgs = pg.strip()
    if pgs.startswith("/"):
        pgs = pgs.split(" --")[0]
    pgtxt = ("%s — `psql -h %s -p %s -U postgres` (password standard)" % (pgs, ip, PORT.get(name, "5432"))) if pgs else "—"
    out.append("| %s | %s | %s | %s | %s | %s | %s | %s |" % (cid, name, ip or "?", os_ or "?", st, access, pgtxt.replace("|", "/"), ROLE.get(name, "")))
for f in vms:
    out.append("| VM %s | %s | | | %s | | | |" % (f[1], f[2], f[4] if len(f) > 4 else ""))
out += ["", "## Regole", "",
        "- Ogni nuova macchina su Proxmox prende la password standard (`tools/lab/proxmox/standard-access.sh <ctid>`) e questa tabella viene rigenerata e committata.",
        "- Le password non stanno negli script: arrivano da `LAB_PW` / `~/.arca-lab-pw` sulla VM.", ""]
print("\n".join(out))
