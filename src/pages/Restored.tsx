import React, { useState } from 'react';
import { Badge, Banner, Button, Card, Confirm, CopyBlock, Field, Icon, bytes, dt } from '../ui';
import { revalidate, useOpRunner } from '../hooks';
import { OpPanel } from './shared';

/** Where a whole-instance copy can go on the node: one proposal per volume (filesystem, free space, what else lives there), the best one first. */
export type DestCand = { path: string; root: string; origin: string; mountpoint: string; fstype: string; source: string; free: number; total: number; free_after: number; need: number; fits: boolean; shares: string[]; level: 'ok' | 'warn' | 'bad'; why: string; recommended: boolean };
const ORIGIN: Record<string, string> = { configured: 'directory set in the agent settings', volume: 'dedicated volume', 'next to the data directory': 'next to the PostgreSQL data', 'agent scratch': 'agent scratch area', 'home of the agent user': 'home of the agent user', 'temporary files': 'system temporary files' };
const SHARE: Record<string, string> = { 'production data (PGDATA)': 'production data', 'WAL archive': 'WAL archive', 'backup repository': 'backups' };
const whyText = (c: DestCand) => c.level === 'ok' ? `Separate volume: ${bytes(c.free_after)} stays free after the restore.`
  : !c.fits ? `Not enough space: ${bytes(c.free)} free, about ${bytes(c.need)} needed.`
  : c.shares.includes('production data (PGDATA)') ? (c.free_after < Math.max(2 * 2 ** 30, c.total * 0.1) ? `Same disk as the production data: only ${bytes(Math.max(0, c.free_after))} would be left for production.` : `Same disk as the production data: the copy takes ${bytes(c.need)}, ${bytes(c.free_after)} stays free.`)
  : c.shares.length ? `Same disk as: ${c.shares.map(x => SHARE[x] || x).join(', ')}.` : `Network filesystem (${c.fstype}): slower restore and recovery.`;

export function DestPicker({ where, value, onPick, busy }: { where: { candidates: DestCand[]; need: number; name: string } | null | undefined; value: string; onPick: (path: string) => void; busy?: boolean }) {
  const cands = where?.candidates || [];
  const custom = !!value && !cands.some(c => c.path === value);
  const [own, setOwn] = useState(custom ? value : '');
  const [ownOpen, setOwnOpen] = useState(custom);
  return <div className="stack-s" role="radiogroup" aria-label="Where to put the copy">
    {where ? <div className="small muted">About <strong>{bytes(where.need)}</strong> is needed (backup data, WAL to replay and logs). pg_arca creates the <code>{where.name}</code> directory.</div> : null}
    {cands.map(c => { const used = c.total ? Math.round(((c.total - c.free) / c.total) * 100) : 0; const after = c.total ? Math.min(100, Math.round(((c.total - c.free + c.need) / c.total) * 100)) : 0;
      return <label key={c.path} className={`opt dest ${value === c.path ? 'on' : ''} ${c.level === 'bad' ? 'off' : ''}`}><input type="radio" name="dest" disabled={busy} checked={value === c.path} onChange={() => { setOwnOpen(false); onPick(c.path); }} /><div className="grow">
        <div className="row wrap gap-s"><code className="trunc">{c.path}</code>{c.recommended ? <Badge kind="ok">Recommended</Badge> : null}{c.level === 'warn' ? <Badge kind="warn">Caution</Badge> : c.level === 'bad' ? <Badge kind="bad">Not recommended</Badge> : null}</div>
        <div className="small muted">{ORIGIN[c.origin] || c.origin} · disk <code>{c.mountpoint}</code> ({c.fstype}{c.source && c.source !== 'none' ? `, ${c.source}` : ''}) · {bytes(c.free)} free of {bytes(c.total)}</div>
        <div className="usebar" title={`${used}% used today, ${after}% after the restore`}><i style={{ width: `${used}%` }} /><b style={{ left: `${used}%`, width: `${Math.max(0, after - used)}%` }} className={c.level} /></div>
        <div className="small" style={{ color: c.level === 'bad' ? 'var(--bad)' : c.level === 'warn' ? 'var(--warn)' : 'var(--ink-2)' }}>{whyText(c)}</div></div></label>; })}
    <label className={`opt ${ownOpen ? 'on' : ''}`}><input type="radio" name="dest" disabled={busy} checked={ownOpen} onChange={() => setOwnOpen(true)} /><div className="grow">
      <div><strong>Another directory</strong></div>
      {ownOpen ? <div className="row gap-s" style={{ marginTop: 6 }}><input className="input mono" value={own} onChange={e => setOwn(e.target.value)} placeholder="/restore/copy" aria-label="Target directory" />
        <Button sm icon="search" busy={busy} disabled={!own.startsWith('/') || own.split('/').includes('..')} onClick={() => onPick(own.replace(/\/+$/, ''))}>Check</Button></div>
        : <div className="small muted">Absolute path, empty or non-existent, writable by the agent’s user. The data directory in use is always rejected.</div>}</div></label>
  </div>;
}

