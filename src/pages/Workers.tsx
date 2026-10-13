import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Confirm, Empty, Field, Icon, Modal, Skeleton, ago, bytes } from '../ui';
import { revalidate, toast, useOpRunner, useQuery, useDraft, clearDrafts } from '../hooks';
import { go } from '../router';
import { OP_LABEL, OpPanel, statusBadge } from './shared';
import { CheckList } from './Infra';

/* ====================================================================================================================================================
 * Operational machines ("macchine operative"): servers with the pg_arca agent and no database of their own — backup servers, hosts for the recovery
 * instances, machines for restore drills. Here: what each one can do (PostgreSQL versions installed, disks and network shares, CPU/memory), what it is
 * used for (roles, central recovery node of which levels), and the actions that make sense on it.
 * ==================================================================================================================================================== */
interface WRow { id: string; name: string; label: string; roles: string[]; online: boolean; lastSeen?: string; agentVersion?: string; remoteIp?: string; os?: string; cpus?: number;
  memTotal?: number; memAvailable?: number; root: boolean; sudo: boolean; pgMajors: number[]; remoteMounts: number; usedBy: { scope: string; key: string }[]; reported: boolean }
interface WFull extends WRow { installations: any[]; mounts: any[]; dirs: Record<string, any>; host: any; system: any; recent: any[] }

const ROLE_IT: Record<string, { label: string; hint: string }> = {
  recovery: { label: 'Host di recupero', hint: 'esegue le istanze effimere dei ripristini (PITR di database, tabelle, schemi) al posto dei nodi di produzione' },
  repository: { label: 'Backup server', hint: 'ospita repository e archivi WAL, di solito esportati ai nodi via NFS/SMB' },
  drill: { label: 'Prove di ripristino', hint: 'esegue le prove periodiche che i backup si ripristinano davvero' },
};
const usedText = (u: { key: string }) => u.key === 'global' ? 'tutti i cluster' : u.key.startsWith('env:') ? `ambiente ${u.key.slice(4)}` : u.key.startsWith('folder:') ? `cartella ${u.key.slice(7)}` : u.key.startsWith('cluster:') ? 'un cluster' : u.key;

export function WorkersPage({ role }: { role: string }) {
  const q = useQuery<{ workers: WRow[]; candidates: { id: string; name: string; clusterName?: string }[] }>('/api/workers', { interval: 10000 });
  const [add, setAdd] = useState(false); const [conv, setConv] = useState<{ id: string; name: string; clusterName?: string } | null>(null);
  const d = q.data;
  return <>
    <div className="pagehead"><div className="grow"><h1>Macchine operative</h1>
      <p className="sub">Server senza un database proprio che lavorano per i cluster: backup server, host per i ripristini, macchine per le prove. L’agent qui non cerca PostgreSQL da gestire: riporta cosa la macchina sa fare.</p></div>
      {role === 'admin' ? <Button kind="primary" icon="plus" onClick={() => setAdd(true)}>Aggiungi macchina</Button> : null}</div>
    {d?.candidates?.length && role === 'admin' ? <Banner kind="info" title="Server senza database registrati come cluster">
      {d.candidates.map(c => <div key={c.id} className="row small"><span className="grow"><strong>{c.name}</strong>{c.clusterName ? <> — nel cluster «{c.clusterName}», dove non è mai stato trovato PostgreSQL</> : null}</span>
        <Button sm onClick={() => setConv(c)}>Rendi macchina operativa</Button></div>)}</Banner> : null}
    {!d ? <Skeleton h={180} /> : !d.workers.length ? <Empty icon="server" title="Nessuna macchina operativa"
      action={role === 'admin' ? <Button kind="primary" icon="plus" onClick={() => setAdd(true)}>Aggiungi macchina</Button> : undefined}>
      Un backup server o un host dedicato ai ripristini toglie carico e spazio ai nodi di produzione. Installa l’agent con il ruolo «macchina operativa».</Empty> :
      <Card pad={false}><div className="tablewrap"><table className="t"><thead><tr><th>Macchina</th><th>Ruoli</th><th>PostgreSQL installato</th><th>Risorse</th><th>Usata da</th><th>Stato</th></tr></thead><tbody>
        {d.workers.map(w => <tr key={w.id} className="click" onClick={() => go(`w/${encodeURIComponent(w.id)}`)}>
          <td><strong>{w.name}</strong>{w.label ? <div className="small muted">{w.label}</div> : null}</td>
          <td>{w.roles.length ? <div className="row wrap gap-s">{w.roles.map(r => <Badge key={r} kind="accent">{ROLE_IT[r]?.label || r}</Badge>)}</div> : <span className="faint">—</span>}</td>
          <td>{w.pgMajors.length ? w.pgMajors.map(m => <Badge key={m}>{m}</Badge>) : <span className="faint">{w.reported ? 'nessuno' : '…'}</span>}</td>
          <td className="small">{w.cpus ? `${w.cpus} CPU · ` : ''}{w.memTotal ? `${bytes(w.memTotal)} RAM` : ''}{w.remoteMounts ? ` · ${w.remoteMounts} condivisioni di rete` : ''}</td>
          <td className="small">{w.usedBy.length ? `recupero per ${w.usedBy.map(usedText).join(', ')}` : <span className="faint">—</span>}</td>
          <td>{w.online ? <Badge kind="ok">online</Badge> : <Badge kind="bad" title={w.lastSeen ? `ultimo contatto ${ago(w.lastSeen)}` : undefined}>offline</Badge>}</td></tr>)}</tbody></table></div></Card>}
    {add ? <AddWorker onClose={() => setAdd(false)} /> : null}
    {conv ? <Confirm title={`Rendere ${conv.name} una macchina operativa?`} confirmLabel="Rendi macchina operativa" onClose={() => setConv(null)} onConfirm={async () => {
      try { const r = await api<any>('POST', `/api/nodes/${encodeURIComponent(conv.id)}/make-worker`, {}); toast(r.clusterRemoved ? 'Fatto: il cluster vuoto è stato rimosso' : 'Fatto', 'ok'); revalidate('/api/workers'); revalidate('/api/workers-summary'); revalidate('/api/clusters'); }
      catch (e: any) { toast(e.body?.message || e.message, 'bad'); } setConv(null); }}>
      <p>L’agent smette di cercare un database su questo server e riporta cosa sa fare (versioni di PostgreSQL installate, dischi, condivisioni). {conv.clusterName ? <>Il cluster «{conv.clusterName}» viene rimosso se resta vuoto.</> : null}</p></Confirm> : null}
  </>;
}

