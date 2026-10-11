import React, { useState } from 'react';
import { api, uid } from '../api';
import { Badge, Banner, Button, Card, Confirm, Dot, Empty, Field, Icon, Modal, Skeleton, ago, bytes } from '../ui';
import { revalidate, toast, useQuery } from '../hooks';
import { go } from '../router';

/* ====================================================================================================================================================
 * Geo-redundancy: the same database on several sites (Patroni clusters with the same system identifier): one primary site, standby sites replicating
 * over the WAN. Shows the replication between sites and runs the two site-level actions: planned switchover and DR promotion — both through each site's DCS.
 * ==================================================================================================================================================== */
interface Site { clusterId: string; name: string; environment: string; role: 'primary' | 'standby' | 'unknown'; leader: string | null; online: boolean; lsn: string | null; timeline: number | null; endpointSource?: string | null; link?: 'auto' | 'manual';
  endpoint: { host: string; port: number } | null; upstream?: { host: string; port: number; slot?: string } | null; receiver?: { status: string; sender: string; silentSec: number | null } | null;
  lagBytes?: number | null; replayDelaySec?: number | null; slot?: { name: string; active: boolean; retainedBytes: number | null } | null; health: 'ok' | 'warn' | 'bad'; problems: string[] }
interface Group { sysid: string; sites: Site[]; primary: string | null }
interface Job { id: string; fromName: string; toName: string; status: string; createdBy: string; createdAt: string; steps: { at: string; text: string }[]; error?: string }

const ROLE_IT = { primary: 'Sito primario', standby: 'Sito di replica (DR)', unknown: 'Ruolo non determinato' };

export function GeoPage({ role }: { role: string }) {
  const q = useQuery<{ groups: Group[]; jobs: Job[] }>('/api/geo', { interval: 4000 });
  const d = q.data; const [pick, setPick] = useState(false);
  const all: any[] = useQuery<any>('/api/clusters').data?.clusters || [];
  return <>
    <div className="pagehead"><div className="grow"><h1>Georidondanza</h1>
      <p className="sub">Lo stesso database su più siti: un sito primario e siti di replica (cluster Patroni in modalità standby, o standby fisici) che ricevono i WAL attraverso la rete geografica. Le coppie sono riconosciute da sole; puoi anche indicarle tu.</p></div>
      {role === 'admin' ? <Button icon="plus" onClick={() => setPick(true)}>Indica un sito di replica</Button> : null}</div>
    {pick ? <LinkPicker all={all} onClose={() => setPick(false)} /> : null}
    {!d ? <Skeleton h={220} /> : !d.groups.length ? <Empty icon="swap" title="Nessuna coppia di siti">Quando un cluster in modalità <code>standby_cluster</code> (o uno standby fisico registrato come cluster) replica da un altro cluster collegato, la coppia compare qui da sola. Per un cluster senza agent, o per dichiarare la relazione prima di attivare la replica, usa «Indica un sito di replica».</Empty> :
      d.groups.map(g => <GroupCard key={g.sysid} g={g} role={role} running={d.jobs.some(j => j.status === 'running')} />)}
    {d?.jobs?.length ? <Card title="Passaggi tra siti"><div className="stack">{d.jobs.map(j => <div key={j.id} className="geojob">
      <div className="row"><strong>{j.fromName} → {j.toName}</strong><Badge kind={j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'bad' : 'accent'}>{j.status === 'running' ? 'in corso' : j.status === 'succeeded' ? 'completato' : 'interrotto'}</Badge><div className="grow" /><span className="small faint">{j.createdBy}, {ago(j.createdAt)}</span></div>
      <ol className="small">{j.steps.map((s, i) => <li key={i}>{s.text} <span className="faint">({new Date(s.at).toLocaleTimeString('it-IT')})</span></li>)}</ol></div>)}</div></Card> : null}
  </>;
}

