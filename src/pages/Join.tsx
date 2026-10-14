import React, { useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Field, Modal, ago } from '../ui';
import { revalidate, toast, useQuery } from '../hooks';
import { go } from '../router';

const ENVS: [string, string][] = [['prod', 'Production'], ['prep', 'Pre-production'], ['int', 'Integration'], ['dev', 'Development'], ['test', 'Test']];

/** Servers that announced themselves (agent installed without a token). Visible to administrators on every page until handled. */
export function JoinBanner() {
  const q = useQuery<{ requests: any[]; enabled: boolean }>('/api/join-requests', { interval: 8000 });
  const [sel, setSel] = useState<any>(null);
  const list = q.data?.requests || [];
  if (!list.length) return null;
  return <>
    <div className="join-banner"><Banner kind="info" icon="zap" title={list.length === 1 ? `New server detected: ${list[0].nodeName}` : `${list.length} new servers detected`}
      actions={<Button sm kind="primary" onClick={() => setSel(list[0])}>Review</Button>}>
      {list.length === 1 ? <>An agent installed on {list[0].ip || 'a server'} asked to join the console {ago(list[0].createdAt)}. It will not be connected until you approve it.</> : <>Asked to join: {list.map(r => r.nodeName).join(', ')}. None will be connected without your approval.</>}</Banner></div>
    {sel ? <Review r={sel} all={list} pick={setSel} onClose={() => setSel(null)} /> : null}
  </>;
}

/** Inside a cluster's node table: a Patroni member that already asked to join gets a "Review" button instead of a plain "no agent". Admin only (the list is admin-only). */
export function PendingJoin({ name, children }: { name: string; children: React.ReactNode }) {
  const q = useQuery<{ requests: any[] }>('/api/join-requests', { interval: 8000 });
  const [sel, setSel] = useState<any>(null);
  const list = q.data?.requests || [];
  const mine = list.find(r => r.nodeName === name);
  if (!mine) return <>{children}</>;
  return <>
    <Badge kind="info" title="This node’s agent has already asked to join: it needs approval">asks to join</Badge>
    <Button sm kind="primary" onClick={() => setSel(mine)}>Esamina</Button>
    {sel ? <Review r={sel} all={list} pick={setSel} onClose={() => setSel(null)} /> : null}
  </>;
}

function Review({ r, all, pick, onClose }: { r: any; all: any[]; pick: (r: any) => void; onClose: () => void }) {
  const [env, setEnv] = useState('prod'); const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const pg = (r.summary?.postgres || [])[0];
  const [asWorker, setAsWorker] = useState<boolean>(r.summary?.node_role === 'worker' || (!pg && !r.matchCluster));     // no database here: most likely a backup server / recovery host
  const done = (msg: string) => { toast(msg, 'ok'); revalidate('/api/join-requests'); revalidate('/api/clusters'); onClose(); };
  const approve = async () => { setBusy(true); setErr(null); try { const o: any = await api('POST', `/api/join-requests/${r.id}/approve`, asWorker ? { asWorker: true } : r.matchCluster ? {} : { environment: env, name: name || undefined }); done(asWorker ? 'Worker host approved' : 'Server approved: it will appear in a few seconds'); if (all.length === 1 && o.clusterId) go(`c/${encodeURIComponent(o.clusterId)}`); else if (o.kind === 'worker' && o.nodeId) go(`w/${encodeURIComponent(o.nodeId)}`); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  const reject = async () => { setBusy(true); try { await api('POST', `/api/join-requests/${r.id}/reject`); done('Request rejected'); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  return <Modal title={`Add ${r.nodeName}?`} onClose={onClose} footer={<><Button onClick={reject} disabled={busy}>Reject</Button><Button kind="primary" icon="check" busy={busy} disabled={r.nameInUse} onClick={approve}>Approve and connect</Button></>}>
    <div className="stack">
      <dl className="kv"><dt>Server name</dt><dd>{r.nodeName}</dd><dt>Source address</dt><dd className="mono">{r.ip || '—'}</dd>
        {r.summary?.hostname ? <><dt>Host</dt><dd>{r.summary.hostname}</dd></> : null}
        {pg ? <><dt>PostgreSQL</dt><dd>{pg.version || '?'}{pg.role ? ` · ${pg.role}` : ''}{pg.port ? ` · port ${pg.port}` : ''}</dd><dt>Data directory</dt><dd className="mono small">{pg.data_directory || '—'}</dd></> : <><dt>PostgreSQL</dt><dd className="muted">not detected on this server</dd>{r.summary?.diag && <><dt>Diagnosis</dt><dd className="small muted">{`the agent runs as uid ${r.summary.diag.uid ?? '?'}; processes seen: ${(r.summary.diag.procs || []).join(', ') || 'none relevant'}`}{(r.summary.diag.warnings || []).map((w: string, i: number) => <div key={i}>{w}</div>)}</dd></>}</>}
        <dt>Agent</dt><dd>{r.agentVersion || '—'}</dd><dt>Requested</dt><dd>{ago(r.createdAt)}</dd></dl>
      {r.nameInUse ? <Banner kind="bad" title="Name already in use">A server with this name already exists: rename the new one (PG_ARCA_NODE_NAME variable) and run the installation again.</Banner> : null}
      {!r.matchCluster ? <div className="seg"><button aria-pressed={!asWorker} onClick={() => setAsWorker(false)}>Database server</button><button aria-pressed={asWorker} onClick={() => setAsWorker(true)}>Worker host (backup server, recovery host)</button></div> : null}
      {asWorker ? <Banner kind="info" title="Worker host">No cluster is created: the agent does not look for a database and reports what the machine can do (installed PostgreSQL versions, disks, shares). You find it in the sidebar under “Worker hosts”.</Banner> :
      r.matchCluster ? <Banner kind="ok" title={`Belongs to “${r.matchCluster.name}”`}>It has the same database identity as an already connected cluster ({r.matchCluster.environment}): it will be added as a node.</Banner>
        : <><Banner kind="info" title="New cluster">It matches no connected cluster: a new one will be created.</Banner>
          <div className="grid g2"><Field label="Environment"><select className="input" value={env} onChange={e => setEnv(e.target.value)}>{ENVS.map(e => <option key={e[0]} value={e[0]}>{e[1]}</option>)}</select></Field>
            <Field label="Cluster name" hint="Optional."><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={r.summary?.patroni_scope || `pg-${r.nodeName}`} /></Field></div></>}
      <p className="small muted">On approval, the agent gets access and starts sending telemetry. If you do not recognize this server, reject it: no data has been read beyond the details above.</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}
    </div></Modal>;
}
