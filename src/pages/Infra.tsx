import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Confirm, Field, Icon, Modal, Skeleton, Tabs, bytes, ago } from '../ui';
import { Op, isTerminal, revalidate, toast, useOpRunner, useQuery } from '../hooks';
import { OpPanel } from './shared';
import { go } from '../router';

/* ====================================================================================================================================================
 * Where recoveries run (ephemeral instance) and where backups are written (destination): both decided per level
 *   cluster > folder > environment > global, field by field. Same screen, same behaviour; only the form and the checks differ.
 * ==================================================================================================================================================== */
type Scope = 'global' | 'env' | 'folder' | 'cluster';
interface SCluster { id: string; name: string; environment: string; folder: string; source: string; effective: { value: Record<string, any>; sources: Record<string, { scope: string; key: string }> } }
interface SNode { id: string; name: string; clusterId: string | null; online: boolean; pg: boolean }
interface SView { kind: string; defaults: Record<string, any>; assignments: Record<string, Record<string, any>>; folders: string[]; clusters: SCluster[]; nodes: SNode[] }
const ENVS = ['prod', 'prep', 'int', 'dev', 'test'];
const ENV_LABEL: Record<string, string> = { prod: 'Produzione', prep: 'Pre-produzione', int: 'Integrazione', dev: 'Sviluppo', test: 'Test' };
const scopeKey = (s: Scope, k: string) => (s === 'global' ? 'global' : `${s}:${k}`);
const srcText = (s?: { scope: string; key: string }) => !s || s.scope === 'default' ? 'predefinito' : s.scope === 'cluster' ? 'questo cluster' : s.scope === 'folder' ? `cartella ${s.key.replace(/^folder:/, '')}` : s.scope === 'env' ? `ambiente ${s.key.replace(/^env:/, '')}` : 'globale';

interface FormProps { value: Record<string, any>; set: (k: string, v: any) => void; view: SView }
interface KindUI { title: string; intro: string; Form: React.FC<FormProps>; summary: (v: Record<string, any>) => React.ReactNode; fields: string[]; labels: Record<string, string> }

/* ---------------------------------------------------------------------------------------------------------------------- ephemeral instance */
const EPH_LABELS: Record<string, string> = { placement: 'Dove gira', centralNode: 'Nodo centrale', scratchDir: 'Cartella temporanea', binDir: 'Binari PostgreSQL', portMin: 'Porte', sharedBuffersMb: 'Memoria (shared_buffers)', keepOnFailure: 'Conserva se fallisce', installDir: 'Cartella installazioni', installMode: 'Installazione' };
const ephSummary = (v: Record<string, any>) => <>
  {v.placement === 'central' ? <Badge kind="accent">Nodo centrale</Badge> : <Badge>Sul nodo del cluster</Badge>}{' '}
  <span className="small muted">{[v.scratchDir ? `scratch ${v.scratchDir}` : null, v.binDir ? `binari ${v.binDir}` : 'binari automatici per versione', v.portMin ? `porte ${v.portMin}-${v.portMax}` : null, `${v.sharedBuffersMb} MB`].filter(Boolean).join(' · ')}</span></>;

