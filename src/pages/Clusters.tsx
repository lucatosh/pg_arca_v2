import React, { useEffect, useRef, useState } from 'react';
import { api, get, uid } from '../api';
import { Badge, Banner, Button, Card, CopyBlock, Dot, Empty, Field, Icon, Modal, Skeleton, bytes, num } from '../ui';
import { revalidate, toast, useQuery } from '../hooks';
import { summarize } from './Strategy';
import { go } from '../router';
import { statusKind } from '../App';
import { buildFleet, toneOf, useFold, FolderNode, replicaText } from '../Fleet';
import { useHealth } from './Today';
import { GeoLinkField, LinkMode, linkModeOf, saveGeoLink } from '../GeoLink';

const ENVS = [['prod', 'Produzione'], ['prep', 'Pre-produzione'], ['int', 'Integrazione'], ['dev', 'Sviluppo'], ['test', 'Test']];
const stratOf = (c: any, pol: any) => {
  if (c.isSandbox || c.source === 'direct') return <span className="muted">—</span>;
  const e = pol?.clusters?.find((x: any) => x.id === c.id)?.effective; if (!pol) return <span className="muted">…</span>;
  return e?.policy ? <Badge kind="ok" title={summarize(e.policy)}>{e.source.templateName || 'Personalizzata'}</Badge> : <a href="#/strategy" onClick={ev => ev.stopPropagation()}><Badge kind="warn">Nessuno</Badge></a>;
};
const modeOf = (c: any) => c.isSandbox ? <Badge>Demo</Badge> : c.source === 'direct' ? <Badge>Solo connessione</Badge> : <Badge kind="accent">Agent</Badge>;

export function Clusters({ clusters, loading, demoAvailable }: { clusters: any[]; loading: boolean; demoAvailable: boolean }) {
  const [wiz, setWiz] = useState(false); const pol = useQuery<any>('/api/policies', { interval: 20000 }).data; const [org, setOrg] = useState<any>(null);
  const real = clusters.filter(c => !c.isSandbox);
  const down = clusters.filter(c => c.status !== 'healthy').length;
  const restoreDemo = async () => { try { await api('POST', '/api/clusters/demo'); revalidate('/api/clusters'); } catch (e: any) { toast(e.message, 'bad'); } };
  return <>
    <div className="pagehead"><div className="grow"><h1>Cluster</h1><p className="sub">Tutti i cluster PostgreSQL gestiti da questa console.</p></div>
      <Button kind="primary" icon="plus" onClick={() => setWiz(true)}>Collega cluster</Button></div>
    {clusters.length ? <div className="grid g4">
      <Card><div className="kpi"><span className="v">{clusters.length}</span><span className="l">Cluster collegati</span></div></Card>
      <Card><div className="kpi"><span className="v">{clusters.length - down}<span className="faint" style={{ fontSize: 14 }}> / {clusters.length}</span></span><span className="l">In salute</span></div></Card>
      <Card><div className="kpi"><span className="v">{clusters.reduce((a, c) => a + (c.haState?.nodes?.length || 0), 0)}</span><span className="l">Nodi</span></div></Card>
      <Card><div className="kpi"><span className="v">{bytes(clusters.reduce((a, c) => a + (c.totalSizeBytes || 0), 0))}</span><span className="l">Dati gestiti</span></div></Card>
    </div> : null}
    <Card pad={false}>
      {loading ? <div className="bd stack"><Skeleton h={18} /><Skeleton h={18} /><Skeleton h={18} /></div> :
        !clusters.length ? <Empty icon="db" title="Nessun cluster collegato" action={<div className="row" style={{ justifyContent: 'center' }}><Button kind="primary" icon="plus" onClick={() => setWiz(true)}>Collega cluster</Button>{demoAvailable ? <Button onClick={restoreDemo}>Ripristina il cluster demo</Button> : null}</div>}>
          Collega un cluster installando l’agent su un nodo (backup, ripristino e alta affidabilità completi) oppure con la sola connessione PostgreSQL (monitoraggio, senza backup).</Empty> :
        <FleetTable clusters={clusters} pol={pol} onOrganize={setOrg} />}
    </Card>
    {real.length === 0 && clusters.length > 0 ? <Banner kind="info" title="Stai guardando il cluster demo">È un esempio: le operazioni non vengono eseguite. Collega un cluster reale e poi elimina la demo dalla sua pagina.</Banner> : null}
    {wiz ? <AttachWizard onClose={() => setWiz(false)} /> : null}
    {org ? <Organize c={org} all={clusters} onClose={() => setOrg(null)} /> : null}
  </>;
}

