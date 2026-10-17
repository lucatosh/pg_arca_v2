import React, { useEffect, useState } from 'react';
import { Badge, Banner, Button, Card, Field, Skeleton, dt } from '../ui';
import { revalidate, toast, useDraft, useOpRunner, useRole } from '../hooks';

type Row = { key: string; label: string; kind: string; detected: string | number; override?: string | number | null; effective: string | number; source: string; check?: { ok: boolean; message?: string } | null };
const HINT: Record<string, string> = {
  pg_data: 'The directory that contains PG_VERSION, for example /var/lib/pgsql/16/data or …/data/pgdata.',
  pg_bin_dir: 'Directory with pg_ctl and postgres, if not in the PATH.',
  pg_host: 'Socket directory (e.g. /var/run/postgresql) or a host.',
  repo_path: 'Where the agent writes backups, on THIS node only. To move the backups of the whole cluster (with migration of what exists), use Backup storage.',
  wal_archive_dir: 'Where THIS node archives WAL: a test segment must reach it before the change is kept. To move the archive of the whole cluster, use Backup storage.',
  patroni_url: 'Usually detected automatically. Needed only if the Patroni API is not on this server.',
  process_max: 'Threads that compress and copy during a backup and extract during a restore. Each one is a core taken from PostgreSQL while it runs: the default is half the cores (2 to 8). Raise it on a big server with a fast destination, lower it if backups slow production down.',
  wal_archive_async: 'archive_command parks each segment in a local spool and returns at once; the agent pushes the spool into the archive in parallel. For WAL rates the synchronous archive_command cannot sustain. A segment in the spool is not in the archive yet: it is lost if this host is lost before it is pushed (the console shows the spool and counts it in the recovery point). Leave off unless the archiver falls behind.',
};

