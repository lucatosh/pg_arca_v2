import React, { useEffect, useRef, useState } from 'react';
import { api, get, uid } from '../api';
import { Badge, Banner, Button, Card, CopyBlock, Dot, Empty, Field, Icon, Modal, Skeleton, bytes, num } from '../ui';
import { revalidate, toast } from '../hooks';
import { go } from '../router';
import { statusKind } from '../App';

const ENVS = [['prod', 'Produzione'], ['prep', 'Pre-produzione'], ['int', 'Integrazione'], ['dev', 'Sviluppo'], ['test', 'Test']];
const modeOf = (c: any) => c.isSandbox ? <Badge>Demo</Badge> : c.source === 'direct' ? <Badge>Solo connessione</Badge> : <Badge kind="accent">Agent</Badge>;

export function Clusters({ clusters, loading, demoAvailable }: { clusters: any[]; loading: boolean; demoAvailable: boolean }) {
  const [wiz, setWiz] = useState(false);
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
        <div className="tablewrap"><table className="t">
          <thead><tr><th>Cluster</th><th>Ambiente</th><th>Stato</th><th>Modalità</th><th>PostgreSQL</th><th className="num">Nodi</th><th className="num">Dimensione</th><th className="num">TPS</th></tr></thead>
          <tbody>{clusters.map(c => <tr key={c.id} className="click" onClick={() => go(`c/${encodeURIComponent(c.id)}`)}>
            <td><a href={`#/c/${encodeURIComponent(c.id)}`} onClick={e => e.stopPropagation()}><strong>{c.name}</strong></a></td>
            <td>{ENVS.find(e => e[0] === c.environment)?.[1] || c.environment}</td>
            <td><span className="row gap-s"><Dot kind={statusKind(c.status)} />{c.status === 'healthy' ? 'In salute' : c.status === 'degraded' ? 'Degradato' : c.status}</span></td>
            <td>{modeOf(c)}</td><td>{c.pgVersion || '—'}</td>
            <td className="num">{c.haState?.nodes?.length ?? c.agentNodes?.length ?? 0}</td><td className="num">{bytes(c.totalSizeBytes)}</td><td className="num">{num(c.tps)}</td></tr>)}</tbody>
        </table></div>}
    </Card>
    {real.length === 0 && clusters.length > 0 ? <Banner kind="info" title="Stai guardando il cluster demo">È un esempio: le operazioni non vengono eseguite. Collega un cluster reale e poi elimina la demo dalla sua pagina.</Banner> : null}
    {wiz ? <AttachWizard onClose={() => setWiz(false)} /> : null}
  </>;
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
    <div className="row"><Button onClick={back}>Indietro</Button><Button kind="primary" busy={busy} onClick={create}>Genera comando di installazione</Button></div></div>;
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
