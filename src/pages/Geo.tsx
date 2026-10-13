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
interface Ready { checks: { id: string; level: 'ok' | 'warn' | 'bad' | 'info'; text: string; fix?: string; site?: string; clusterId?: string; action?: 'archive_fallback' | 'enable_rewind' }[]; status: 'ready' | 'degraded' | 'not_ready'; rpoSec: number | null; rpoTargetSec: number; lastTest: { at: string; seconds: number | null; from: string; to: string } | null }
interface Policy { autoFailover: boolean; confirmSec: number; maxLossMB: number; autoRejoin: boolean }
interface Watch { primaryName?: string; downSince: number | null; witnesses: { console: boolean; standby: boolean; standbyName?: string }; lastSeenSec: number | null; candidate?: string | null; candidateName?: string; actInSec: number | null; snoozedUntil?: number | null; note?: string }
interface Failover { from: string; to: string; fromName: string; toName: string; at: string; lossBytes: number | null; auto: boolean; rejoinedAt?: string; rejoinError?: string }
interface Group { sysid: string; sites: Site[]; primary: string | null; readiness?: Ready; policy?: Policy; watch?: Watch | null; failover?: Failover | null }
interface Job { id: string; type?: string; fromName: string; toName: string; status: string; createdBy: string; createdAt: string; steps: { at: string; text: string }[]; error?: string }
const JOB_IT: Record<string, string> = { switchover: 'Switchover pianificato', failover: 'Disaster recovery (promozione manuale)', failover_auto: 'Disaster recovery automatico', rejoin: 'Riallineamento del vecchio primario' };
const JOB_ST: Record<string, [string, 'ok' | 'bad' | 'warn' | 'accent']> = { running: ['in corso', 'accent'], succeeded: ['completato', 'ok'], failed: ['interrotto', 'bad'], held: ['in attesa di una decisione', 'warn'] };

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
      <div className="row wrap gap-s"><strong>{JOB_IT[j.type || 'switchover'] || j.type}: {j.fromName} → {j.toName}</strong><Badge kind={(JOB_ST[j.status] || [j.status, 'accent'])[1]}>{(JOB_ST[j.status] || [j.status])[0]}</Badge><div className="grow" /><span className="small faint">{j.createdBy}, {ago(j.createdAt)}</span></div>
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
  const extra = g.sites.filter(s => s.role === 'primary' && s !== prim);            // split-brain: more than one writable site
  const [dlg, setDlg] = useState<{ kind: 'switch' | 'promote' | 'endpoint' | 'demote'; site: Site; next?: 'switch' } | null>(null);
  return <Card title={<span className="row gap-s"><Icon n="swap" s={16} />{prim?.name || '?'}{stand.map(s => <span key={s.clusterId} className="faint"> ⇄ {s.name}</span>)}<span className="small faint mono">· database {g.sysid}</span>{(g as any).stanza ? <span className="small faint" title="I backup di tutti i siti finiscono nello stesso catalogo: un ripristino vede tutta la storia, da qualunque sito sia stato fatto il backup">· catalogo backup comune <span className="mono">{(g as any).stanza}</span></span> : null}</span>}>
    {extra.length && prim ? <Banner kind="bad" title="Due siti accettano scritture (split-brain)">{[prim, ...extra].map(x => x.name).join(' e ')} sono entrambi primari: i dati stanno divergendo. Scegli quale tenere e declassa l’altro a sito di replica: le scritture fatte su quello declassato dopo la separazione vanno perse. Se i suoi dati sono già divergenti potrebbe non riuscire a seguire l’altro sito: in quel caso ricostruiscine i membri («Ricostruisci» nella scheda Alta affidabilità).
      {role === 'admin' ? <div className="row wrap" style={{ marginTop: 8 }}>{[prim, ...extra].map(x => <Button key={x.clusterId} sm kind="danger" onClick={() => setDlg({ kind: 'demote', site: x })}>Declassa {x.name}</Button>)}</div> : null}</Banner> : null}
    <div className="geogrid">
      {prim ? <SiteCard s={prim} onOpen={() => go(`c/${encodeURIComponent(prim.clusterId)}`)} /> : <div className="geosite bad"><strong>Sito primario non visibile</strong><p className="small muted">Nessun cluster collegato accetta scritture per questo database.</p></div>}
      <div className="geolinks">{stand.map(s => <div key={s.clusterId} className={`geolink ${s.health}`}>
        <div className="arrow"><span /></div>
        <div className="small"><strong>{s.lagBytes == null ? '—' : s.lagBytes === 0 ? 'allineato' : `indietro di ${bytes(s.lagBytes)}`}</strong></div>
        <div className="small faint">{s.receiver?.status === 'streaming' ? 'WAN attiva' : 'WAN interrotta'}{s.slot ? ` · slot ${s.slot.active ? 'attivo' : 'INATTIVO'}${s.slot.retainedBytes != null ? `, trattiene ${bytes(s.slot.retainedBytes)}` : ''}` : ''}</div>
      </div>)}</div>
      <div className="stack">{[...extra, ...stand].map(s => <SiteCard key={s.clusterId} s={s} onOpen={() => go(`c/${encodeURIComponent(s.clusterId)}`)} />)}</div>
    </div>
    <DrPanel g={g} role={role} prim={prim} onPromote={s => setDlg({ kind: 'promote', site: s })} />
    {g.readiness ? <Readiness r={g.readiness} role={role} /> : null}
    {role === 'admin' ? <div className="row wrap" style={{ marginTop: 14 }}>
      {prim && stand.map(s => <Button key={'sw' + s.clusterId} icon="swap" disabled={running || s.health === 'bad'} title={s.health === 'bad' ? 'Il sito di replica non è in salute' : undefined} onClick={() => setDlg(s.endpoint ? { kind: 'switch', site: s } : { kind: 'endpoint', site: s, next: 'switch' })}>Switchover pianificato verso {s.name}</Button>)}
      {stand.map(s => <Button key={'pr' + s.clusterId} kind="danger" icon="alert" disabled={running} onClick={() => setDlg({ kind: 'promote', site: s })}>Promuovi {s.name} (disaster recovery)…</Button>)}
      {g.sites.map(s => <Button key={'ep' + s.clusterId} sm kind="ghost" onClick={() => setDlg({ kind: 'endpoint', site: s })}>Indirizzo di {s.name}</Button>)}
    </div> : null}
    {dlg?.kind === 'endpoint' ? <EndpointDialog s={dlg.site} onClose={() => setDlg(null)} onSaved={dlg.next === 'switch' ? ep => setDlg({ kind: 'switch', site: { ...dlg.site, endpoint: ep } }) : undefined} /> : null}
    {dlg?.kind === 'demote' ? (() => { const keepSite = [prim, ...extra].find(x => x && x.clusterId !== dlg.site.clusterId)!; return <Confirm title={`Declassare ${dlg.site.name}?`} confirmLabel="Declassa" requireText="DECLASSA" danger onClose={() => setDlg(null)}
      onConfirm={async () => { const s = dlg.site; setDlg(null); try { const r = await api<any>('POST', '/api/geo/demote', { clusterId: s.clusterId, to: keepSite.clusterId, confirm: 'DECLASSA' }, { key: uid('geod') }); toast(r.approval ? 'Richiesta inviata: serve l’approvazione di un altro amministratore' : `${s.name} declassato: segue ${keepSite.name}`, 'ok'); revalidate('/api/geo'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } }}>
      <p><strong>{dlg.site.name}</strong> smette di accettare scritture e diventa sito di replica di <strong>{keepSite.name}</strong> (tramite il suo DCS, come <span className="mono">patronictl edit-config</span>). Le scritture fatte su {dlg.site.name} dopo la separazione non saranno più visibili: se servono, prima fai un backup o un dump di {dlg.site.name}.</p></Confirm>; })() : null}
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

function EndpointDialog({ s, onClose, onSaved }: { s: Site; onClose: () => void; onSaved?: (ep: { host: string; port: number }) => void }) {
  const [host, setHost] = useState(s.endpoint?.host || ''); const [port, setPort] = useState(String(s.endpoint?.port || 5000)); const [err, setErr] = useState<string | null>(null);
  const save = async () => { try { await api('PUT', `/api/clusters/${encodeURIComponent(s.clusterId)}/geo-endpoint`, { host, port: Number(port) }); revalidate('/api/geo'); toast('Indirizzo salvato', 'ok'); if (onSaved) onSaved({ host, port: Number(port) }); else onClose(); } catch (e: any) { setErr(e.body?.message || e.message); } };
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

/** "If the primary site is lost now, does the DR site take over cleanly, and how much is lost?": the conditions a geo pair silently depends on. */
const READY_IT = { ready: 'Pronto al disaster recovery', degraded: 'Pronto con riserve', not_ready: 'Non pronto al disaster recovery' };
function Readiness({ r, role }: { r: Ready; role: string }) {
  const [open, setOpen] = useState(r.status !== 'ready'); const [edit, setEdit] = useState(false); const [rpo, setRpo] = useState(String(r.rpoTargetSec)); const [busy, setBusy] = useState(false);
  const issues = r.checks.filter(c => c.level !== 'ok'); const tone = r.status === 'ready' ? 'ok' : r.status === 'degraded' ? 'warn' : 'bad';
  const [fixing, setFixing] = useState<string | null>(null);
  // one-click fixes, through the site's own DCS (agent operations: the command / setting is built by the agent, never sent from here)
  const fix = async (c: Ready['checks'][number]) => {
    setFixing(c.id + c.clusterId);
    try {
      const body = c.action === 'archive_fallback' ? { type: 'geo_archive_fallback', params: { enable: true } } : { type: 'patroni_config_patch', params: { patch: { postgresql: { use_pg_rewind: true } } } };
      const r: any = await api('POST', `/api/clusters/${encodeURIComponent(c.clusterId!)}/operations`, body, { key: uid('geofix') });
      if (r.approval) toast('Richiesta inviata: serve l’approvazione di un altro amministratore.', 'info', 8000);
      else toast(c.action === 'archive_fallback' ? 'Riserva dall’archivio in attivazione nel DCS del sito' : 'pg_rewind in attivazione nel DCS del sito', 'ok');
      setTimeout(() => revalidate('/api/geo'), 8000);
    } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setFixing(null); }
  };
  const save = async () => { setBusy(true); try { await api('PUT', '/api/geo/settings', { rpoSec: Number(rpo) }); revalidate('/api/geo'); toast('Obiettivo RPO salvato', 'ok'); setEdit(false); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setBusy(false); } };
  return <div className={`geoready ${tone}`}>
    <div className="row wrap gap-s">
      <button className="linkbtn row gap-s" onClick={() => setOpen(!open)} aria-expanded={open}><Icon n={open ? 'down' : 'chev'} s={13} /><Dot kind={tone} /><strong>{READY_IT[r.status]}</strong></button>
      <span className="small muted">perdita stimata <strong>{r.rpoSec == null ? 'non misurabile' : r.rpoSec < 1 ? 'nessuna' : `${r.rpoSec} s`}</strong> · obiettivo {r.rpoTargetSec} s
        {r.lastTest ? <> · ultimo switchover {ago(r.lastTest.at)}{r.lastTest.seconds != null ? `, ${r.lastTest.seconds} s` : ''}</> : <> · switchover mai provato</>}</span>
      <div className="grow" />{role === 'admin' ? <Button sm kind="ghost" onClick={() => setEdit(true)}>Obiettivo RPO…</Button> : null}
    </div>
    {open ? <ul className="geochecks">{[...issues, ...r.checks.filter(c => c.level === 'ok')].map((c, i) => <li key={i} className={c.level}>
      <Icon n={c.level === 'ok' ? 'check' : c.level === 'info' ? 'info' : 'alert'} s={13} /><span className="grow">{c.text}{c.fix ? <span className="faint"> — {c.fix}</span> : null}</span>
      {role === 'admin' && c.action && c.clusterId ? <Button sm busy={fixing === c.id + c.clusterId} onClick={() => fix(c)}>{c.action === 'archive_fallback' ? 'Attiva la riserva dall’archivio' : 'Attiva pg_rewind'}</Button> : null}</li>)}</ul> : null}
    {edit ? <Modal title="Obiettivo di perdita dati (RPO)" onClose={() => setEdit(false)} footer={<><div className="grow" /><Button onClick={() => setEdit(false)}>Annulla</Button><Button kind="primary" busy={busy} onClick={save}>Salva</Button></>}>
      <Field label="Secondi di transazioni che è accettabile perdere se il sito primario sparisce" hint="Oltre l’obiettivo la coppia è «con riserve»; oltre dieci volte «non pronta». Vale per tutte le coppie di siti.">
        <input className="input" type="number" min={1} max={86400} value={rpo} onChange={e => setRpo(e.target.value)} /></Field></Modal> : null}
  </div>;
}

/** Disaster recovery of the pair: the policy (automatic failover / rejoin), what the monitor sees right now, and the last failover with what is left to do. */
function DrPanel({ g, role, prim, onPromote }: { g: Group; role: string; prim?: Site; onPromote: (s: Site) => void }) {
  const p = g.policy; const w = g.watch; const f = g.failover; const [edit, setEdit] = useState(false);
  if (!p) return null;
  const cand = w?.candidate ? g.sites.find(s => s.clusterId === w.candidate) : undefined;
  const snoozeIt = async () => { try { await api('POST', `/api/geo/snooze/${encodeURIComponent(g.sysid)}`, { minutes: 30 }); toast('Failover automatico sospeso per 30 minuti per questa coppia', 'ok'); revalidate('/api/geo'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
  const down = w && w.downSince ? Math.round((Date.now() - w.downSince) / 1000) : null;
  return <div className="stack" style={{ marginTop: 12 }}>
    {w && w.downSince ? <Banner kind="bad" title={`Il sito primario ${w.primaryName} non risponde da ${down} s`}
      actions={role === 'admin' && cand ? <><Button sm kind="danger" onClick={() => onPromote(cand)}>Promuovi {cand.name} ora…</Button>{p.autoFailover && !w.snoozedUntil ? <Button sm onClick={snoozeIt}>Falso allarme: aspetta 30 min</Button> : null}</> : null}>
      <div>La console non lo sente {w.lastSeenSec != null ? `da ${w.lastSeenSec} s` : ''} e {w.witnesses.standbyName} non riceve più WAL da lui: due conferme indipendenti.</div>
      <div className="small" style={{ marginTop: 4 }}>{w.snoozedUntil ? `Failover automatico sospeso fino alle ${new Date(w.snoozedUntil).toLocaleTimeString('it-IT')}.` : p.autoFailover ? (w.actInSec ? `Failover automatico verso ${w.candidateName} tra ${w.actInSec} s, se la situazione non cambia.` : `Failover automatico verso ${w.candidateName} in corso o appena deciso.`) : 'Failover automatico spento: la promozione la decidi tu.'}</div></Banner>
      : w?.note && !f ? <div className="small muted"><Icon n="info" s={13} /> {w.note}</div> : null}
    {f && !f.rejoinedAt ? <Banner kind="warn" title={`${f.toName} è il sito primario dal ${new Date(f.at).toLocaleString('it-IT')} (${f.auto ? 'failover automatico' : 'promozione manuale'})`}>
      {f.lossBytes != null ? <div>Dati persi stimati: {f.lossBytes === 0 ? 'nessuno' : `circa ${bytes(f.lossBytes)} di WAL`} rispetto all’ultima posizione nota di {f.fromName}.</div> : null}
      <div>{g.sites.find(s => s.clusterId === f.from)?.online ? `${f.fromName} è tornato: ${p.autoRejoin ? 'pg_arca lo sta riallineando come sito di replica' : 'declassalo a sito di replica (non deve accettare scritture)'}.` : `${f.fromName} è ancora irraggiungibile: ${p.autoRejoin ? `quando torna pg_arca lo trasforma da solo in sito di replica di ${f.toName}` : 'quando torna va declassato a sito di replica'}.`}</div>
      {f.rejoinError ? <div className="small" style={{ color: 'var(--bad)' }}>Ultimo tentativo di riallineamento: {f.rejoinError}</div> : null}</Banner> : null}
    <div className="row wrap gap-s small">
      <Icon n="shield" s={14} /><span><strong>Failover automatico tra siti:</strong> {p.autoFailover ? <>attivo — dopo {p.confirmSec} s di conferma, se la perdita stimata non supera {p.maxLossMB} MB</> : 'spento (la promozione del sito di replica la decide una persona)'}</span>
      <span className="faint">·</span><span><strong>Vecchio primario al ritorno:</strong> {p.autoRejoin ? 'diventa da solo sito di replica del nuovo primario' : 'resta fermo finché non lo declassi tu'}</span>
      <div className="grow" />{role === 'admin' ? <Button sm kind="ghost" onClick={() => setEdit(true)}>Modifica…</Button> : null}</div>
    {edit ? <PolicyDialog g={g} p={p} prim={prim} onClose={() => setEdit(false)} /> : null}
  </div>;
}

function PolicyDialog({ g, p, prim, onClose }: { g: Group; p: Policy; prim?: Site; onClose: () => void }) {
  const [v, setV] = useState<Policy>(p); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const stand = g.sites.filter(s => s.role === 'standby');
  const save = async () => { setBusy(true); setErr(null); try { await api('PUT', `/api/geo/policy/${encodeURIComponent(g.sysid)}`, v); revalidate('/api/geo'); toast('Politica di disaster recovery salvata', 'ok'); onClose(); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  return <Modal title="Disaster recovery tra i siti" onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Annulla</Button><Button kind="primary" busy={busy} onClick={save}>Salva</Button></>}>
    <div className="stack">
      <label className="check"><input type="checkbox" checked={v.autoFailover} onChange={e => setV({ ...v, autoFailover: e.target.checked })} /><span><strong>Failover automatico</strong>: se {prim?.name || 'il sito primario'} si perde, {stand.map(s => s.name).join(' / ') || 'il sito di replica'} viene promosso senza attendere una persona.</span></label>
      <p className="small muted" style={{ marginTop: -6 }}>Scatta solo con due conferme indipendenti per tutto il tempo indicato: la console non sente nessun nodo del sito primario <em>e</em> il sito di replica non riceve più WAL da lui. Una rete interrotta tra i soli siti, o la sola console isolata, non promuovono nulla. Prima della promozione il sito di replica recupera anche dall’archivio WAL condiviso ciò che lo streaming non ha portato.</p>
      <div className="grid g2">
        <Field label="Conferma per (secondi)" hint="Da 10 s a 1 ora. Più è lungo, meno falsi allarmi; più è corto, meno fermo."><input className="input" type="number" min={10} max={3600} value={v.confirmSec} onChange={e => setV({ ...v, confirmSec: Number(e.target.value) })} /></Field>
        <Field label="Perdita massima ammessa (MB di WAL)" hint="Oltre questa stima il failover automatico si ferma e chiede una decisione."><input className="input" type="number" min={0} value={v.maxLossMB} onChange={e => setV({ ...v, maxLossMB: Number(e.target.value) })} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={v.autoRejoin} onChange={e => setV({ ...v, autoRejoin: e.target.checked })} /><span><strong>Riallineamento automatico</strong>: quando il vecchio primario torna, diventa subito sito di replica del nuovo (niente due primari). Quello che aveva scritto dopo il punto di promozione viene scartato e indicato.</span></label>
      <p className="small muted">Le applicazioni devono raggiungere il nuovo primario da sole (DNS, VIP o HAProxy che seguono il leader): pg_arca non cambia la rete.</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}
