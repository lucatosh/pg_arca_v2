import React, { useEffect, useState } from 'react';
import { Badge, Banner, Button, Card, Field, Skeleton } from '../ui';
import { revalidate, toast, useOpRunner } from '../hooks';

type Row = { key: string; label: string; kind: string; detected: string | number; override?: string | number | null; effective: string | number; source: string; check?: { ok: boolean; message?: string } | null };
const HINT: Record<string, string> = {
  pg_data: 'La cartella che contiene PG_VERSION, per esempio /var/lib/pgsql/16/data o …/data/pgdata.',
  pg_bin_dir: 'Cartella con pg_ctl e postgres, se non è nel PATH.',
  pg_host: 'Cartella del socket (es. /var/run/postgresql) oppure un host.',
  repo_path: 'Dove l’agent scrive i backup. Non può essere una cartella di sistema.',
  wal_archive_dir: 'Dove l’agent archivia i WAL. Deve essere raggiungibile da tutti i nodi se vuoi ripristinare ovunque.',
  patroni_url: 'Di solito rilevato da solo. Serve solo se l’API di Patroni non è su questo server.',
};

/** Per-node "what was detected / what I want instead". Only the agent decides what is valid: it checks every value against the real filesystem. */
export function AgentSettings({ clusterId, nodes }: { clusterId: string; nodes: any[] }) {
  const [nodeId, setNodeId] = useState(nodes[0]?.id || '');
  const [rows, setRows] = useState<Row[] | null>(null); const [draft, setDraft] = useState<Record<string, string>>({}); const [file, setFile] = useState('');
  const [err, setErr] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const rd = useOpRunner(clusterId, op => { if (op.status === 'succeeded') { setRows(op.result.settings); setFile(op.result.file || ''); setDraft({}); } });
  const wr = useOpRunner(clusterId, op => {
    setSaving(false);
    if (op.status === 'succeeded') { toast('Impostazioni salvate: l’agent le usa già', 'ok'); setRows(op.result.settings); setDraft({}); setErr(null); revalidate('/api/nodes'); }
    else setErr(op.error || 'Salvataggio non riuscito');
  });
  useEffect(() => { if (!nodes.some(n => n.id === nodeId)) setNodeId(nodes[0]?.id || ''); }, [nodes, nodeId]);
  useEffect(() => { setRows(null); setErr(null); if (nodeId) rd.run('agent_config_get', {}, { nodeId }); /* eslint-disable-next-line */ }, [nodeId]);
  if (!nodes.length) return null;
  const online = nodes.find(n => n.id === nodeId)?.online;
  const dirty = Object.keys(draft).length > 0;
  const save = () => { setSaving(true); setErr(null); wr.run('agent_config_set', { set: Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v.trim() === '' ? null : v.trim()])) }, { nodeId }); };
  return <Card title="Percorsi e rilevamento" actions={nodes.length > 1 ? <select value={nodeId} onChange={e => setNodeId(e.target.value)} aria-label="Nodo">{nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select> : <span className="muted small">{nodes[0].name}</span>}>
    <div className="stack">
      <p className="muted small">L’agent rileva da solo cartelle, porta e binari. Se la tua installazione è diversa, scrivi qui il valore giusto: l’agent lo controlla sul server prima di salvarlo. Lascia vuoto per usare il valore rilevato.</p>
      {online === false ? <Banner kind="warn" title="Il nodo non risponde">Le impostazioni si leggono e si salvano solo con l’agent online.</Banner> : null}
      {rd.error ? <Banner kind="bad" title="Impossibile leggere le impostazioni">{rd.error}</Banner> : null}
      {rd.op?.status === 'failed' ? <Banner kind="bad" title="Impossibile leggere le impostazioni">{rd.op.error}</Banner> : null}
      {!rows && !rd.error && rd.op?.status !== 'failed' ? <Skeleton h={120} /> : null}
      {rows ? <div className="stack">{rows.map(r => {
        const fromEnv = r.source.startsWith('ambiente');
        const val = draft[r.key] ?? (r.override != null ? String(r.override) : '');
        return <Field key={r.key} label={r.label} hint={HINT[r.key]} error={r.check && !r.check.ok ? `Il valore salvato non è più valido: ${r.check.message}` : null}>
          <div className="row gap-s wrap">
            <input style={{ flex: '1 1 320px' }} className="mono" disabled={fromEnv || online === false} value={val} placeholder={r.detected !== '' ? String(r.detected) : 'non rilevato'} onChange={e => setDraft({ ...draft, [r.key]: e.target.value })} />
            <Badge kind={r.source === 'rilevato' ? undefined : fromEnv ? 'warn' : 'accent'} title={`Valore in uso: ${r.effective === '' ? '—' : r.effective}`}>{r.source}</Badge>
          </div>
          {fromEnv ? <span className="hint">Impostato da una variabile d’ambiente del servizio: ha la precedenza e si cambia dal server.</span> : null}
        </Field>;
      })}</div> : null}
      {err ? <Banner kind="bad" title="Non salvato">{err}</Banner> : null}
      <div className="row gap-s wrap"><Button kind="primary" icon="check" disabled={!dirty || online === false} busy={saving} onClick={save}>Salva e riverifica</Button>
        <Button disabled={!dirty} onClick={() => { setDraft({}); setErr(null); }}>Annulla le modifiche</Button>
        <Button onClick={() => { setRows(null); rd.run('agent_config_get', {}, { nodeId }); }}>Rileva di nuovo</Button>
        {file ? <span className="faint small mono">{file}</span> : null}</div>
    </div>
  </Card>;
}