/** Per-node "what was detected / what I want instead". Only the agent decides what is valid: it checks every value against the real filesystem. */
export function AgentSettings({ clusterId, nodes }: { clusterId: string; nodes: any[] }) {
  const [nodeId, setNodeId] = useDraft(`agentcfg:${clusterId}:node`, nodes[0]?.id || '');
  const [rows, setRows] = useState<Row[] | null>(null); const [draft, setDraft] = useDraft<Record<string, string>>(`agentcfg:${clusterId}:${nodeId}:draft`, {}); const [file, setFile] = useState('');   // per node: a draft typed for one node is never saved on another
  const [err, setErr] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const rd = useOpRunner(clusterId, op => { if (op.status === 'succeeded') { setRows(op.result.settings); setFile(op.result.file || ''); } });
  const wr = useOpRunner(clusterId, op => {
    setSaving(false);
    if (op.status === 'succeeded') { toast('Settings saved: the agent is already using them', 'ok'); setRows(op.result.settings); setDraft({}); setErr(null); revalidate('/api/nodes'); }
    else setErr(op.error || 'Save failed');
  });
  const role = useRole(); const isAdmin = role === 'admin';
  useEffect(() => { if (!nodes.some(n => n.id === nodeId)) setNodeId(nodes[0]?.id || ''); }, [nodes, nodeId]);
  useEffect(() => { if (wr.error) { setSaving(false); setErr(wr.error); } }, [wr.error]);        // request refused before an operation existed (403, 409...)
  useEffect(() => { setRows(null); setErr(null); rd.reset(); if (nodeId) rd.run('agent_config_get', {}, { nodeId }); /* eslint-disable-next-line */ }, [nodeId]);   // a draft typed for one node must never be saved on another
  if (!nodes.length) return null;
  const online = nodes.find(n => n.id === nodeId)?.online;
  const dirty = Object.keys(draft).length > 0; const canEdit = isAdmin && online !== false;
  // a new WAL archive directory is proven (a test segment must land there through PostgreSQL's own archive_command) or the change is undone
  const save = () => { setSaving(true); setErr(null); wr.run('agent_config_set', { set: Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v.trim() === '' ? null : v.trim()])), ...('wal_archive_dir' in draft ? { verify_wal: true } : {}) }, { nodeId }); };
  return <Card title="Paths and discovery" actions={nodes.length > 1 ? <select value={nodeId} onChange={e => setNodeId(e.target.value)} aria-label="Node">{nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select> : <span className="muted small">{nodes[0].name}</span>}>
    <div className="stack">
      <p className="muted small">The agent detects directories, port and binaries by itself. If your installation differs, enter the right value here: the agent checks it on the server before saving it. Leave empty to use the detected value.</p>
      {role && !isAdmin ? <Banner kind="info" title="Read-only">Only an administrator can change these settings.</Banner> : null}
      {online === false ? <Banner kind="warn" title="The node is not responding">Settings can be read and saved only while the agent is online.</Banner> : null}
      {rd.error ? <Banner kind="bad" title="Cannot read the settings">{rd.error}</Banner> : null}
      {rd.op?.status === 'failed' ? <Banner kind="bad" title="Cannot read the settings">{rd.op.error}</Banner> : null}
      {!rows && !rd.error && rd.op?.status !== 'failed' ? <Skeleton h={120} /> : null}
      {rows ? <div className="stack">{rows.map(r => {
        const fromEnv = (r.source.startsWith('ambiente') || r.source.startsWith('environment'));
        const val = draft[r.key] ?? (r.override != null ? String(r.override) : '');
        return <Field key={r.key} label={r.label} hint={HINT[r.key]} error={r.check && !r.check.ok ? `The saved value is no longer valid: ${r.check.message}` : null}>
          <div className="row gap-s wrap">
            {r.kind === 'bool' ? <select style={{ flex: '0 0 200px' }} className="input" disabled={fromEnv || !canEdit} value={val} aria-label={r.label} onChange={e => setDraft({ ...draft, [r.key]: e.target.value })}><option value="">default ({String(r.detected) === 'true' ? 'on' : 'off'})</option><option value="true">on</option><option value="false">off</option></select> : <input style={{ flex: '1 1 320px' }} className="mono" disabled={fromEnv || !canEdit} value={val} placeholder={r.detected !== '' ? String(r.detected) : 'not detected'} onChange={e => setDraft({ ...draft, [r.key]: e.target.value })} />}
            <Badge kind={r.source === 'rilevato' || r.source === 'detected' ? undefined : fromEnv ? 'warn' : 'accent'} title={`Value in use: ${r.effective === '' ? '—' : r.effective}`}>{r.source === 'rilevato' ? 'detected' : r.source.startsWith('ambiente') ? 'environment' + r.source.slice(8) : r.source}</Badge>
          </div>
          {fromEnv ? <span className="hint">Set by an environment variable of the service: it takes precedence and is changed on the server.</span> : null}
        </Field>;
      })}</div> : null}
      {err ? <Banner kind="bad" title="Not saved">{err}</Banner> : null}
      <div className="row gap-s wrap"><Button kind="primary" icon="check" disabled={!dirty || !canEdit} busy={saving} onClick={save}>Save and re-check</Button>
        <Button disabled={!dirty} onClick={() => { setDraft({}); setErr(null); }}>Discard changes</Button>
        <Button onClick={() => { setRows(null); rd.run('agent_config_get', {}, { nodeId }); }}>Detect again</Button>
        {file ? <span className="faint small mono">{file}</span> : null}</div>
    </div>
  </Card>;
}

