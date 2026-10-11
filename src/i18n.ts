/* Italian for the agent's check messages (the agent speaks English in logs and APIs; the console shows Italian). Pattern based: the dynamic parts
 * (paths, sizes, versions) are kept as they are; a message without a pattern is shown unchanged. Covered by tests/ui/i18n.test.ts. */
type Rule = [RegExp, (m: RegExpMatchArray) => string];
const ROLE: Record<string, string> = {
  'scratch of the recovery instance (extraction, WAL read-ahead, dump)': 'cartella temporanea dell’istanza di recupero (estrazione, lettura anticipata dei WAL, dump)',
  'data directory of the live cluster (restored database / quarantine copy)': 'cartella dati del cluster in uso (database ripristinato / copia di sicurezza)',
  'restore destination': 'destinazione del ripristino', 'tablespace destination': 'destinazione dei tablespace',
};
const roles = (s: string) => s.split(' + ').map(r => ROLE[r] || r).join(' + ');
const SRC: Record<string, string> = { configured: 'configurati', "this node's own": 'quelli del nodo', 'installed package': 'pacchetto installato', 'installed by pg_arca': 'installati da pg_arca' };
const RULES: Rule[] = [
  [/^the recovery host cannot reach the cluster that receives the result \((.+?)\): (.+)$/, m => `l’host di recupero non raggiunge il cluster che riceve il risultato (${m[1]}): ${m[2]}`],
  [/^the agent's user \((.+?)\) cannot create (restore destination|tablespace destination) (.+): (.+) is not writable for it$/, m => `l’utente dell’agent (${m[1]}) non può creare la ${ROLE[m[2]] || m[2]} ${m[3]}: ${m[4]} non è scrivibile per lui`],
  [/^(restore destination|tablespace destination) (.+) exists but the agent's user \((.+)\) cannot write into it$/, m => `la ${ROLE[m[1]] || m[1]} ${m[2]} esiste ma l’utente dell’agent (${m[3]}) non può scriverci`],
  [/^not enough space on the volume of (.+?) \((.+)\): (.+) free, about (.+) needed$/, m => `spazio insufficiente sul volume di ${m[1]} (${roles(m[2])}): ${m[3]} liberi, ne servono circa ${m[4]}`],
  [/^the volume of (.+?) \((.+)\) would be left with (.+) free \((.+)%\)(: a full data volume stops PostgreSQL)?$/, m => `sul volume di ${m[1]} (${roles(m[2])}) resterebbero ${m[3]} liberi (${m[4]}%)${m[5] ? ': un volume dati pieno ferma PostgreSQL' : ''}`],
  [/^after the restore the live cluster's volume \((.+)\) would have (.+) free \((.+)%\)$/, m => `dopo il ripristino il volume del cluster in uso (${m[1]}) avrebbe ${m[2]} liberi (${m[3]}%)`],
  [/^(.+): (.+) free, about (.+) needed$/, m => `${m[1]}: ${m[2]} liberi, ne servono circa ${m[3]}`],
  [/^(\d+) of the (\d+) backup chunks this restore needs are missing from the repository \(e\.g\. (.+)\)$/, m => `mancano nel repository ${m[1]} dei ${m[2]} blocchi di backup necessari (es. ${m[3]})`],
  [/^all (\d+) backup chunks needed are present in the repository( \(random sample\))?$/, m => `tutti i ${m[1]} blocchi di backup necessari sono nel repository${m[2] ? ' (verifica a campione)' : ''}`],
  [/^could not check the recovery environment: (.+)$/, m => `impossibile verificare l’ambiente di recupero: ${m[1]}`],
  [/^the destination is another cluster: its free disk space cannot be checked from here$/, () => 'la destinazione è un altro cluster: da qui non si può controllare il suo spazio libero'],
  [/^destination database '(.+)' already exists$/, m => `il database di destinazione '${m[1]}' esiste già`],
  [/^the agent runs as root: PostgreSQL refuses to start as root$/, () => 'l’agent gira come root: PostgreSQL rifiuta di partire come root'],
  [/^runs as an unprivileged user \(uid (\d+)\)$/, m => `gira con un utente non privilegiato (uid ${m[1]})`],
  [/^PostgreSQL (\d+) binaries found in (.+) \((.+)\)$/, m => `binari di PostgreSQL ${m[1]} trovati in ${m[2]} (${SRC[m[3]] || m[3]})`],
  [/^PostgreSQL (\d+) found in (.+) but tools are missing: (.+)$/, m => `PostgreSQL ${m[1]} trovato in ${m[2]} ma mancano: ${m[3]}`],
  [/^no PostgreSQL (\d+) binaries on this host(?: \(found: (.+)\))?$/, m => `nessun binario di PostgreSQL ${m[1]} su questo host${m[2] ? ` (presenti: ${m[2]})` : ''}`],
  [/^the PostgreSQL major version of the backups is not known yet \(no backup in the repository\?\)$/, () => 'la versione di PostgreSQL dei backup non è ancora nota (nessun backup nel repository?)'],
  [/^scratch directory (.+) is not writable$/, m => `la cartella temporanea ${m[1]} non è scrivibile`],
  [/^scratch (.+) has (.+) free but about (.+) are needed$/, m => `la cartella temporanea ${m[1]} ha ${m[2]} liberi ma ne servono circa ${m[3]}`],
  [/^scratch (.+): (.+) free(?: \(needs about (.+)\))?$/, m => `cartella temporanea ${m[1]}: ${m[2]} liberi${m[3] ? ` (ne servono circa ${m[3]})` : ''}`],
  [/^scratch is on the same filesystem as (.+): extraction and recovery compete for its I\/O$/, m => `la cartella temporanea è sullo stesso filesystem di ${m[1]}: estrazione e recupero si contendono il disco`],
  [/^(.+) of memory available, an ephemeral instance with shared_buffers=(\d+) MB wants about (.+)$/, m => `${m[1]} di memoria disponibile, un’istanza di recupero con shared_buffers=${m[2]} MB ne vuole circa ${m[3]}`],
  [/^(.+) of memory available \(ephemeral instance: about (.+)\)$/, m => `${m[1]} di memoria disponibile (istanza di recupero: circa ${m[2]})`],
  [/^a free port is available \((.+)\)$/, m => `c’è una porta libera (${m[1] === 'any, listening on 127.0.0.1 only' ? 'qualsiasi, solo su 127.0.0.1' : m[1]})`],
  [/^(.+) readable: (.+)$/, m => `${m[1] === 'repository' ? 'repository' : m[1] === 'WAL archive' ? 'archivio WAL' : m[1]} leggibile: ${m[2]}`],
  [/^(.+) (\S+) is not readable from this host$/, m => `${m[1] === 'WAL archive' ? 'archivio WAL' : m[1]} ${m[2]} non è leggibile da questo host`],
];
const FIX: Rule[] = [
  [/^set the delivery address in the recovery instance settings \(e\.g\. the HAProxy \/ VIP of the leader\), or open network and pg_hba from this host$/, () => 'indica l’indirizzo di consegna nelle impostazioni dell’istanza di recupero (es. l’HAProxy o il VIP del leader), oppure apri rete e pg_hba da questo host'],
  [/^create it for the agent: (.+) \(or choose a destination under a directory it owns\)$/, m => `creala per l’agent: ${m[1]} (oppure scegli una destinazione in una cartella sua)`],
  [/^free space there, move the scratch directory to another volume \(recovery instance settings\), or restore fewer objects$/, () => 'libera spazio lì, sposta la cartella temporanea su un altro volume (impostazioni dell’istanza di recupero) o ripristina meno oggetti'],
  [/^free space first, or put the scratch directory on another volume$/, () => 'libera prima spazio, o metti la cartella temporanea su un altro volume'],
  [/^keep at least 10% free on the data volume$/, () => 'tieni almeno il 10% libero sul volume dei dati'],
  [/^choose another name; existing databases are never overwritten$/, () => 'scegli un altro nome: i database esistenti non vengono mai sovrascritti'],
  [/^run the agent as the postgres OS user$/, () => 'fai girare l’agent con l’utente di sistema postgres'],
  [/^install the server and client packages for PostgreSQL (\d+)$/, m => `installa i pacchetti server e client di PostgreSQL ${m[1]}`],
  [/^set a writable scratch directory \(not a system directory\)$/, () => 'imposta una cartella temporanea scrivibile (non di sistema)'],
  [/^free space, or point the scratch directory to a bigger volume$/, () => 'libera spazio, o punta la cartella temporanea a un volume più grande'],
  [/^lower shared_buffers_mb or free memory$/, () => 'abbassa shared_buffers_mb o libera memoria'],
  [/^make sure it has about (.+) free$/, m => `assicurati che abbia circa ${m[1]} liberi`],
];
const apply = (rules: Rule[], s: string) => { for (const [re, f] of rules) { const m = s.match(re); if (m) return f(m); } return s; };
/** Italian text of an agent check message (unchanged when unknown). */
export const itCheck = (s?: string | null) => (s ? apply(RULES, String(s)) : s || '');
/** Italian text of an agent "how to fix" hint (unchanged when unknown). */
export const itFix = (s?: string | null) => (s ? apply(FIX, String(s)) : s || '');