function AddWorker({ onClose }: { onClose: () => void }) {
  const [label, setLabel] = useState(''); const [r, setR] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const create = async () => { setBusy(true); setErr(null); try { setR(await api<any>('POST', '/api/enrollment-tokens', { label: label || 'macchina operativa', kind: 'worker', ttlMinutes: 120 })); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  return <Modal title="Aggiungi una macchina operativa" onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Chiudi</Button>{!r ? <Button kind="primary" busy={busy} onClick={create}>Crea il comando di installazione</Button> : null}</>}>
    <div className="stack">
      {!r ? <><Field label="A cosa serve" hint="Per esempio: «Backup server DC1», «Host di recupero per la produzione»."><input className="input" value={label} onChange={e => setLabel(e.target.value)} /></Field>
        <p className="small muted">Sulla macchina serve Python 3.6+. Non serve PostgreSQL: per i ripristini pg_arca può installare i binari della versione necessaria in una cartella privata, senza toccare il sistema.</p></> :
        <><p>Esegui sulla macchina, come root (il comando vale una volta, per 2 ore):</p><pre className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{r.installCommand}</pre>
          <Button sm icon="copy" onClick={() => { navigator.clipboard?.writeText(r.installCommand); toast('Copiato', 'ok'); }}>Copia</Button>
          <p className="small muted">L’agent gira con l’utente postgres se esiste, altrimenti con un utente di sistema dedicato «pgarca». La macchina comparirà nella barra laterale entro pochi secondi.</p></>}
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

export function WorkerView({ id, role }: { id: string; role: string }) {
  const q = useQuery<WFull>(`/api/workers/${encodeURIComponent(id)}`, { interval: 8000 });
  const cl = useQuery<{ clusters: any[] }>('/api/clusters');
  const w = q.data;
  const [dlg, setDlg0] = useDraft<'' | 'edit' | 'use' | 'dest' | 'install'>(`worker:${id}:dlg`, '');
  const setDlg = (v: '' | 'edit' | 'use' | 'dest' | 'install') => { if (!v) clearDrafts(`worker:${id}:form`); setDlg0(v); };
  const pre = useOpRunner(`worker:${id}`, () => revalidate(`/api/workers/${encodeURIComponent(id)}`), `worker:${id}:op`);
  const majors = useMemo(() => { const s = new Set<number>(); for (const c of cl.data?.clusters || []) { const m = parseInt(String(c.pgVersion || ''), 10); if (m) s.add(m); } return [...s].sort((a, b) => b - a); }, [cl.data]);
  const [major, setMajor] = useState<number | ''>('');
  const mj = major || majors[0] || w?.pgMajors[0] || 16;
  if (q.error && !w) return <Empty icon="server" title="Macchina non trovata">Forse è stata rimossa. <a href="#/workers">Tutte le macchine operative</a></Empty>;
  if (!w) return <div className="stack"><Skeleton h={40} w={300} /><Skeleton h={200} /></div>;
  const res = pre.op?.status === 'succeeded' ? pre.op.result : null;
  const missingMajors = majors.filter(m => !w.pgMajors.includes(m));
  return <div className="stack-l">
    <div className="pagehead"><div className="grow"><h1>{w.name} {w.online ? <Badge kind="ok">online</Badge> : <Badge kind="bad">offline</Badge>}</h1>
      <p className="sub">{w.label || 'Macchina operativa'} · {w.os || 'sistema non ancora riportato'}{w.remoteIp ? ` · ${w.remoteIp.replace(/^::ffff:/, '')}` : ''}{w.agentVersion ? ` · agent ${w.agentVersion}` : ''}</p></div>
      {role === 'admin' ? <Button onClick={() => setDlg('edit')}>Nome e ruoli</Button> : null}</div>

    {!w.reported ? <Banner kind="info" title="In attesa dell’inventario">L’agent non ha ancora riportato cosa c’è su questa macchina (aggiorna l’agent alla versione che supporta le macchine operative, o attendi il prossimo contatto).</Banner> : null}
    {majors.length && missingMajors.length ? <Banner kind="warn" title={`Mancano i binari di PostgreSQL ${missingMajors.join(', ')}`}>Per ripristinare i backup di quei cluster su questa macchina servono i binari della stessa versione.
      {role === 'admin' ? <> <Button sm onClick={() => { setMajor(missingMajors[0]); setDlg('install'); }}>Installa PostgreSQL {missingMajors[0]}</Button></> : null}</Banner> : null}

    <div className="grid g2">
      <Card title="Cosa sa fare"><div className="stack">
        <dl className="kv small">
          <dt>Ruoli</dt><dd>{w.roles.length ? w.roles.map(r => <div key={r}><strong>{ROLE_IT[r]?.label}</strong> <span className="muted">— {ROLE_IT[r]?.hint}</span></div>) : <span className="faint">nessuno indicato</span>}</dd>
          <dt>PostgreSQL</dt><dd>{w.installations.length ? w.installations.map((i: any) => <div key={i.bindir}><Badge>{i.major}</Badge> <span className="mono">{i.bindir}</span> <span className="faint">{i.source === 'private' ? 'installazione privata di pg_arca' : i.source === 'system' ? 'pacchetti di sistema' : 'configurato'}</span></div>) : <span className="faint">nessuna installazione trovata</span>}</dd>
          <dt>Risorse</dt><dd>{w.cpus ?? '?'} CPU · {bytes(w.memTotal)} di memoria ({bytes(w.memAvailable)} liberi)</dd>
          <dt>Permessi</dt><dd>{w.root ? 'root' : w.sudo ? 'utente con sudo senza password' : 'utente senza privilegi (installazioni solo private)'}</dd>
          <dt>Usata da</dt><dd>{w.usedBy.length ? `nodo di recupero per ${w.usedBy.map(usedText).join(', ')}` : <span className="faint">nessuna configurazione la usa ancora</span>}</dd>
        </dl>
        <div className="row wrap">{role !== 'viewer' ? <Button sm icon="search" busy={pre.busy} onClick={() => pre.run('ephemeral_preflight', { major: mj })}>Verifica come host di recupero (PG {mj})</Button> : null}
          {role === 'admin' ? <Button sm onClick={() => setDlg('use')}>Usala per i ripristini…</Button> : null}
          {role !== 'viewer' ? <Button sm onClick={() => setDlg('dest')}>Controlla una cartella di backup…</Button> : null}</div>
        {majors.length > 1 ? <div className="row small"><span className="muted">Versione da verificare:</span><select className="input" style={{ width: 'auto' }} value={mj} onChange={e => setMajor(Number(e.target.value))}>{majors.map(m => <option key={m} value={m}>PostgreSQL {m}</option>)}</select></div> : null}
        {pre.op && !res ? <OpPanel op={pre.op} error={pre.error} /> : null}
        {res && pre.op?.type === 'ephemeral_preflight' ? <><Banner kind={res.ok ? (res.level === 'warn' ? 'warn' : 'ok') : 'bad'} title={res.ok ? 'Può eseguire i ripristini' : 'Non può ancora eseguire i ripristini'}>PostgreSQL {res.major ?? mj}</Banner><CheckList checks={res.checks || []} /></> : null}
        {res && pre.op?.type === 'destination_check' ? <><Banner kind={res.ok ? 'ok' : 'bad'} title={res.ok ? 'Cartella utilizzabile' : 'Cartella non utilizzabile'} />{res.checks ? <CheckList checks={res.checks} /> : null}</> : null}
      </div></Card>
      <Card title="Dischi e condivisioni"><div className="stack">
        {w.mounts.length ? <table className="t small"><thead><tr><th>Punto di montaggio</th><th>Tipo</th><th className="num">Libero</th></tr></thead><tbody>
          {w.mounts.map((m: any) => { const p = m.total_bytes ? Math.round(100 * m.free_bytes / m.total_bytes) : 0; return <tr key={m.mount}><td className="mono">{m.mount}</td><td>{m.remote ? <Badge kind="accent">{m.fstype}</Badge> : m.fstype}</td>
            <td className="num"><span style={{ color: p < 10 ? 'var(--bad)' : undefined }}>{bytes(m.free_bytes)}</span> <span className="faint">/ {bytes(m.total_bytes)}</span></td></tr>; })}</tbody></table> : <span className="faint small">non ancora riportati</span>}
        <dl className="kv small">{Object.entries(w.dirs || {}).filter(([, v]) => v).map(([k, v]: any) => <React.Fragment key={k}><dt>{k === 'scratch' ? 'Cartella temporanea' : k === 'repo' ? 'Repository' : 'Archivio WAL'}</dt>
          <dd><span className="mono">{v.path}</span> {v.exists ? (v.writable ? <Badge kind="ok">scrivibile</Badge> : <Badge kind="bad">non scrivibile</Badge>) : <Badge>da creare</Badge>} {v.free_bytes != null ? <span className="faint">{bytes(v.free_bytes)} liberi</span> : null}</dd></React.Fragment>)}</dl>
      </div></Card>
    </div>

    <Card title="Ultime operazioni su questa macchina">{w.recent.length ? <table className="t small"><tbody>{w.recent.map((o: any) => <tr key={o.id}><td>{OP_LABEL[o.type] || o.type}</td><td>{statusBadge(o.status)}</td><td className="faint">{o.createdBy}</td><td className="faint">{ago(o.updatedAt)}</td></tr>)}</tbody></table> : <span className="faint small">nessuna</span>}</Card>

    {dlg === 'edit' ? <EditWorker w={w} onClose={() => setDlg('')} /> : null}
    {dlg === 'use' ? <UseForRecovery w={w} clusters={cl.data?.clusters || []} onClose={() => setDlg('')} /> : null}
    {dlg === 'dest' ? <DestCheck onRun={(p) => { pre.run('destination_check', p); setDlg(''); }} onClose={() => setDlg('')} /> : null}
    {dlg === 'install' ? <Confirm title={`Installare PostgreSQL ${mj} su ${w.name}?`} confirmLabel="Installa" requireText="INSTALL" onClose={() => setDlg('')}
      onConfirm={() => { pre.run('ephemeral_install', { major: mj, mode: w.root || w.sudo ? 'system' : 'private', confirm: 'INSTALL' }); setDlg(''); }}>
      <p>{w.root || w.sudo ? 'Con i pacchetti di sistema (la macchina ha i permessi).' : 'In una cartella privata di pg_arca, senza permessi di root.'} Servono solo i binari del server, nessuna istanza viene avviata.</p></Confirm> : null}
  </div>;
}

function EditWorker({ w, onClose }: { w: WFull; onClose: () => void }) {
  const [label, setLabel] = useDraft(`worker:${w.id}:form:label`, w.label); const [roles, setRoles] = useDraft<string[]>(`worker:${w.id}:form:roles`, w.roles); const [err, setErr] = useState<string | null>(null);
  const save = async () => { try { await api('PATCH', `/api/workers/${encodeURIComponent(w.id)}`, { label, roles }); revalidate(`/api/workers/${encodeURIComponent(w.id)}`); revalidate('/api/workers-summary'); revalidate('/api/workers'); onClose(); } catch (e: any) { setErr(e.body?.message || e.message); } };
  return <Modal title={`${w.name}: nome e ruoli`} onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Annulla</Button><Button kind="primary" onClick={save}>Salva</Button></>}>
    <div className="stack"><Field label="Descrizione"><input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="Backup server DC1" /></Field>
      {Object.entries(ROLE_IT).map(([k, v]) => <label key={k} className="check"><input type="checkbox" checked={roles.includes(k)} onChange={e => setRoles(r => e.target.checked ? [...r, k] : r.filter(x => x !== k))} /><span><strong>{v.label}</strong> <span className="small muted">— {v.hint}</span></span></label>)}
      <p className="small muted">I ruoli descrivono la macchina; il suo uso effettivo per i ripristini si decide con «Usala per i ripristini».</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

/** Make this machine the central recovery node for every cluster, an environment or one cluster: writes placement=central + centralNode into that level, keeping its other fields. */
function UseForRecovery({ w, clusters, onClose }: { w: WFull; clusters: any[]; onClose: () => void }) {
  const [scope, setScope] = useDraft(`worker:${w.id}:form:scope`, 'global'); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const envs = [...new Set(clusters.filter(c => !c.isSandbox).map(c => c.environment))];
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const view = await api<any>('GET', '/api/scoped/ephemeral');
      const [s, k] = scope === 'global' ? ['global', ''] : scope.split(/:(.*)/s);
      const cur = view.assignments[scope === 'global' ? 'global' : scope] || {};
      await api('PUT', '/api/scoped/ephemeral/assignments', { scope: s, key: k, value: { ...cur, placement: 'central', centralNode: w.id } });
      revalidate(`/api/workers/${encodeURIComponent(w.id)}`); revalidate('/api/scoped/ephemeral'); toast('Da ora i ripristini di quel livello girano su ' + w.name, 'ok'); onClose();
    } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Modal title={`Usare ${w.name} per i ripristini`} onClose={onClose} footer={<><Button kind="ghost" onClick={() => go('infra/ephemeral')}>Tutte le impostazioni</Button><div className="grow" /><Button onClick={onClose}>Annulla</Button><Button kind="primary" busy={busy} onClick={save}>Usa questa macchina</Button></>}>
    <div className="stack">
      <p>L’istanza effimera dei ripristini (database, tabelle, schemi, prove) girerà su <strong>{w.name}</strong> invece che sui nodi del cluster; il risultato viene consegnato al primario del cluster. La macchina deve vedere il repository dei backup (stesso percorso, per esempio via NFS) e raggiungere il primario sulla porta di PostgreSQL.</p>
      <Field label="Per quali cluster"><select className="input" value={scope} onChange={e => setScope(e.target.value)}>
        <option value="global">Tutti i cluster</option>{envs.map(e => <option key={e} value={`env:${e}`}>Ambiente {e}</option>)}
        {clusters.filter(c => !c.isSandbox && c.source !== 'direct').map(c => <option key={c.id} value={`cluster:${c.id}`}>Cluster {c.name}</option>)}</select></Field>
      {w.pgMajors.length ? null : <Banner kind="warn">Su questa macchina non c’è ancora PostgreSQL: installa i binari della versione dei backup prima del primo ripristino.</Banner>}
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

function DestCheck({ onRun, onClose }: { onRun: (p: any) => void; onClose: () => void }) {
  const [type, setType] = useDraft('workerdest:type', 'local'); const [repo, setRepo] = useDraft('workerdest:repo', ''); const [wal, setWal] = useDraft('workerdest:wal', '');
  const ok = (p: string) => !p || p.startsWith('/');
  return <Modal title="Controlla una cartella di backup da questa macchina" onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Annulla</Button><Button kind="primary" disabled={!repo || !ok(repo) || !ok(wal)} onClick={() => onRun({ type, repo_path: repo, ...(wal ? { wal_path: wal } : {}), require_mount: type !== 'local' })}>Controlla</Button></>}>
    <div className="stack"><p className="small muted">Verifica reale: tipo di filesystem, scrittura esclusiva con fsync e rinomina atomica, spazio libero. Non sposta nulla.</p>
      <Field label="Tipo"><div className="seg">{['local', 'nfs', 'smb'].map(t => <button key={t} aria-pressed={type === t} onClick={() => setType(t)}>{t === 'local' ? 'Disco locale' : t.toUpperCase()}</button>)}</div></Field>
      <Field label="Cartella del repository" error={ok(repo) ? null : 'Percorso assoluto'}><input className="input mono" value={repo} onChange={e => setRepo(e.target.value)} placeholder="/backup/pgarca/repo" /></Field>
      <Field label="Cartella dell’archivio WAL (facoltativa)" error={ok(wal) ? null : 'Percorso assoluto'}><input className="input mono" value={wal} onChange={e => setWal(e.target.value)} placeholder="/backup/pgarca/wal" /></Field></div></Modal>;
}


