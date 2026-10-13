import React, { useState } from 'react';
import { Badge, Banner, Button, Card, Confirm, CopyBlock, Field, Icon, bytes, dt } from '../ui';
import { revalidate, useOpRunner } from '../hooks';
import { OpPanel } from './shared';

/** Where a whole-instance copy can go on the node: one proposal per volume (filesystem, free space, what else lives there), the best one first. */
export type DestCand = { path: string; root: string; origin: string; mountpoint: string; fstype: string; source: string; free: number; total: number; free_after: number; need: number; fits: boolean; shares: string[]; level: 'ok' | 'warn' | 'bad'; why: string; recommended: boolean };
const ORIGIN: Record<string, string> = { configured: 'cartella indicata nelle impostazioni dell’agent', volume: 'volume dedicato', 'next to the data directory': 'accanto ai dati di PostgreSQL', 'agent scratch': 'area di lavoro dell’agent', 'home of the agent user': 'home dell’utente dell’agent', 'temporary files': 'file temporanei di sistema' };
const SHARE: Record<string, string> = { 'production data (PGDATA)': 'dati di produzione', 'WAL archive': 'archivio WAL', 'backup repository': 'backup' };
const whyIt = (c: DestCand) => c.level === 'ok' ? `Volume separato: dopo il ripristino restano ${bytes(c.free_after)} liberi.`
  : !c.fits ? `Spazio insufficiente: ${bytes(c.free)} liberi, ne servono circa ${bytes(c.need)}.`
  : c.shares.includes('production data (PGDATA)') ? (c.free_after < Math.max(2 * 2 ** 30, c.total * 0.1) ? `Stesso disco dei dati di produzione: resterebbero solo ${bytes(Math.max(0, c.free_after))} alla produzione.` : `Stesso disco dei dati di produzione: la copia ne occupa ${bytes(c.need)}, ne restano ${bytes(c.free_after)}.`)
  : c.shares.length ? `Stesso disco di: ${c.shares.map(x => SHARE[x] || x).join(', ')}.` : `Filesystem di rete (${c.fstype}): ripristino e recupero più lenti.`;

export function DestPicker({ where, value, onPick, busy }: { where: { candidates: DestCand[]; need: number; name: string } | null | undefined; value: string; onPick: (path: string) => void; busy?: boolean }) {
  const cands = where?.candidates || [];
  const custom = !!value && !cands.some(c => c.path === value);
  const [own, setOwn] = useState(custom ? value : '');
  const [ownOpen, setOwnOpen] = useState(custom);
  return <div className="stack-s" role="radiogroup" aria-label="Dove mettere la copia">
    {where ? <div className="small muted">Servono circa <strong>{bytes(where.need)}</strong> (dati del backup, WAL da applicare e log). La cartella <code>{where.name}</code> viene creata da pg_arca.</div> : null}
    {cands.map(c => { const used = c.total ? Math.round(((c.total - c.free) / c.total) * 100) : 0; const after = c.total ? Math.min(100, Math.round(((c.total - c.free + c.need) / c.total) * 100)) : 0;
      return <label key={c.path} className={`opt dest ${value === c.path ? 'on' : ''} ${c.level === 'bad' ? 'off' : ''}`}><input type="radio" name="dest" disabled={busy} checked={value === c.path} onChange={() => { setOwnOpen(false); onPick(c.path); }} /><div className="grow">
        <div className="row wrap gap-s"><code className="trunc">{c.path}</code>{c.recommended ? <Badge kind="ok">Consigliato</Badge> : null}{c.level === 'warn' ? <Badge kind="warn">Attenzione</Badge> : c.level === 'bad' ? <Badge kind="bad">Sconsigliato</Badge> : null}</div>
        <div className="small muted">{ORIGIN[c.origin] || c.origin} · disco <code>{c.mountpoint}</code> ({c.fstype}{c.source && c.source !== 'none' ? `, ${c.source}` : ''}) · {bytes(c.free)} liberi su {bytes(c.total)}</div>
        <div className="usebar" title={`Occupato oggi ${used}%, dopo il ripristino ${after}%`}><i style={{ width: `${used}%` }} /><b style={{ left: `${used}%`, width: `${Math.max(0, after - used)}%` }} className={c.level} /></div>
        <div className="small" style={{ color: c.level === 'bad' ? 'var(--bad)' : c.level === 'warn' ? 'var(--warn)' : 'var(--ink-2)' }}>{whyIt(c)}</div></div></label>; })}
    <label className={`opt ${ownOpen ? 'on' : ''}`}><input type="radio" name="dest" disabled={busy} checked={ownOpen} onChange={() => setOwnOpen(true)} /><div className="grow">
      <div><strong>Un’altra cartella</strong></div>
      {ownOpen ? <div className="row gap-s" style={{ marginTop: 6 }}><input className="input mono" value={own} onChange={e => setOwn(e.target.value)} placeholder="/restore/copia" aria-label="Cartella di destinazione" />
        <Button sm icon="search" busy={busy} disabled={!own.startsWith('/') || own.split('/').includes('..')} onClick={() => onPick(own.replace(/\/+$/, ''))}>Verifica</Button></div>
        : <div className="small muted">Percorso assoluto, vuoto o inesistente, scrivibile dall’utente dell’agent. La cartella dati in uso è sempre rifiutata.</div>}</div></label>
  </div>;
}

export const TTL_CHOICES: [number, string][] = [[4, '4 ore'], [24, '1 giorno'], [72, '3 giorni'], [168, '1 settimana'], [0, 'Finché non la elimino']];

