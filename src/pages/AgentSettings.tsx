import React, { useEffect, useState } from 'react';
import { Badge, Banner, Button, Card, Field, Skeleton } from '../ui';
import { revalidate, toast, useDraft, useOpRunner, useRole } from '../hooks';

type Row = { key: string; label: string; kind: string; detected: string | number; override?: string | number | null; effective: string | number; source: string; check?: { ok: boolean; message?: string } | null };
const HINT: Record<string, string> = {
  pg_data: 'The directory that contains PG_VERSION, for example /var/lib/pgsql/16/data or …/data/pgdata.',
  pg_bin_dir: 'Directory with pg_ctl and postgres, if not in the PATH.',
  pg_host: 'Socket directory (e.g. /var/run/postgresql) or a host.',
  repo_path: 'Where the agent writes backups. It cannot be a system directory.',
  wal_archive_dir: 'Where the agent archives WAL. It must be reachable from every node if you want to restore anywhere.',
  patroni_url: 'Usually detected automatically. Needed only if the Patroni API is not on this server.',
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
  const save = () => { setSaving(true); setErr(null); wr.run('agent_config_set', { set: Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v.trim() === '' ? null : v.trim()])) }, { nodeId }); };
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
            <input style={{ flex: '1 1 320px' }} className="mono" disabled={fromEnv || !canEdit} value={val} placeholder={r.detected !== '' ? String(r.detected) : 'not detected'} onChange={e => setDraft({ ...draft, [r.key]: e.target.value })} />
            <Badge kind={r.source === 'rilevato' || r.source === 'detected' ? undefined : fromEnv ? 'warn' : 'accent'} title={`Value in use: ${r.effective === '' ? '—' : r.effective}`}>{r.source}</Badge>
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