/** Cluster list grouped like the sidebar: environment (state, counts, size) > folders > clusters. */
function FleetTable({ clusters, pol, onOrganize }: { clusters: any[]; pol: any; onOrganize: (c: any) => void }) {
  const h = useHealth(30000).data; const health = Object.fromEntries(((h?.clusters || []) as any[]).map((c: any) => [c.id, c.worst]));
  const groups = buildFleet(clusters, health); const fold = useFold('arca.fleet.table');
  // a standby site holds a copy of its primary: it counts for nodes, not again for data size
  const size = (n: FolderNode): number => n.clusters.reduce((a, c) => a + (c.totalSizeBytes || 0), 0) + n.children.reduce((a, x) => a + size(x), 0);
  const nn = (c: any) => c.haState?.nodes?.length ?? c.agentNodes?.length ?? 0;
  const nodes = (n: FolderNode): number => n.clusters.reduce((a, c) => a + nn(c) + (c.replicas || []).reduce((b: number, r: any) => b + nn(r), 0), 0) + n.children.reduce((a, x) => a + nodes(x), 0);
  const summary = (n: { count: number; bad: number; warn: number }) => <span className="small muted">{n.count} {n.count === 1 ? 'cluster' : 'cluster'}{n.bad ? <> · <span style={{ color: 'var(--bad)', fontWeight: 600 }}>{n.bad} critici</span></> : null}{n.warn ? <> · <span style={{ color: 'var(--warn)', fontWeight: 600 }}>{n.warn} da controllare</span></> : null}{!n.bad && !n.warn ? ' · tutti in salute' : ''}</span>;
  const one = (c: any, depth: number, replica = false, parentEnv?: string) => <tr key={c.id} className={`click${replica ? ' replicarow' : ''}`} onClick={() => go(`c/${encodeURIComponent(c.id)}`)}>
    <td style={{ paddingLeft: 14 + depth * 18 }}><span className="row gap-s">{replica ? <span className="branch" aria-hidden /> : null}<Dot kind={toneOf(c, health)} /><a href={`#/c/${encodeURIComponent(c.id)}`} onClick={e => e.stopPropagation()}><strong>{c.name}</strong></a>
      {replica && parentEnv && c.environment && c.environment !== parentEnv ? <span className="faint small">· {c.environment}</span> : null}
      {replica ? <span className="geotag" title="Sito di replica (standby cluster): riceve i dati dal primario sopra">DR</span> : c.replicas?.length ? <span className="geotag p" title={`Sito primario, replicato su ${c.replicas.map((r: any) => r.name).join(', ')}`}>GEO</span> : null}</span></td>
    <td className={replica ? 'stcell' : undefined} title={replica ? `Replica di ${c.geo.peers?.find((p: any) => p.role === 'primary')?.name}: ${replicaText(c)}` : undefined}><span className="small">{replica ? <>Replica{c.geo.link === 'manual' ? ' (indicata a mano)' : ''} · <span style={{ color: c.geo.health === 'ok' ? undefined : `var(--${c.geo.health})` }}>{replicaText(c)}</span></> : c.status === 'healthy' ? 'In salute' : c.status === 'degraded' ? 'Degradato' : c.status}{health[c.id] === 'critical' || health[c.id] === 'warning' ? <span className="faint"> · {health[c.id] === 'critical' ? 'problemi critici' : 'da controllare'}</span> : null}</span></td>
    <td>{modeOf(c)}</td><td>{stratOf(c, pol)}</td><td>{c.pgVersion || '—'}</td>
    <td className="num">{c.haState?.nodes?.length ?? c.agentNodes?.length ?? 0}</td><td className="num">{bytes(c.totalSizeBytes)}</td><td className="num">{num(c.tps)}</td>
    <td className="num">{c.isSandbox ? null : <button className="btn ghost sm" onClick={e => { e.stopPropagation(); onOrganize(c); }} title="Ambiente, cartella e relazione di replica">Organizza…</button>}</td></tr>;
  const row = (c: any, depth: number) => [one(c, depth), ...(c.replicas || []).map((r: any) => one(r, depth + 1, true, c.environment))];
  const folder = (n: FolderNode, env: string, depth: number): React.ReactNode[] => {
    const k = `${env}:${n.path}`; const open = fold.isOpen(k, true);
    return [<tr key={'f' + k} className="frow" onClick={() => fold.toggle(k, true)}><td colSpan={9} style={{ paddingLeft: 14 + depth * 18 }}>
      <span className="row gap-s"><Icon n={open ? 'down' : 'chev'} s={12} /><Icon n="folder" s={14} /><strong>{n.name}</strong><Dot kind={n.tone} />{summary(n)}<span className="small faint"> · {nodes(n)} {nodes(n) === 1 ? 'nodo' : 'nodi'} · {bytes(size(n))}</span></span></td></tr>,
      ...(open ? [...n.children.flatMap(ch => folder(ch, env, depth + 1)), ...n.clusters.flatMap(c => row(c, depth + 1))] : [])];
  };
  return <div className="tablewrap"><table className="t fleettable">
    <thead><tr><th>Cluster</th><th>Stato</th><th>Modalità</th><th>Backup</th><th>PostgreSQL</th><th className="num">Nodi</th><th className="num">Dimensione</th><th className="num">TPS</th><th /></tr></thead>
    <tbody>{groups.flatMap(g => {
      const k = `env:${g.env}`; const open = fold.isOpen(k, true);
      return [<tr key={k} className={`erow ${g.tone}`} onClick={() => fold.toggle(k, true)}><td colSpan={9}><span className="row gap-s"><Icon n={open ? 'down' : 'chev'} s={13} /><span className={`envmark ${g.env}`} /><strong>{g.label}</strong><Dot kind={g.tone} />{summary(g)}<span className="small faint"> · {nodes(g.root)} {nodes(g.root) === 1 ? 'nodo' : 'nodi'} · {bytes(size(g.root))}</span></span></td></tr>,
        ...(open ? [...g.root.children.flatMap(ch => folder(ch, g.env, 1)), ...g.root.clusters.flatMap(c => row(c, 1))] : [])];
    })}</tbody></table></div>;
}