function SiteCard({ s, onOpen }: { s: Site; onOpen: () => void }) {
  return <div className={`geosite ${s.role} ${s.health}`}>
    <div className="row"><Dot kind={s.online ? s.health : 'bad'} /><button className="linkbtn" onClick={onOpen}><strong>{s.name}</strong></button><div className="grow" />{s.link === 'manual' ? <Badge title="Relazione indicata da un operatore (Organizza… nell’elenco cluster)">impostato a mano</Badge> : null}<Badge kind={s.role === 'primary' ? 'accent' : undefined}>{ROLE_IT[s.role]}</Badge></div>
    <dl className="kv small">
      <dt>Leader</dt><dd>{s.leader || <span style={{ color: 'var(--bad)' }}>nessuno raggiungibile</span>}{s.timeline ? <span className="faint"> · timeline {s.timeline}</span> : null}</dd>
      <dt>Posizione WAL</dt><dd className="mono">{s.lsn || '—'}</dd>
      {s.role === 'standby' ? <>
        <dt>Riceve da</dt><dd>{s.upstream ? <span className="mono">{s.upstream.host}:{s.upstream.port}</span> : '—'}{s.upstream?.slot ? <span className="faint"> · slot {s.upstream.slot}</span> : null}</dd>
        <dt>Ricevitore</dt><dd>{s.receiver?.status === 'streaming' ? <Badge kind="ok">in streaming</Badge> : <Badge kind="bad">{s.receiver?.status || 'assente'}</Badge>}{s.receiver?.silentSec != null ? <span className="faint"> · ultimo messaggio {Math.round(s.receiver.silentSec)} s fa</span> : null}</dd>
      </> : null}
      <dt>Raggiungibile dagli altri siti come</dt><dd>{s.endpoint ? <><span className="mono">{s.endpoint.host}:{s.endpoint.port}</span>{s.endpointSource === 'detected' ? <span className="faint small" title="Rilevato dall’indirizzo che il sito di replica usa per raggiungerlo: lo switchover di ritorno lo userà"> · rilevato</span> : null}</> : <span className="faint">non indicato</span>}</dd>
    </dl>
    {s.problems.length ? <div className="small" style={{ color: s.health === 'bad' ? 'var(--bad)' : 'var(--warn)' }}>{s.problems.join(' · ')}</div> : null}
  </div>;
}

