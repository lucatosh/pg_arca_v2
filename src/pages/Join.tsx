import React, { useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Field, Modal, ago } from '../ui';
import { revalidate, toast, useQuery } from '../hooks';
import { go } from '../router';

const ENVS: [string, string][] = [['prod', 'Produzione'], ['prep', 'Pre-produzione'], ['int', 'Integrazione'], ['dev', 'Sviluppo'], ['test', 'Test']];

/** Servers that announced themselves (agent installed without a token). Visible to administrators on every page until handled. */
export function JoinBanner() {
  const q = useQuery<{ requests: any[]; enabled: boolean }>('/api/join-requests', { interval: 8000 });
  const [sel, setSel] = useState<any>(null);
  const list = q.data?.requests || [];
  if (!list.length) return null;
  return <>
    <div className="join-banner"><Banner kind="info" icon="zap" title={list.length === 1 ? `Nuovo server rilevato: ${list[0].nodeName}` : `${list.length} nuovi server rilevati`}
      actions={<Button sm kind="primary" onClick={() => setSel(list[0])}>Esamina</Button>}>
      {list.length === 1 ? <>Un agent installato su {list[0].ip || 'un server'} ha chiesto di unirsi alla console {ago(list[0].createdAt)}. Non verrà collegato finché non lo approvi.</> : <>Hanno chiesto di unirsi: {list.map(r => r.nodeName).join(', ')}. Nessuno verrà collegato senza la tua approvazione.</>}</Banner></div>
    {sel ? <Review r={sel} all={list} pick={setSel} onClose={() => setSel(null)} /> : null}
  </>;
}

function Review({ r, all, pick, onClose }: { r: any; all: any[]; pick: (r: any) => void; onClose: () => void }) {
  const [env, setEnv] = useState('prod'); const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const pg = (r.summary?.postgres || [])[0];
  const done = (msg: string) => { toast(msg, 'ok'); revalidate('/api/join-requests'); revalidate('/api/clusters'); onClose(); };
  const approve = async () => { setBusy(true); setErr(null); try { const o: any = await api('POST', `/api/join-requests/${r.id}/approve`, r.matchCluster ? {} : { environment: env, name: name || undefined }); done('Server approvato: comparirà tra pochi secondi'); if (all.length === 1 && o.clusterId) go(`c/${encodeURIComponent(o.clusterId)}`); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  const reject = async () => { setBusy(true); try { await api('POST', `/api/join-requests/${r.id}/reject`); done('Richiesta rifiutata'); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  return <Modal title={`Aggiungere ${r.nodeName}?`} onClose={onClose} footer={<><Button onClick={reject} disabled={busy}>Rifiuta</Button><Button kind="primary" icon="check" busy={busy} disabled={r.nameInUse} onClick={approve}>Approva e collega</Button></>}>
    <div className="stack">
      <dl className="kv"><dt>Nome del server</dt><dd>{r.nodeName}</dd><dt>Indirizzo di provenienza</dt><dd className="mono">{r.ip || '—'}</dd>
        {r.summary?.hostname ? <><dt>Host</dt><dd>{r.summary.hostname}</dd></> : null}
        {pg ? <><dt>PostgreSQL</dt><dd>{pg.version || '?'}{pg.role ? ` · ${pg.role}` : ''}{pg.port ? ` · porta ${pg.port}` : ''}</dd><dt>Cartella dati</dt><dd className="mono small">{pg.data_directory || '—'}</dd></> : <><dt>PostgreSQL</dt><dd className="muted">non rilevato su questo server</dd>{r.summary?.diag && <><dt>Diagnosi</dt><dd className="small muted">{`l’agent gira come uid ${r.summary.diag.uid ?? '?'}; processi visti: ${(r.summary.diag.procs || []).join(', ') || 'nessuno rilevante'}`}{(r.summary.diag.warnings || []).map((w: string, i: number) => <div key={i}>{w}</div>)}</dd></>}</>}
        <dt>Agent</dt><dd>{r.agentVersion || '—'}</dd><dt>Richiesta</dt><dd>{ago(r.createdAt)}</dd></dl>
      {r.nameInUse ? <Banner kind="bad" title="Nome già usato">Esiste già un server con questo nome: rinomina il nuovo (variabile PG_ARCA_NODE_NAME) e rilancia l’installazione.</Banner> : null}
      {r.matchCluster ? <Banner kind="ok" title={`Appartiene a «${r.matchCluster.name}»`}>Ha la stessa identità del database di un cluster già collegato ({r.matchCluster.environment}): verrà aggiunto come nodo.</Banner>
        : <><Banner kind="info" title="Nuovo cluster">Non corrisponde a nessun cluster collegato: ne verrà creato uno.</Banner>
          <div className="grid g2"><Field label="Ambiente"><select className="input" value={env} onChange={e => setEnv(e.target.value)}>{ENVS.map(e => <option key={e[0]} value={e[0]}>{e[1]}</option>)}</select></Field>
            <Field label="Nome del cluster" hint="Facoltativo."><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={r.summary?.patroni_scope || `pg-${r.nodeName}`} /></Field></div></>}
      <p className="small muted">Approvando, l’agent riceve l’accesso e inizia a inviare telemetria. Se non riconosci questo server, rifiuta: nessun dato è stato letto oltre ai dettagli qui sopra.</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}
    </div></Modal>;
}