type Offsite = { type: 'offsite'; endpoint: string; bucket: string; prefix: string; region: string; access_key: string; secret_key: string; path_style: boolean; tls_verify: boolean; ca_file: string; enabled: boolean; secret_key_set?: boolean };
const OFF_EMPTY: Offsite = { type: 'offsite', endpoint: '', bucket: '', prefix: '', region: 'us-east-1', access_key: '', secret_key: '', path_style: true, tls_verify: true, ca_file: '', enabled: true };
/** Offsite copy of the repository and the WAL archive on S3-compatible object storage, kept by the agent of ONE node (the one that holds or mounts the repository). */
export function OffsiteCopy({ clusterId, nodes }: { clusterId: string; nodes: any[] }) {
  const [nodeId, setNodeId] = useDraft(`offsite:${clusterId}:node`, nodes[0]?.id || '');
  const [cur, setCur] = useState<any>(null); const [f, setF] = useState<Offsite | null>(null); const [out, setOut] = useState<any>(null);
  const rd = useOpRunner(clusterId, op => { if (op.status === 'succeeded') setCur(op.result); });
  const wr = useOpRunner(clusterId, op => { if (op.status === 'succeeded') { toast(op.result.cleared ? 'Offsite copy removed from this node' : `Offsite copy saved${op.result.probe ? ': ' + op.result.probe : ''}`, 'ok'); setF(null); rd.run('offsite_get', {}, { nodeId }); } });
  const sy = useOpRunner(clusterId, op => { if (op.status === 'succeeded') { setOut(op.result); rd.run('offsite_get', {}, { nodeId }); } });
  const role = useRole(); const isAdmin = role === 'admin';
  useEffect(() => { if (!nodes.some(n => n.id === nodeId)) setNodeId(nodes[0]?.id || ''); }, [nodes, nodeId]);
  useEffect(() => { setCur(null); setF(null); setOut(null); if (nodeId) rd.run('offsite_get', {}, { nodeId }); /* eslint-disable-next-line */ }, [nodeId]);
  if (!nodes.length) return null;
  const saved: any = cur?.offsite; const st = cur?.status;
  const form: Offsite = f || { ...OFF_EMPTY, ...(saved || {}), secret_key: '' };
  const set = (k: keyof Offsite, v: any) => setF({ ...form, [k]: v });
  const busy = rd.busy || wr.busy || sy.busy;
  const when = (t?: number | null) => (t ? dt(t * 1000) : '—');
  return <Card title="Offsite copy (S3-compatible object storage)" actions={nodes.length > 1 ? <select value={nodeId} onChange={e => setNodeId(e.target.value)} aria-label="Node">{nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select> : null}>
    <div className="stack">
      <p className="muted small">The agent of this node mirrors the backup repository and the WAL archive into a bucket (AWS S3, MinIO, Ceph, …) in the background: packs first, then the backup sets, then WAL; what expires locally is deleted there after six hours; nothing is ever deleted while the local storage looks empty. Backups and archiving keep writing locally at full speed. Configure it on the node that holds (or mounts) the repository — one node per shared repository.</p>
      {cur?.problem ? <Banner kind="bad" title="The saved settings are not valid">{cur.problem}</Banner> : null}
      {saved ? <dl className="kv small"><dt>Copy</dt><dd>{saved.enabled ? <Badge kind="ok">Active</Badge> : <Badge kind="warn">Paused</Badge>} <span className="mono">{saved.endpoint}</span> · bucket <span className="mono">{saved.bucket}</span>{saved.prefix ? <> · prefix <span className="mono">{saved.prefix}</span></> : null}</dd>
        <dt>Last successful sync</dt><dd>{when(st?.last_ok)}{st?.remote_objects != null ? <span className="muted"> · {st.remote_objects} objects in the bucket</span> : null}</dd>
        {st?.last_error ? <><dt>Last error</dt><dd className="bad">{st.last_error} <span className="muted">({when(st.finished)})</span></dd></> : null}
        {st?.to_upload ? <><dt>Pending</dt><dd>{st.to_upload} objects, {Math.round((st.bytes_to_upload || 0) / 1048576)} MiB</dd></> : null}</dl> : rd.op?.status === 'succeeded' ? <p className="small muted">No offsite copy on this node.</p> : null}
      {isAdmin ? <details open={!saved}><summary className="small" style={{ cursor: 'pointer' }}>{saved ? 'Change the settings' : 'Set up an offsite copy'}</summary>
        <div className="grid g2" style={{ marginTop: 8 }}>
          <Field label="Endpoint" hint="https://s3.<region>.amazonaws.com, or your MinIO / Ceph URL"><input className="input mono" value={form.endpoint} placeholder="https://minio.corp.example:9000" onChange={e => set('endpoint', e.target.value)} /></Field>
          <Field label="Bucket"><input className="input mono" value={form.bucket} onChange={e => set('bucket', e.target.value)} /></Field>
          <Field label="Prefix (folder in the bucket)" hint="One prefix per cluster, e.g. pg/prod-db"><input className="input mono" value={form.prefix} onChange={e => set('prefix', e.target.value)} /></Field>
          <Field label="Region" hint="us-east-1 for most S3-compatible stores"><input className="input mono" value={form.region} onChange={e => set('region', e.target.value)} /></Field>
          <Field label="Access key"><input className="input mono" autoComplete="off" value={form.access_key} onChange={e => set('access_key', e.target.value)} /></Field>
          <Field label="Secret key" hint={saved?.secret_key_set ? "Stored on the node, in the agent's settings file (readable by the agent user only). Leave empty to keep it." : "Stored in the agent's settings file on the node (readable by the agent user only), never in the console."}><input className="input mono" type="password" autoComplete="new-password" value={form.secret_key} onChange={e => set('secret_key', e.target.value)} /></Field>
          <Field label="Options"><div className="row gap wrap"><label className="row gap-s small"><input type="checkbox" checked={form.path_style} onChange={e => set('path_style', e.target.checked)} /> Path-style URLs (MinIO, Ceph)</label><label className="row gap-s small"><input type="checkbox" checked={form.tls_verify} onChange={e => set('tls_verify', e.target.checked)} /> Verify the TLS certificate</label><label className="row gap-s small"><input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /> Enabled</label></div></Field>
          <Field label="CA certificate file on the node (optional)"><input className="input mono" value={form.ca_file} placeholder="/etc/pg-arca/s3-ca.pem" onChange={e => set('ca_file', e.target.value)} /></Field>
        </div>
        <div className="row gap-s wrap" style={{ marginTop: 8 }}>
          <Button kind="primary" busy={wr.busy} disabled={!f || !form.endpoint || !form.bucket || !form.access_key || busy} onClick={() => wr.run('offsite_set', { offsite: form, test: true }, { nodeId })}>Test the bucket and save</Button>
          {saved ? <Button kind="danger" disabled={busy} onClick={() => wr.run('offsite_set', { offsite: null }, { nodeId })}>Remove the offsite copy</Button> : null}
          {f ? <Button disabled={busy} onClick={() => setF(null)}>Discard</Button> : null}
        </div></details> : null}
      {saved ? <div className="row gap-s wrap">
        <Button sm disabled={busy} onClick={() => sy.run('offsite_sync', {}, { nodeId })}>Sync now</Button>
        <Button sm disabled={busy} onClick={() => sy.run('offsite_sync', { dry_run: true }, { nodeId })}>What would be uploaded?</Button>
        <Button sm disabled={busy || role === 'viewer'} onClick={() => sy.run('offsite_rehydrate', { what: 'all' }, { nodeId })} title="Downloads into the local repository and WAL archive every object of the copy that is missing here (disaster recovery of the backup storage). What retention removed here on purpose is not brought back.">Download what is missing here</Button>
      </div> : null}
      {wr.error ? <Banner kind="bad" title="Not saved">{wr.error}</Banner> : null}{wr.op?.status === 'failed' ? <Banner kind="bad" title="Not saved">{wr.op.error}</Banner> : null}
      {sy.op?.status === 'failed' ? <Banner kind="bad" title="Sync failed">{sy.op.error}</Banner> : null}
      {out && out.refused_count ? <Banner kind="warn" title={`${out.refused_count} ${out.refused_count === 1 ? 'object was' : 'objects were'} not downloaded`}>Something is already in the way locally, or the object's name points outside the repository / WAL archive{(out.refused || []).length ? <>, e.g. <code>{out.refused[0]}</code></> : null}. Check them before restoring: a backup may be incomplete without them.</Banner> : null}
      {out ? <Banner kind={out.refused_count ? 'warn' : 'ok'} title={out.dry_run ? `${out.to_upload} objects (${Math.round((out.bytes_to_upload || 0) / 1048576)} MiB) would be uploaded, ${out.to_delete} deleted` : out.downloaded != null ? `${out.downloaded} objects downloaded (${Math.round((out.bytes || 0) / 1048576)} MiB)${out.differ_count ? `; ${out.differ_count} differ from the local copy and were left alone` : ''}${out.retained_skipped ? `; ${out.retained_skipped} removed here on purpose by retention (${Math.round((out.retained_bytes || 0) / 1048576)} MiB) were not brought back` : ''}` : `${out.uploaded} objects uploaded (${Math.round((out.uploaded_bytes || 0) / 1048576)} MiB), ${out.deleted} deleted${out.failed ? `, ${out.failed} failed` : ''}`} /> : null}
    </div>
  </Card>;
}