function GroupCard({ g, role, running }: { g: Group; role: string; running: boolean }) {
  const prim = g.sites.find(s => s.role === 'primary'); const stand = g.sites.filter(s => s.role === 'standby');
  const [dlg, setDlg] = useState<{ kind: 'switch' | 'promote' | 'endpoint'; site: Site } | null>(null);
  return <Card title={<span className="row gap-s"><Icon n="swap" s={16} />{prim?.name || '?'}{stand.map(s => <span key={s.clusterId} className="faint"> ⇄ {s.name}</span>)}<span className="small faint mono">· database {g.sysid}</span></span>}>
    <div className="geogrid">
      {prim ? <SiteCard s={prim} onOpen={() => go(`c/${encodeURIComponent(prim.clusterId)}`)} /> : <div className="geosite bad"><strong>Sito primario non visibile</strong><p className="small muted">Nessun cluster collegato accetta scritture per questo database.</p></div>}
      <div className="geolinks">{stand.map(s => <div key={s.clusterId} className={`geolink ${s.health}`}>
        <div className="arrow"><span /></div>
        <div className="small"><strong>{s.lagBytes == null ? '—' : s.lagBytes === 0 ? 'allineato' : `indietro di ${bytes(s.lagBytes)}`}</strong></div>
        <div className="small faint">{s.receiver?.status === 'streaming' ? 'WAN attiva' : 'WAN interrotta'}{s.slot ? ` · slot ${s.slot.active ? 'attivo' : 'INATTIVO'}${s.slot.retainedBytes != null ? `, trattiene ${bytes(s.slot.retainedBytes)}` : ''}` : ''}</div>
      </div>)}</div>
      <div className="stack">{stand.map(s => <SiteCard key={s.clusterId} s={s} onOpen={() => go(`c/${encodeURIComponent(s.clusterId)}`)} />)}</div>
    </div>
    {role === 'admin' ? <div className="row wrap" style={{ marginTop: 14 }}>
      {prim && stand.map(s => <Button key={'sw' + s.clusterId} icon="swap" disabled={running || s.health === 'bad'} title={s.health === 'bad' ? 'Il sito di replica non è in salute' : undefined} onClick={() => setDlg({ kind: s.endpoint ? 'switch' : 'endpoint', site: s })}>Switchover pianificato verso {s.name}</Button>)}
      {stand.map(s => <Button key={'pr' + s.clusterId} kind="danger" icon="alert" disabled={running} onClick={() => setDlg({ kind: 'promote', site: s })}>Promuovi {s.name} (disaster recovery)…</Button>)}
      {g.sites.map(s => <Button key={'ep' + s.clusterId} sm kind="ghost" onClick={() => setDlg({ kind: 'endpoint', site: s })}>Indirizzo di {s.name}</Button>)}
    </div> : null}
    {dlg?.kind === 'endpoint' ? <EndpointDialog s={dlg.site} onClose={() => setDlg(null)} /> : null}
    {dlg?.kind === 'switch' && prim ? <Confirm title={`Switchover: ${dlg.site.name} diventa il sito primario`} confirmLabel="Avvia lo switchover" requireText="SWITCHOVER" danger onClose={() => setDlg(null)}
      onConfirm={async () => { const s = dlg.site; setDlg(null); try { const r = await api<any>('POST', '/api/geo/switchover', { from: prim.clusterId, to: s.clusterId, confirm: 'SWITCHOVER' }, { key: uid('geo') }); toast(r.approval ? 'Richiesta inviata: serve l’approvazione di un altro amministratore' : 'Switchover avviato', 'ok'); revalidate('/api/geo'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } }}>
      <ol className="small">
        <li><strong>{prim.name}</strong> diventa sito di replica di {dlg.site.name} (<span className="mono">{dlg.site.endpoint?.host}:{dlg.site.endpoint?.port}</span>): da quel momento le scritture su {prim.name} si fermano.</li>
        <li>pg_arca attende che {dlg.site.name} abbia ricevuto e applicato tutto (al massimo 2 minuti; se non succede si ferma e {dlg.site.name} non viene promosso: nessun dato perso).</li>
        <li><strong>{dlg.site.name}</strong> viene promosso tramite il suo DCS; per {prim.name} viene creato lo slot permanente <code>geo_…</code> così non perde WAL.</li>
      </ol>
      <p className="small muted">Le applicazioni devono puntare al nuovo sito primario (DNS, VIP o HAProxy): pg_arca non cambia la rete. Interruzione delle scritture: da qualche secondo a un paio di minuti.</p></Confirm> : null}
    {dlg?.kind === 'promote' ? <PromoteDialog s={dlg.site} primary={prim} onClose={() => setDlg(null)} /> : null}
  </Card>;
}

function EndpointDialog({ s, onClose }: { s: Site; onClose: () => void }) {
  const [host, setHost] = useState(s.endpoint?.host || ''); const [port, setPort] = useState(String(s.endpoint?.port || 5000)); const [err, setErr] = useState<string | null>(null);
  const save = async () => { try { await api('PUT', `/api/clusters/${encodeURIComponent(s.clusterId)}/geo-endpoint`, { host, port: Number(port) }); revalidate('/api/geo'); toast('Indirizzo salvato', 'ok'); onClose(); } catch (e: any) { setErr(e.body?.message || e.message); } };
  return <Modal title={`Come gli altri siti raggiungono ${s.name}`} onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Annulla</Button><Button kind="primary" onClick={save} disabled={!host}>Salva</Button></>}>
    <div className="stack"><p className="small muted">L’indirizzo che porta sempre al leader di {s.name} (HAProxy, VIP o DNS del sito), visto dai nodi dell’altro sito. Serve per farlo diventare la sorgente della replica dopo uno switchover.</p>
      <div className="grid g2"><Field label="Host"><input className="input mono" value={host} onChange={e => setHost(e.target.value)} placeholder="dc2-haproxy" /></Field><Field label="Porta"><input className="input mono" value={port} onChange={e => setPort(e.target.value)} /></Field></div>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

function PromoteDialog({ s, primary, onClose }: { s: Site; primary?: Site; onClose: () => void }) {
  const alive = !!primary?.online; const [lost, setLost] = useState(false); const [typed, setTyped] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const go2 = async () => { setBusy(true); setErr(null); try { const r = await api<any>('POST', '/api/geo/promote', { clusterId: s.clusterId, confirm: 'PROMUOVI', primaryLost: lost }, { key: uid('geop') }); toast(r.approval ? 'Richiesta inviata: serve l’approvazione di un altro amministratore' : `Promozione di ${s.name} avviata`, 'ok'); revalidate('/api/geo'); onClose(); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  return <Modal title={`Promuovere ${s.name} (disaster recovery)`} onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Annulla</Button><Button kind="danger" busy={busy} disabled={typed !== 'PROMUOVI' || (alive && !lost)} onClick={go2}>Promuovi</Button></>}>
    <div className="stack">
      {alive ? <Banner kind="bad" title={`${primary!.name} è ancora attivo`}>Accetta scritture: se promuovi {s.name} ora avrai due siti primari con dati che divergono (split-brain). Se i siti sono entrambi sani usa lo <strong>switchover pianificato</strong>.</Banner>
        : <Banner kind="warn" title="Il sito primario non risponde">{s.lagBytes ? `Al momento dell’ultimo contatto ${s.name} era indietro di ${bytes(s.lagBytes)}: quei dati andranno persi.` : `Ultimo stato: ${s.name} era allineato.`}</Banner>}
      {alive ? <label className="check"><input type="checkbox" checked={lost} onChange={e => setLost(e.target.checked)} /> So che {primary!.name} è perso o isolato e che non tornerà a ricevere scritture (lo spegnerò / isolerò io).</label> : null}
      <p className="small">{s.name} smette di replicare e diventa scrivibile (Patroni lo promuove: <code>standby_cluster</code> rimosso dal suo DCS). Il vecchio sito primario, quando torna, NON deve riprendere a scrivere: va ricostruito come sito di replica.</p>
      <Field label="Per confermare scrivi PROMUOVI"><input className="input" value={typed} onChange={e => setTyped(e.target.value)} /></Field>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

/** Declare a standby site by hand: which cluster replicates from which. */
function LinkPicker({ all, onClose }: { all: any[]; onClose: () => void }) {
  const real = all.filter(c => !c.isSandbox).sort((a, b) => a.name.localeCompare(b.name));
  const [stby, setStby] = useState(''); const [prim, setPrim] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api('PUT', `/api/clusters/${encodeURIComponent(stby)}/geo-link`, { primary: prim }); revalidate('/api/geo'); revalidate('/api/clusters'); toast('Relazione salvata', 'ok'); onClose(); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Modal title="Indica un sito di replica" onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Annulla</Button><Button kind="primary" busy={busy} disabled={!stby || !prim || stby === prim} onClick={save}>Salva</Button></>}>
    <div className="stack">
      <Field label="Sito di replica (standby)"><select className="input" value={stby} onChange={e => setStby(e.target.value)}><option value="">Scegli…</option>{real.map(c => <option key={c.id} value={c.id}>{c.name}{c.geo?.role ? ` · ${c.geo.role === 'standby' ? 'già replica' : 'primario'}` : ''}</option>)}</select></Field>
      <Field label="Replica di (sito primario)"><select className="input" value={prim} onChange={e => setPrim(e.target.value)}><option value="">Scegli…</option>{real.filter(c => c.id !== stby).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <p className="small muted">Serve quando la console non può riconoscerla da sola (cluster senza agent, replica non ancora attiva). Se gli agent vedono database diversi la relazione resta, ma viene segnalata come impossibile. Non modifica nulla su PostgreSQL o Patroni.</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}