const STATE: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info' | undefined]> = {
  running: ['In esecuzione', 'ok'], paused: ['In pausa al momento scelto', 'info'], stopped: ['Ferma', undefined], down: ['Non in esecuzione (riavvio automatico)', 'warn'], failed: ['Avvio non riuscito', 'bad'], starting: ['In avvio', 'info'],
};
const left = (iso?: string | null) => { if (!iso) return null; const h = (Date.parse(iso) - Date.now()) / 3600e3; return h <= 0 ? 'a breve' : h < 1 ? `tra ${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `tra ${Math.round(h)} ore` : `tra ${Math.round(h / 24)} giorni`; };

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
      <span className="small muted">{r.keep ? 'Tenuta finché non la elimini' : r.expires_at ? <>Viene eliminata {left(r.expires_at)} ({dt(r.expires_at)})</> : null}</span></div>
    <dl className="kv small">
      <dt>Server</dt><dd>{r.nodeName}{host && host !== r.nodeName ? <> ({host})</> : null}, porta <strong>{r.port}</strong></dd>
      <dt>Contenuto</dt><dd>PostgreSQL {r.major}, backup {r.set ? <code>{r.set}</code> : '—'}, {r.target ? <>fino a <em>{String(r.target).replace('end of archive', 'fine dell’archivio').replace('end of the archive', 'fine dell’archivio')}</em></> : null}{r.size_bytes ? <>, {bytes(r.size_bytes)}</> : null}</dd>
      <dt>Cartella</dt><dd><code>{r.dest}</code></dd>
      {r.databases?.length ? <><dt>Database</dt><dd>{r.databases.join(', ')}</dd></> : null}
    </dl>
    {live ? <div className="stack-s">
      <div className="small"><strong>Come collegarsi</strong> — stessi utenti e password della produzione{localOnly ? '; la copia accetta solo connessioni locali, come l’originale' : ''}:</div>
      {localOnly ? <><CopyBlock text={`ssh -L ${r.port}:localhost:${r.port} ${host}   # poi, dal tuo PC:  psql -h localhost -p ${r.port} -d ${db}`} /></>
        : <CopyBlock text={`psql -h ${host} -p ${r.port} -d ${db}`} />}
      <details className="small"><summary style={{ cursor: 'pointer' }}>Dal server stesso, senza password</summary><CopyBlock text={`sudo -u postgres psql -h ${r.sockdir} -p ${r.port} -d ${db}`} /></details>
      {r.state === 'paused' ? <Banner kind="info" title="La copia è ferma al momento scelto">Puoi leggerla e controllarla. Quando va bene, «Concludi il recupero» la trasforma in un server normale, sempre isolato dalla produzione.</Banner> : null}
    </div> : null}
    {r.state === 'failed' && r.error ? <Banner kind="bad" title="La copia non è partita"><span style={{ whiteSpace: 'pre-wrap' }}>{r.error}</span><p className="small" style={{ marginTop: 6 }}>I dati ripristinati sono integri nella cartella: sistema la causa e premi «Avvia», oppure elimina la copia.</p></Banner> : null}
    {r.notes?.length ? <ul className="small muted" style={{ margin: 0 }}>{r.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul> : null}
    {!compact || run.op ? <OpPanel op={run.op} error={run.error} /> : null}
    <div className="row wrap gap-s">
      {r.state === 'paused' ? <Button sm kind="primary" icon="check" busy={run.busy} onClick={() => act('restored_resume')}>Concludi il recupero</Button> : null}
      {live ? <Button sm icon="stop" busy={run.busy} onClick={() => act('restored_stop')}>Ferma</Button> : <Button sm icon="play" busy={run.busy} disabled={r.online === false} onClick={() => act('restored_start')}>Avvia</Button>}
      <Button sm icon="clock" disabled={run.busy} onClick={() => setAsk('keep')}>{r.keep ? 'Imposta una scadenza' : 'Tienila più a lungo'}</Button>
      <Button sm kind="danger" icon="trash" disabled={run.busy || r.online === false} onClick={() => setAsk('drop')}>Elimina</Button>
    </div>
    {ask === 'drop' ? <Confirm title="Eliminare la copia ripristinata?" danger requireText={r.name} confirmLabel="Elimina" onClose={() => setAsk(null)} onConfirm={() => { setAsk(null); act('restored_drop', { confirm: r.name }); }}>
      <p>La copia viene fermata e la cartella <code>{r.dest}</code> cancellata{r.size_bytes ? <> (circa {bytes(r.size_bytes)})</> : null}. Il server di produzione e i backup non vengono toccati.</p></Confirm> : null}
    {ask === 'keep' ? <Confirm title="Per quanto tenerla?" confirmLabel="Conferma" onClose={() => setAsk(null)} onConfirm={() => { setAsk(null); act('restored_keep', { hours: ttl }); }}>
      <Field label="Da adesso"><div className="seg">{TTL_CHOICES.map(([h, t]) => <button key={h} aria-pressed={ttl === h} onClick={() => setTtl(h)}>{t}</button>)}</div></Field>
      <p className="small muted">Alla scadenza l’agent ferma la copia e ne cancella la cartella da solo.</p></Confirm> : null}
  </div>;
}

/** Every restored copy of this cluster, on top of the Restore tab: what is still running, using disk, and when it goes away. */
export function RestoredList({ list, clusterId }: { list: any[]; clusterId: string }) {
  if (!list?.length) return null;
  const disk = list.reduce((a, r) => a + (Number(r.size_bytes) || 0), 0);
  return <Card title="Copie ripristinate" actions={<span className="small muted">{list.length} {list.length === 1 ? 'copia' : 'copie'}, circa {bytes(disk)} su disco</span>}>
    <div className="stack">{list.map(r => <RestoredCard key={r.nodeId + r.id} r={r} clusterId={clusterId} compact />)}</div></Card>;
}