const EphForm: React.FC<FormProps> = ({ value: v, set, view }) => {
  const inp = (k: string, ph: string, mono = true) => <input className={`input ${mono ? 'mono' : ''}`} placeholder={ph} value={v[k] ?? ''} onChange={e => set(k, e.target.value)} />;
  const num = (k: string, ph: string) => <input className="input" type="number" placeholder={ph} value={v[k] ?? ''} onChange={e => set(k, e.target.value === '' ? '' : Number(e.target.value))} />;
  const central = v.placement === 'central';
  return <div className="stack">
    <Field label="Dove gira l’istanza di recupero" hint="Per estrarre una tabella o un database serve una istanza PostgreSQL temporanea. Lasciando «come il livello superiore» si eredita.">
      <div className="seg"><button aria-pressed={!v.placement} onClick={() => set('placement', '')}>Come il livello superiore</button><button aria-pressed={v.placement === 'node'} onClick={() => set('placement', 'node')}>Sul nodo del cluster</button><button aria-pressed={central} onClick={() => set('placement', 'central')}>Su un nodo centrale</button></div></Field>
    {v.placement === 'node' ? <p className="small muted">Stessa macchina del database: usa i suoi dischi e la sua CPU durante il ripristino. Nessuna rete di mezzo.</p> : null}
    {central ? <div className="opt-body stack">
      <Field label="Nodo centrale" hint="Un nodo con agent, dedicato ai ripristini. Deve leggere il repository e l’archivio WAL del cluster (condivisione di rete montata agli stessi percorsi) e raggiungere il primario del cluster.">
        <select className="input" value={v.centralNode ?? ''} onChange={e => set('centralNode', e.target.value)}><option value="">Scegli…</option>{view.nodes.map(n => <option key={n.id} value={n.id}>{n.name}{n.online ? '' : ' (offline)'}</option>)}</select></Field>
      <div className="grid g3"><Field label="Consegna: host del primario" hint="Vuoto = quello rilevato"><input className="input" value={v.centralInto?.host ?? ''} onChange={e => set('centralInto', { ...(v.centralInto || {}), host: e.target.value })} /></Field>
        <Field label="Porta"><input className="input" type="number" value={v.centralInto?.port ?? ''} onChange={e => set('centralInto', { ...(v.centralInto || {}), port: e.target.value ? Number(e.target.value) : '' })} /></Field>
        <Field label="Utente"><input className="input" value={v.centralInto?.user ?? ''} onChange={e => set('centralInto', { ...(v.centralInto || {}), user: e.target.value })} /></Field></div>
      <p className="small muted">Le tabelle recuperate vengono consegnate al primario del cluster: serve una regola pg_hba per il nodo centrale e una password in <code>.pgpass</code> dell’utente dell’agent. Il controllo qui sotto («Verifica») prova la connessione davvero.</p></div> : null}
    <div className="grid g2">
      <Field label="Cartella temporanea" hint="Dove si estraggono i file durante il recupero. Meglio un disco locale veloce, diverso da quello dei dati."><>{inp('scratchDir', '/var/tmp/pg_arca_scratch')}</></Field>
      <Field label="Cartella dei binari PostgreSQL" hint="Vuoto = scelta automatica per la versione del backup (nodo, pacchetti di sistema, installazioni di pg_arca).">{inp('binDir', 'automatica')}</Field>
      <Field label="Porte (da)" hint="Utile con firewall locali. Vuoto = una porta libera qualsiasi, solo su 127.0.0.1.">{num('portMin', 'es. 55000')}</Field>
      <Field label="Porte (a)">{num('portMax', 'es. 55100')}</Field>
      <Field label="shared_buffers (MB)" hint="Più memoria velocizza il recupero. Predefinito 256.">{num('sharedBuffersMb', '256')}</Field>
      <Field label="Se PostgreSQL manca">
        <select className="input" value={v.installMode ?? ''} onChange={e => set('installMode', e.target.value)}><option value="">Come il livello superiore</option><option value="private">Installazione privata (senza root)</option><option value="system">Pacchetti di sistema (serve root o sudo)</option></select></Field>
      <Field label="Cartella delle installazioni private" hint="Predefinita /var/lib/pgarca/pg.">{inp('installDir', '/var/lib/pgarca/pg')}</Field>
      <Field label="Conserva l’istanza se il recupero fallisce" hint="Per capire cosa è andato storto: va poi cancellata a mano.">
        <select className="input" value={v.keepOnFailure === undefined || v.keepOnFailure === '' ? '' : v.keepOnFailure ? '1' : '0'} onChange={e => set('keepOnFailure', e.target.value === '' ? '' : e.target.value === '1')}><option value="">Come il livello superiore</option><option value="0">No</option><option value="1">Sì</option></select></Field></div></div>;
};