export const TTL_CHOICES: [number, string][] = [[4, '4 hours'], [24, '1 day'], [72, '3 days'], [168, '1 week'], [0, 'Until I delete it']];

const STATE: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info' | undefined]> = {
  running: ['Running', 'ok'], paused: ['Paused at the chosen point', 'info'], stopped: ['Stopped', undefined], down: ['Not running (automatic restart)', 'warn'], failed: ['Start failed', 'bad'], starting: ['Starting', 'info'],
};
const left = (iso?: string | null) => { if (!iso) return null; const h = (Date.parse(iso) - Date.now()) / 3600e3; return h <= 0 ? 'shortly' : h < 1 ? `in ${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `in ${Math.round(h)} hours` : `in ${Math.round(h / 24)} days`; };

/** One restored copy: state, how to connect, expiry and every action on it - nothing to type on the server. */
export function RestoredCard({ r, clusterId, compact }: { r: any; clusterId: string; compact?: boolean }) {
  const refresh = () => revalidate(`/api/clusters/${encodeURIComponent(clusterId)}/backups`);
  const run = useOpRunner(clusterId, refresh);
  const [ask, setAsk] = useState<null | 'drop' | 'keep'>(null);
  const [ttl, setTtl] = useState(24);
  const st = STATE[r.state] || [r.state, undefined];
  const db = (r.databases || []).find((x: string) => x !== 'postgres') || 'postgres';
  const localOnly = !r.listen_addresses || /^(localhost|127\.0\.0\.1|::1|'')$/.test(String(r.listen_addresses).trim());
  const host = r.host || r.nodeName;
  const act = (type: string, params: any = {}) => run.run(type, { id: r.id, ...params }, { nodeId: r.nodeId });
  const live = r.state === 'running' || r.state === 'paused';
  return <div className="restored stack-s">
    <div className="row wrap gap-s"><Icon n="server" /><strong>{r.name}</strong><Badge kind={st[1]}>{st[0]}</Badge>{r.online === false ? <Badge kind="warn">agent offline</Badge> : null}<div className="grow" />
      <span className="small muted">{r.keep ? 'Kept until you delete it' : r.expires_at ? <>Deleted {left(r.expires_at)} ({dt(r.expires_at)})</> : null}</span></div>
    <dl className="kv small">
      <dt>Server</dt><dd>{r.nodeName}{host && host !== r.nodeName ? <> ({host})</> : null}, port <strong>{r.port}</strong></dd>
      <dt>Content</dt><dd>PostgreSQL {r.major}, backup {r.set ? <code>{r.set}</code> : '—'}, {r.target ? <>up to <em>{String(r.target).replace('end of archive', 'end of the archive')}</em></> : null}{r.size_bytes ? <>, {bytes(r.size_bytes)}</> : null}</dd>
      <dt>Directory</dt><dd><code>{r.dest}</code></dd>
      {r.databases?.length ? <><dt>Database</dt><dd>{r.databases.join(', ')}</dd></> : null}
    </dl>
    {live ? <div className="stack-s">
      <div className="small"><strong>How to connect</strong> — same users and passwords as production{localOnly ? '; the copy accepts only local connections, like the original' : ''}:</div>
      {localOnly ? <><CopyBlock text={`ssh -L ${r.port}:localhost:${r.port} ${host}   # then, from your PC:  psql -h localhost -p ${r.port} -d ${db}`} /></>
        : <CopyBlock text={`psql -h ${host} -p ${r.port} -d ${db}`} />}
      <details className="small"><summary style={{ cursor: 'pointer' }}>From the server itself, without a password</summary><CopyBlock text={`sudo -u postgres psql -h ${r.sockdir} -p ${r.port} -d ${db}`} /></details>
      {r.state === 'paused' ? <Banner kind="info" title="The copy is paused at the chosen point">You can read and check it. When it is fine, “Finish recovery” turns it into a normal server, still isolated from production.</Banner> : null}
    </div> : null}
    {r.state === 'failed' && r.error ? <Banner kind="bad" title="The copy did not start"><span style={{ whiteSpace: 'pre-wrap' }}>{r.error}</span><p className="small" style={{ marginTop: 6 }}>The restored data in the directory is intact: fix the cause and press “Start”, or delete the copy.</p></Banner> : null}
    {r.notes?.length ? <ul className="small muted" style={{ margin: 0 }}>{r.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul> : null}
    {!compact || run.op ? <OpPanel op={run.op} error={run.error} /> : null}
    <div className="row wrap gap-s">
      {r.state === 'paused' ? <Button sm kind="primary" icon="check" busy={run.busy} onClick={() => act('restored_resume')}>Finish recovery</Button> : null}
      {live ? <Button sm icon="stop" busy={run.busy} onClick={() => act('restored_stop')}>Stop</Button> : <Button sm icon="play" busy={run.busy} disabled={r.online === false} onClick={() => act('restored_start')}>Start</Button>}
      <Button sm icon="clock" disabled={run.busy} onClick={() => setAsk('keep')}>{r.keep ? 'Set an expiry' : 'Keep it longer'}</Button>
      <Button sm kind="danger" icon="trash" disabled={run.busy || r.online === false} onClick={() => setAsk('drop')}>Delete</Button>
    </div>
    {ask === 'drop' ? <Confirm title="Delete the restored copy?" danger requireText={r.name} confirmLabel="Delete" onClose={() => setAsk(null)} onConfirm={() => { setAsk(null); act('restored_drop', { confirm: r.name }); }}>
      <p>The copy is stopped and the directory <code>{r.dest}</code> is deleted{r.size_bytes ? <> (about {bytes(r.size_bytes)})</> : null}. The production server and the backups are not touched.</p></Confirm> : null}
    {ask === 'keep' ? <Confirm title="How long to keep it?" confirmLabel="Confirm" onClose={() => setAsk(null)} onConfirm={() => { setAsk(null); act('restored_keep', { hours: ttl }); }}>
      <Field label="From now"><div className="seg">{TTL_CHOICES.map(([h, t]) => <button key={h} aria-pressed={ttl === h} onClick={() => setTtl(h)}>{t}</button>)}</div></Field>
      <p className="small muted">On expiry the agent stops the copy and deletes its directory by itself.</p></Confirm> : null}
  </div>;
}

/** Every restored copy of this cluster, on top of the Restore tab: what is still running, using disk, and when it goes away. */
export function RestoredList({ list, clusterId }: { list: any[]; clusterId: string }) {
  if (!list?.length) return null;
  const disk = list.reduce((a, r) => a + (Number(r.size_bytes) || 0), 0);
  return <Card title="Restored copies" actions={<span className="small muted">{list.length} {list.length === 1 ? 'copy' : 'copies'}, about {bytes(disk)} on disk</span>}>
    <div className="stack">{list.map(r => <RestoredCard key={r.nodeId + r.id} r={r} clusterId={clusterId} compact />)}</div></Card>;
}