/** Environment and folder of a cluster ("prod" > "fatturazione/api"): what groups it in the console AND what its folder-level strategies and settings inherit. */
function Organize({ c, all, onClose }: { c: any; all: any[]; onClose: () => void }) {
  const [env, setEnv] = useState(c.environment || 'prod'); const [folder, setFolder] = useState(c.folder || ''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [lm, setLm] = useState<LinkMode>(linkModeOf(c)); const [lp, setLp] = useState<string>(c.geoLink?.primary || '');
  const known = [...new Set(all.filter(x => !x.isSandbox && x.folder).map(x => x.folder as string))].sort();
  const save = async () => { if (lm === 'manual' && !lp) { setErr('Scegli il cluster primario.'); return; } setBusy(true); setErr(null); try { await api('PATCH', `/api/clusters/${encodeURIComponent(c.id)}`, { environment: env, folder }); await saveGeoLink(c, lm, lp); revalidate('/api/clusters'); toast('Salvato', 'ok'); onClose(); } catch (e: any) { setErr(e.body?.message || (e.body?.error === 'invalid_folder' ? 'Nome di cartella non valido.' : e.message)); } finally { setBusy(false); } };
  return <Modal title={`Organizza ${c.name}`} onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Annulla</Button><Button kind="primary" busy={busy} onClick={save}>Salva</Button></>}>
    <div className="stack">
      <Field label="Ambiente"><select className="input" value={env} onChange={e => setEnv(e.target.value)}>{ENVS.map(e => <option key={e[0]} value={e[0]}>{e[1]}</option>)}</select></Field>
      <Field label="Cartella" hint="Per applicazione o servizio, anche su più livelli: «fatturazione» oppure «fatturazione/api». Vuota = direttamente sotto l’ambiente.">
        <input className="input" list="folders-known" value={folder} onChange={e => setFolder(e.target.value)} placeholder="nome_app" /><datalist id="folders-known">{known.map(f => <option key={f} value={f} />)}</datalist></Field>
      <GeoLinkField c={c} all={all} mode={lm} setMode={setLm} primary={lp} setPrimary={setLp} />
      {c.geo?.role === 'standby' ? <Banner kind="info">{c.name} è un sito di replica: nell’elenco e nella barra laterale compare sempre sotto il suo primario ({c.geo.peers?.find((p: any) => p.role === 'primary')?.name || '—'}), ovunque sia archiviato. Ambiente e cartella qui decidono le strategie e le impostazioni che eredita, e la sua posizione se diventa primario.</Banner> : null}
      <p className="small muted">La cartella raggruppa i cluster nella barra laterale e nell’elenco, e le strategie di backup e le impostazioni di recupero assegnate a una cartella valgono per tutti i cluster che contiene.</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

function AttachWizard({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'agent' | 'direct' | null>(null);
  return <Modal title="Collega un cluster" onClose={onClose} wide locked={false}>
    {!mode ? <div className="stack">
      <button className="choice" onClick={() => setMode('agent')}><Icon n="shield" s={22} /><div><strong>Con agent (consigliato)</strong><p className="sub">Installi un piccolo agent su un nodo: backup, ripristino a un istante preciso, alta affidabilità e log in tempo reale. L’agent si collega alla console, non il contrario.</p></div></button>
      <button className="choice" onClick={() => setMode('direct')}><Icon n="link" s={22} /><div><strong>Solo connessione PostgreSQL</strong><p className="sub">Nessuna installazione: la console si collega con un utente di sola lettura. Stato e metriche sì; backup e ripristino no, perché girano sul server del database.</p></div></button>
    </div> : mode === 'agent' ? <AgentFlow onClose={onClose} back={() => setMode(null)} /> : <DirectFlow onClose={onClose} back={() => setMode(null)} />}
  </Modal>;
}

function AgentFlow({ onClose, back }: { onClose: () => void; back: () => void }) {
  const [env, setEnv] = useState('prod'); const [label, setLabel] = useState(''); const [tok, setTok] = useState<any>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [joined, setJoined] = useState<any>(null);
  const before = useRef<Set<string> | null>(null); const keyRef = useRef(uid('tok'));
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const n = await get<{ nodes: any[] }>('/api/nodes'); before.current = new Set(n.nodes.map(x => x.id));
      setTok(await api('POST', '/api/enrollment-tokens', { label: label || 'nodo', environment: env, ttlMinutes: 60 }, { key: keyRef.current }));
    } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!tok || joined) return;
    const t = setInterval(async () => {
      try { const n = await get<{ nodes: any[] }>('/api/nodes'); const fresh = n.nodes.find(x => before.current && !before.current.has(x.id)); if (fresh) { setJoined(fresh); revalidate('/api/clusters'); } } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [tok, joined]);
  if (joined) return <div className="stack"><Banner kind="ok" title={`Nodo ${joined.name} collegato`}>L’agent ha completato l’iscrizione{joined.pgVersion ? ` (PostgreSQL ${joined.pgVersion}, ruolo ${joined.role || 'in rilevamento'})` : ''}. Gli altri nodi dello stesso cluster si aggiungono con lo stesso procedimento: la console li raggruppa da sola.</Banner>
    <div className="row"><Button kind="primary" onClick={() => { onClose(); if (joined.clusterId) go(`c/${encodeURIComponent(joined.clusterId)}`); }}>Apri il cluster</Button><Button onClick={onClose}>Chiudi</Button></div></div>;
  if (!tok) return <div className="stack">
    <Field label="Ambiente"><select className="input" value={env} onChange={e => setEnv(e.target.value)}>{ENVS.map(e => <option key={e[0]} value={e[0]}>{e[1]}</option>)}</select></Field>
    <Field label="Etichetta del nodo" hint="Solo per riconoscere il token nel registro."><input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="es. pg-prod-01" /></Field>
    {err ? <Banner kind="bad">{err}</Banner> : null}
    <div className="row"><Button onClick={back}>Indietro</Button><Button kind="primary" busy={busy} onClick={create}>Genera comando di installazione</Button></div>
    <div className="hr" /><details><summary className="small" style={{ cursor: 'pointer' }}>Preferisci senza token? Il server si annuncia da solo</summary>
      <div className="stack" style={{ marginTop: 8 }}><p className="small muted">Esegui questo comando come root sul server: l’agent si annuncia alla console e qui compare «Nuovo server rilevato». Lo approvi tu, scegliendo l’ambiente.</p>
        <CopyBlock text={`curl -fsSL ${location.origin}/agent/install.sh | sudo PG_ARCA_URL=${location.origin} bash`} /></div></details></div>;
  return <div className="stack">
    <p>Esegui questo comando <strong>come root</strong> sul server del database. Il token vale per un solo nodo e scade tra un’ora.</p>
    <CopyBlock text={tok.installCommand} />
    <Banner kind="info"><span className="row gap-s"><Icon n="refresh" spin />In attesa che l’agent si colleghi…</span></Banner>
    <div className="row"><Button onClick={onClose}>Chiudi</Button><span className="faint small">Puoi chiudere: il nodo comparirà comunque nell’elenco.</span></div></div>;
}

function DirectFlow({ onClose, back }: { onClose: () => void; back: () => void }) {
  const [f, setF] = useState({ name: '', environment: 'prod', host: '', port: '5432', database: 'postgres', user: '', password: '', sslmode: 'require', caCertPem: '', patroniUrl: '' });
  const [test, setTest] = useState<any>(null); const [busy, setBusy] = useState<'t' | 'a' | null>(null); const [err, setErr] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<any>) => { setF({ ...f, [k]: e.target.value }); setTest(null); };
  const body = () => ({ ...f, port: Number(f.port) || 5432, patroniUrl: f.patroniUrl || undefined, caCertPem: f.caCertPem || undefined });
  const doTest = async () => {
    setBusy('t'); setErr(null); setTest(null);
    try { const r = await api('POST', '/api/clusters/test-connection', body()); r.ok ? setTest(r) : setErr(r.message); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(null); }
  };
  const attach = async () => {
    setBusy('a'); setErr(null);
    try { const r = await api('POST', '/api/clusters/attach-direct', body(), { key: uid('att') }); revalidate('/api/clusters'); toast(r.created ? 'Cluster collegato' : 'Cluster già collegato: aggiornato', 'ok'); onClose(); go(`c/${encodeURIComponent(r.cluster.id)}`); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(null); }
  };
  const caps = test?.capabilities;
  return <div className="stack">
    <div className="grid g2"><Field label="Nome del cluster"><input className="input" value={f.name} onChange={set('name')} /></Field>
      <Field label="Ambiente"><select className="input" value={f.environment} onChange={set('environment')}>{ENVS.map(e => <option key={e[0]} value={e[0]}>{e[1]}</option>)}</select></Field>
      <Field label="Host"><input className="input" value={f.host} onChange={set('host')} placeholder="db1.example.com" /></Field>
      <Field label="Porta"><input className="input" value={f.port} onChange={set('port')} inputMode="numeric" /></Field>
      <Field label="Database"><input className="input" value={f.database} onChange={set('database')} /></Field>
      <Field label="Utente" hint="Basta pg_monitor + pg_read_all_settings."><input className="input" value={f.user} onChange={set('user')} autoComplete="off" /></Field>
      <Field label="Password"><input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
      <Field label="Cifratura"><select className="input" value={f.sslmode} onChange={set('sslmode')}><option value="require">TLS (senza verifica certificato)</option><option value="verify-full">TLS con verifica del certificato</option><option value="disable">Nessuna (sconsigliato)</option></select></Field></div>
    {f.sslmode === 'verify-full' ? <Field label="Certificato CA (PEM)"><textarea className="input mono" rows={4} value={f.caCertPem} onChange={set('caCertPem')} /></Field> : null}
    <Field label="URL API Patroni (facoltativo)" hint="Es. http://db1:8008 — per vedere ruoli e membri."><input className="input" value={f.patroniUrl} onChange={set('patroniUrl')} /></Field>
    {err ? <Banner kind="bad" title="Connessione non riuscita">{err}</Banner> : null}
    {test ? <Banner kind="ok" title="Connessione riuscita">{caps ? `Permessi: ${caps.set_parameters ? 'modifica parametri, ' : ''}${caps.patroni_ops ? 'operazioni Patroni, ' : ''}sola lettura per il resto. Backup e ripristino richiedono l’agent.` : ''}</Banner> : null}
    <div className="row"><Button onClick={back}>Indietro</Button><div className="grow" /><Button busy={busy === 't'} disabled={!f.host || !f.user} onClick={doTest}>Verifica connessione</Button>
      <Button kind="primary" busy={busy === 'a'} disabled={!test || !f.name.trim()} onClick={attach}>Collega</Button></div></div>;
}