/* ---------------------------------------------------------------------------------------------------------------------- destination */
const DEST_LABELS: Record<string, string> = { type: 'Tipo', repoPath: 'Repository', walPath: 'Archivio WAL', requireMount: 'Mount obbligatorio', minFreeGb: 'Spazio minimo' };
const TYPE_LABEL: Record<string, string> = { local: 'Cartella locale', nfs: 'Condivisione NFS', smb: 'Condivisione SMB/CIFS' };
const destSummary = (v: Record<string, any>) => <>
  <Badge kind={v.type === 'local' ? undefined : 'accent'}>{TYPE_LABEL[v.type] || v.type}</Badge>{' '}
  <span className="small muted mono">{[v.repoPath ? `repo ${v.repoPath}` : null, v.walPath ? `wal ${v.walPath}` : null].filter(Boolean).join('  ') || 'percorsi non impostati'}{v.requireMount ? ' · mount obbligatorio' : ''}</span></>;
const PREVIEW = [{ id: 's3', label: 'Amazon S3 / MinIO / Ceph RGW' }, { id: 'azure', label: 'Azure Blob Storage' }, { id: 'gcs', label: 'Google Cloud Storage' }, { id: 'sftp', label: 'SFTP' }];

const DestForm: React.FC<FormProps> = ({ value: v, set }) => <div className="stack">
  <Field label="Dove vengono scritti i backup" hint="Il motore scrive su percorsi di file: una cartella locale oppure una condivisione di rete (NFS, SMB) già montata sui nodi. pg_arca non monta nulla: controlla che il mount ci sia davvero.">
    <select className="input" value={v.type ?? ''} onChange={e => set('type', e.target.value)}>
      <option value="">Come il livello superiore</option><option value="local">Cartella locale del nodo</option><option value="nfs">Condivisione di rete NFS (montata)</option><option value="smb">Condivisione di rete SMB/CIFS (montata)</option>
      <optgroup label="In anteprima — non ancora disponibili">{PREVIEW.map(p => <option key={p.id} value={p.id} disabled>{p.label} (Anteprima)</option>)}</optgroup></select></Field>
  <div className="grid g2">
    <Field label="Cartella del repository" hint="Segnaposto: {cluster} {env} {id}. Più cluster possono condividere lo stesso repository (hanno ciascuno il proprio spazio)."><input className="input mono" placeholder="/mnt/backup/pgarca" value={v.repoPath ?? ''} onChange={e => set('repoPath', e.target.value)} /></Field>
    <Field label="Cartella dell’archivio WAL" hint="Deve essere diversa per ogni cluster: usa {cluster} o {id}."><input className="input mono" placeholder="/mnt/backup/wal/{env}/{cluster}" value={v.walPath ?? ''} onChange={e => set('walPath', e.target.value)} /></Field>
    <Field label="Spazio libero minimo (GiB)" hint="Il controllo fallisce sotto questa soglia."><input className="input" type="number" min={0} value={v.minFreeGb ?? ''} onChange={e => set('minFreeGb', e.target.value === '' ? '' : Number(e.target.value))} /></Field>
    <Field label="Mount obbligatorio" hint="Rifiuta il percorso se è sul disco di sistema: evita che i backup riempiano il disco locale quando la condivisione non è montata.">
      <select className="input" value={v.requireMount === undefined || v.requireMount === '' ? '' : v.requireMount ? '1' : '0'} onChange={e => set('requireMount', e.target.value === '' ? '' : e.target.value === '1')}><option value="">Come il livello superiore</option><option value="1">Sì</option><option value="0">No</option></select></Field></div>
  <Banner kind="info" title="Cosa succede quando cambi destinazione">I backup già fatti restano dove sono: non vengono spostati. La nuova destinazione parte con un nuovo backup completo; i ripristini vecchi continuano a leggere dal vecchio percorso finché lo tieni.</Banner></div>;

const KINDS: Record<'ephemeral' | 'destination', KindUI> = {
  ephemeral: { title: 'Istanza di recupero', intro: 'Per ripristinare un database, uno schema o una tabella senza toccare il cluster in esercizio, pg_arca avvia una istanza PostgreSQL temporanea su file estratti dal backup. Qui decidi dove gira e con quali risorse: per tutti i cluster, per ambiente, per cartella o per singolo cluster.', Form: EphForm, summary: ephSummary, fields: Object.keys(EPH_LABELS), labels: EPH_LABELS },
  destination: { title: 'Destinazione dei backup', intro: 'Dove finiscono repository e archivio WAL. Una volta per tutti i cluster, per ambiente, per cartella o per singolo cluster; i segnaposto {cluster} {env} {id} danno a ciascuno la propria cartella. Prima di applicare ogni nodo verifica che la destinazione funzioni davvero.', Form: DestForm, summary: destSummary, fields: Object.keys(DEST_LABELS), labels: DEST_LABELS },
};

/** Edit what ONE level sets. Empty fields are not stored: they keep inheriting. */
function ScopeDialog({ kind, scope, k, label, view, onClose }: { kind: 'ephemeral' | 'destination'; scope: Scope; k: string; label: string; view: SView; onClose: () => void }) {
  const ui = KINDS[kind]; const cur = view.assignments[scopeKey(scope, k)];
  const [v, setV] = useState<Record<string, any>>(() => ({ ...(cur || {}) }));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const set = (key: string, val: any) => setV(x => { const n = { ...x }; if (val === '' || val === undefined) delete n[key]; else n[key] = val; if (key === 'centralInto' && val && !Object.values(val).some(Boolean)) delete n[key]; return n; });
  const save = async (inherit: boolean) => {
    setBusy(true); setErr(null);
    try { await api('PUT', `/api/scoped/${kind}/assignments`, { scope, key: k, ...(inherit ? { inherit: true } : { value: v }) }); revalidate(`/api/scoped/${kind}`); toast(inherit ? 'Torna a ereditare' : 'Impostazioni salvate', 'ok'); onClose(); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Modal wide title={`${ui.title} — ${label}`} onClose={onClose} footer={<>{cur ? <Button kind="ghost" onClick={() => save(true)} disabled={busy}>Rimuovi: eredita</Button> : null}<div className="grow" /><Button onClick={onClose}>Annulla</Button><Button kind="primary" busy={busy} disabled={!Object.keys(v).length} onClick={() => save(false)}>Salva</Button></>}>
    <div className="stack"><ui.Form value={v} set={set} view={view} />{err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

/* ---------------------------------------------------------------------------------------------------------------------- ephemeral: preflight + install */
const LEVEL_KIND: Record<string, 'ok' | 'warn' | 'bad'> = { ok: 'ok', warn: 'warn', bad: 'bad' };
function CheckList({ checks }: { checks: any[] }) {
  return <div className="stack">{checks.map((c, i) => <div key={i} className="row gap-s" style={{ alignItems: 'flex-start' }}><Badge kind={LEVEL_KIND[c.level]}>{c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'attenzione' : 'problema'}</Badge>
    <div className="grow"><div>{c.text}</div>{c.fix ? <div className="small muted">→ {c.fix}</div> : null}</div></div>)}</div>;
}

function PreflightModal({ cluster, onClose }: { cluster: SCluster; onClose: () => void }) {
  const pre = useOpRunner(cluster.id); const ins = useOpRunner(cluster.id, () => pre.run('ephemeral_preflight', {}));
  const [mode, setMode] = useState<'private' | 'system'>('private'); const [ask, setAsk] = useState(false);
  useEffect(() => { pre.run('ephemeral_preflight', {}); }, []);
  const r = pre.op?.status === 'succeeded' ? pre.op.result : null;
  const plan = r?.install_plan; const modes = plan?.modes || {};
  useEffect(() => { if (plan?.recommended) setMode(plan.recommended); }, [plan?.recommended]);
  const m = modes[mode];
  return <Modal wide title={`Verifica del recupero — ${cluster.name}`} onClose={onClose} footer={<><Button icon="refresh" onClick={() => pre.run('ephemeral_preflight', {})} busy={pre.busy}>Ripeti il controllo</Button><div className="grow" /><Button onClick={onClose}>Chiudi</Button></>}>
    <div className="stack">
      {!r ? <OpPanel op={pre.op} error={pre.error} label="Controllo dell’istanza di recupero" /> : <>
        <Banner kind={r.ok ? (r.level === 'warn' ? 'warn' : 'ok') : 'bad'} title={r.ok ? 'Questo nodo può eseguire i recuperi' : 'Il recupero non può partire da questo nodo'}>
          Backup di PostgreSQL {r.major ?? '?'} · {r.host?.os} · {r.host?.cpus} CPU · memoria libera {bytes(r.host?.mem_available)}{r.settings?.placement === 'central' ? ' · nodo centrale' : ''}</Banner>
        <CheckList checks={r.checks} />
        {r.installations?.length ? <details><summary className="small muted" style={{ cursor: 'pointer' }}>Installazioni PostgreSQL trovate ({r.installations.length})</summary>
          <table className="t"><thead><tr><th>Versione</th><th>Cartella</th><th>Origine</th><th>Completa</th></tr></thead><tbody>{r.installations.map((i: any) => <tr key={i.bindir}><td>{i.version}</td><td className="mono small">{i.bindir}</td><td>{({ system: 'pacchetto di sistema', private: 'installata da pg_arca', configured: 'configurata' } as any)[i.source] || i.source}</td><td>{i.complete ? <Badge kind="ok">sì</Badge> : <Badge kind="warn" title={`mancano: ${i.missing_tools.join(', ')}`}>no</Badge>}</td></tr>)}</tbody></table></details> : null}
        {plan ? <Card title={`Installare PostgreSQL ${plan.major}`}><div className="stack">
          {plan.blocked ? <Banner kind="warn" title="Installazione automatica non disponibile">{plan.blocked}</Banner> : <>
            <p className="small muted">Mancano i binari della versione del backup. Una versione diversa non può aprire quei file: pg_arca può installarla, ma solo se glielo chiedi qui e con i permessi indicati.</p>
            {(['private', 'system'] as const).map(k => modes[k] ? <label key={k} className={`opt ${mode === k ? 'on' : ''}`}><input type="radio" checked={mode === k} onChange={() => setMode(k)} />
              <div><div><strong>{k === 'private' ? 'Installazione privata' : 'Pacchetti di sistema'}</strong> {modes[k].possible ? <Badge kind="ok">possibile</Badge> : <Badge kind="bad">non possibile</Badge>}{plan.recommended === k ? <Badge kind="accent">consigliata</Badge> : null}</div>
                <div className="small muted">{k === 'private' ? 'Senza root: scarica i pacchetti e ne estrae i file in una cartella di pg_arca. Niente servizio, niente modifiche al sistema. Serve rete verso il repository dei pacchetti.' : 'Installazione normale dei pacchetti. Serve root o sudo senza password per l’utente dell’agent.'}</div></div></label> : null)}
            {m ? <div className="stack">
              {m.blockers?.length ? <Banner kind="bad" title="Cosa impedisce l’installazione">{m.blockers.map((b: string, i: number) => <div key={i} className="small">{b}</div>)}</Banner> : null}
              <div className="small"><strong>Permessi e requisiti</strong><ul>{m.needs.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>
              <div className="small"><strong>Comandi eseguiti</strong><pre className="out">{m.commands.join('\n')}</pre></div>
              {m.warnings?.length ? <Banner kind="warn" title="Da sapere prima">{m.warnings.map((x: string, i: number) => <div key={i} className="small">{x}</div>)}</Banner> : null}
              <div><Button kind="primary" icon="zap" disabled={!m.possible || ins.busy} busy={ins.busy} onClick={() => setAsk(true)}>Installa PostgreSQL {plan.major}</Button></div></div> : null}</>}
          {ins.op || ins.error ? <OpPanel op={ins.op} error={ins.error} label="Installazione dei binari" /> : null}</div></Card> : null}</>}
    </div>
    {ask ? <Confirm title={`Installare PostgreSQL ${plan?.major}?`} confirmLabel="Installa" requireText="INSTALL" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); ins.run('ephemeral_install', { major: plan.major, mode, confirm: 'INSTALL' }); }}>
      <p>{mode === 'private' ? 'I pacchetti vengono scaricati ed estratti in una cartella di pg_arca, senza root.' : 'I pacchetti vengono installati con il gestore di pacchetti del sistema.'} Su un ambiente protetto serve l’approvazione di un altro amministratore.</p></Confirm> : null}
  </Modal>;
}

/* ---------------------------------------------------------------------------------------------------------------------- destination: check + apply */
function NodeCheck({ opId }: { opId: string }) {
  const q = useQuery<{ operation: Op }>(`/api/operations/${opId}`, { interval: 1500 });
  const op = q.data?.operation;
  if (!op) return <Skeleton h={18} />;
  if (!isTerminal(op.status)) return <div className="small muted">Controllo in corso…</div>;
  if (op.status !== 'succeeded') return <Banner kind="bad" title="Il controllo non è riuscito">{op.error || op.status}</Banner>;
  const r = op.result;
  return <div className="stack">{(r.paths || []).map((p: any) => <div key={p.kind} className="stack"><div className="small"><strong>{p.kind === 'repo' ? 'Repository' : 'Archivio WAL'}</strong> <span className="mono">{p.path}</span>{p.mount ? <span className="muted"> · {p.mount.fstype}</span> : null}{p.free_bytes != null ? <span className="muted"> · liberi {bytes(p.free_bytes)}</span> : null}</div>
    <CheckList checks={p.checks} />{p.bench && !p.bench.error ? <div className="small muted">Misurato: scrittura {p.bench.write_mb_s} MB/s, lettura {p.bench.read_mb_s} MB/s ({p.bench.note})</div> : null}</div>)}</div>;
}

function DestinationModal({ cluster, onClose }: { cluster: SCluster; onClose: () => void }) {
  const url = `/api/clusters/${encodeURIComponent(cluster.id)}/destination`;
  const q = useQuery<any>(url, { interval: 3000 });
  const [busy, setBusy] = useState(''); const [err, setErr] = useState<string | null>(null); const [bench, setBench] = useState(false); const [ops, setOps] = useState<any[]>([]); const [done, setDone] = useState<any>(null);
  const d = q.data;
  const act = async (what: 'check' | 'apply') => {
    setBusy(what); setErr(null);
    try { const r = await api<any>('POST', `${url}/${what}`, what === 'check' ? { bench } : {}, { key: `dst-${what}-${cluster.id}-${Date.now()}` }); if (what === 'check') { setOps(r.operations); setDone(null); } else setDone(r); revalidate(url); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(''); }
  };
  const nodes: any[] = d?.nodes || []; const online = nodes.filter(n => n.online);
  const allOk = !!d?.destination && online.length > 0 && online.every(n => d.checks?.[n.id]?.ok === true && d.checks[n.id].fresh);
  return <Modal wide title={`Destinazione dei backup — ${cluster.name}`} onClose={onClose} footer={<><Button onClick={onClose}>Chiudi</Button></>}>
    {!d ? <Skeleton h={80} /> : !d.destination ? <Banner kind="warn" title="Nessuna destinazione configurata">Imposta un percorso a livello globale, di ambiente, di cartella o di questo cluster.</Banner> : <div className="stack">
      <dl className="kv"><dt>Tipo</dt><dd>{TYPE_LABEL[d.destination.type]}</dd>{d.destination.repo_path ? <><dt>Repository</dt><dd className="mono">{d.destination.repo_path}</dd></> : null}{d.destination.wal_path ? <><dt>Archivio WAL</dt><dd className="mono">{d.destination.wal_path}</dd></> : null}
        <dt>Mount obbligatorio</dt><dd>{d.destination.require_mount ? 'sì' : 'no'}</dd>{d.destination.min_free_gb ? <><dt>Spazio minimo</dt><dd>{d.destination.min_free_gb} GiB</dd></> : null}</dl>
      {d.destination.wal_shared_warning ? <Banner kind="warn" title="Archivio WAL condiviso">{d.destination.wal_shared_warning}</Banner> : null}
      <div className="stack"><strong>Nodi</strong>{nodes.map(n => { const c = d.checks?.[n.id]; const op = ops.find(o => o.nodeId === n.id)?.operation?.id || c?.opId;
        return <Card key={n.id} title={<span className="row gap-s">{n.name}{n.online ? null : <Badge kind="warn">offline</Badge>}{c ? (c.ok === true ? <Badge kind="ok">controllo riuscito {ago(c.at)}</Badge> : c.ok === false ? <Badge kind="bad">controllo non superato</Badge> : <Badge>in corso</Badge>) : <Badge>mai controllato</Badge>}{c && !c.fresh && c.ok ? <Badge kind="warn">scaduto: ripeti</Badge> : null}</span>}>
          {op ? <NodeCheck opId={op} /> : <p className="small muted">Nessun controllo per questa destinazione.</p>}</Card>; })}</div>
      <div className="row wrap gap-s"><Button icon="check" busy={busy === 'check'} disabled={!!busy || !online.length} onClick={() => act('check')}>Controlla su tutti i nodi</Button>
        <label className="check"><input type="checkbox" checked={bench} onChange={e => setBench(e.target.checked)} />Misura anche la velocità di scrittura (scrive 32 MiB)</label></div>
      <div className="hr" />
      <Banner kind="info" title="Applicare la destinazione">Imposta repository e archivio WAL sull’agent di ogni nodo; l’archiviatore usa il nuovo percorso dal prossimo segmento. I backup già fatti non vengono spostati: dopo l’applicazione esegui un backup completo.</Banner>
      <div><Button kind="primary" icon="zap" busy={busy === 'apply'} disabled={!allOk || !!busy} onClick={() => act('apply')}>Applica ai nodi</Button>{!allOk ? <span className="small muted"> Serve un controllo riuscito e recente su ogni nodo.</span> : null}</div>
      {done ? <Banner kind="ok" title="Applicazione avviata">{done.operations.length} operazioni inviate ai nodi (le vedi nel pannello Attività). {done.note}</Banner> : null}
      {err ? <Banner kind="bad">{err}</Banner> : null}</div>}
  </Modal>;
}

/* ---------------------------------------------------------------------------------------------------------------------- page */
function ScopedTab({ kind }: { kind: 'ephemeral' | 'destination' }) {
  const ui = KINDS[kind]; const q = useQuery<SView>(`/api/scoped/${kind}`, { interval: 8000 });
  const [dlg, setDlg] = useState<{ scope: Scope; k: string; label: string } | null>(null); const [pre, setPre] = useState<SCluster | null>(null);
  const v = q.data;
  const eff = (c: SCluster) => c.effective.value;
  const used = useMemo(() => new Set(Object.values(v?.assignments || {}).flatMap(a => Object.keys(a))), [v]);
  if (!v) return <div className="stack"><Skeleton h={40} /><Skeleton h={220} /></div>;
  const line = (scope: Scope, k: string, title: string, sub?: string) => { const a = v.assignments[scopeKey(scope, k)]; return <tr key={scopeKey(scope, k)}>
    <td><strong>{title}</strong>{sub ? <div className="small muted">{sub}</div> : null}</td>
    <td>{a ? <div className="row wrap gap-s">{Object.keys(a).map(f => <Badge key={f} kind="accent" title={JSON.stringify(a[f])}>{ui.labels[f] || f}</Badge>)}</div> : <span className="muted">Eredita</span>}</td>
    <td className="num"><Button sm onClick={() => setDlg({ scope, k, label: title })}>Modifica</Button></td></tr>; };
  return <div className="stack-l">
    <p className="sub" style={{ margin: 0, maxWidth: 820 }}>{ui.intro}</p>
    <Card title="Livelli" pad={false}><div className="tablewrap"><table className="t"><thead><tr><th>Livello</th><th>Cosa imposta</th><th /></tr></thead><tbody>
      {line('global', '', 'Tutti i cluster', 'Valore di riserva')}
      {ENVS.map(e => line('env', e, `Ambiente: ${ENV_LABEL[e]}`, `${v.clusters.filter(c => c.environment === e).length} cluster`))}
      {v.folders.map(f => line('folder', f, `Cartella: ${f}`, `${v.clusters.filter(c => c.folder === f || c.folder.startsWith(f + '/')).length} cluster`))}</tbody></table></div></Card>
    <Card title="Cluster" pad={false}>{!v.clusters.length ? <div style={{ padding: 16 }} className="muted">Nessun cluster collegato.</div> : <div className="tablewrap"><table className="t"><thead><tr><th>Cluster</th><th>In vigore</th><th /></tr></thead><tbody>
      {v.clusters.map(c => <tr key={c.id}><td><strong>{c.name}</strong><div className="small muted">{c.environment}{c.folder ? ` · ${c.folder}` : ''}</div></td>
        <td><div>{ui.summary(eff(c))}</div><div className="small muted">{ui.fields.filter(f => c.effective.sources[f] && c.effective.sources[f].scope !== 'default' && eff(c)[f] !== undefined).map(f => `${ui.labels[f]}: ${srcText(c.effective.sources[f])}`).join(' · ') || 'valori predefiniti'}</div></td>
        <td className="num"><div className="row gap-s" style={{ justifyContent: 'flex-end' }}><Button sm onClick={() => setDlg({ scope: 'cluster', k: c.id, label: c.name })}>Modifica</Button>
          <Button sm icon={kind === 'ephemeral' ? 'search' : 'check'} disabled={c.source === 'direct'} title={c.source === 'direct' ? 'Serve l’agent sul cluster' : undefined} onClick={() => setPre(c)}>{kind === 'ephemeral' ? 'Verifica' : 'Controlla e applica'}</Button></div></td></tr>)}</tbody></table></div>}</Card>
    {dlg ? <ScopeDialog kind={kind} scope={dlg.scope} k={dlg.k} label={dlg.label} view={v} onClose={() => setDlg(null)} /> : null}
    {pre ? (kind === 'ephemeral' ? <PreflightModal cluster={pre} onClose={() => setPre(null)} /> : <DestinationModal cluster={pre} onClose={() => setPre(null)} />) : null}
  </div>;
}

export function InfraPage({ tab }: { tab?: string }) {
  const t: 'ephemeral' | 'destination' = tab === 'destination' ? 'destination' : 'ephemeral';
  return <>
    <div className="pagehead"><div className="grow"><h1>Ripristino e archivi</h1><p className="sub">Dove avvengono i recuperi e dove vengono scritti i backup: una volta per tutti, poi eccezioni per ambiente, cartella o cluster.</p></div></div>
    <Tabs value={t} onChange={v => go(`infra/${v}`)} items={[{ id: 'ephemeral', label: 'Istanza di recupero', icon: 'restore' }, { id: 'destination', label: 'Destinazione dei backup', icon: 'server' }]} />
    <div style={{ marginTop: 16 }}><ScopedTab kind={t} key={t} /></div></>;
}
