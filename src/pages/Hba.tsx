import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, get, uid } from '../api';
import { Badge, Banner, Button, Card, Confirm, Empty, Field, Icon, Modal, Skeleton, ago } from '../ui';
import { isTerminal, Op, toast, useQuery } from '../hooks';
import { Issue, Rule, analyze, covers, describe, fill, fromEffective, key, sortRules, stripUntil, tag, untilLabel, untilOf, validCidr, withUntil } from '../hbaLogic';

type Row = Rule & { _id: string };
type Tpl = { id: string; name: string; description: string; envs: string[]; vars: { key: string; label: string; def: string; hint?: string }[]; rules: Rule[] };
type NodeRead = { nodeId: string; nodeName: string; ok: boolean; error?: string; data?: any };
type Order = 'specific' | 'wide' | 'manual';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function runOp(clusterId: string, type: string, params: any, nodeId?: string): Promise<Op> {
  const r = await api<{ operation?: Op; approval?: any }>('POST', `/api/clusters/${encodeURIComponent(clusterId)}/operations`, { type, params, nodeId }, { key: uid('op') });
  if (!r.operation) throw new Error('Richiesta inviata: serve l’approvazione di un altro amministratore (pagina Oggi).');
  return waitOp(r.operation);
}
async function waitOp(first: Op): Promise<Op> {
  let op = first; const t0 = Date.now();
  while (!isTerminal(op.status) && Date.now() - t0 < 180000) { await sleep(700); op = (await get<{ operation: Op }>(`/api/operations/${op.id}`)).operation; }
  if (op.status === 'failed') throw new Error(op.error || 'operazione fallita');
  if (op.status !== 'succeeded') throw new Error(op.status === 'expired' ? 'Il nodo non ha preso in carico l’operazione (offline o occupato).' : 'operazione non completata');
  return op;
}
const rid = () => Math.random().toString(36).slice(2, 9);
const toRow = (r: Rule): Row => ({ ...r, _id: rid() });
const clean = (r: Row): Rule => { const o: Rule = { type: r.type, database: r.database, user: r.user, address: r.address, method: r.method }; if (r.options) o.options = r.options; if (r.comment) o.comment = r.comment; return o; };
const sig = (rs: Rule[]) => JSON.stringify(rs.map(r => [key(r), r.comment || '']));

const TYPES: [string, string][] = [['hostssl', 'Rete, solo TLS (consigliato)'], ['host', 'Rete, con o senza TLS'], ['hostnossl', 'Rete, solo senza TLS'], ['local', 'Socket locale']];
const METHODS: [string, string][] = [['scram-sha-256', 'Password SCRAM (consigliato)'], ['cert', 'Certificato client'], ['peer', 'Utente del sistema (solo locale)'], ['ldap', 'LDAP'], ['reject', 'Rifiuta'], ['md5', 'Password MD5 (obsoleta)'], ['trust', 'Nessuna password (pericoloso)']];

/** Plain-language advice on a single rule before it is added: catches the usual mistakes early. */
function advice(r: Rule): { kind: 'bad' | 'warn' | 'info'; text: string }[] {
  const out: { kind: 'bad' | 'warn' | 'info'; text: string }[] = [];
  const repl = r.database.split(',').map(s => s.trim()).includes('replication');
  const open = r.address === 'all' || r.address === '0.0.0.0/0' || r.address === '::/0';
  if (r.method === 'trust' && r.type !== 'local') out.push({ kind: 'bad', text: 'Con “trust” chiunque raggiunga la porta entra senza password.' });
  else if (r.method === 'trust') out.push({ kind: 'warn', text: '“trust” anche in locale permette a ogni utente del server di diventare qualsiasi ruolo.' });
  if (r.method === 'md5') out.push({ kind: 'warn', text: 'MD5 è obsoleto: usa scram-sha-256 se tutti i client lo supportano.' });
  if (r.method === 'peer' && r.type !== 'local') out.push({ kind: 'bad', text: '“peer” funziona solo sul socket locale.' });
  if (r.method === 'cert' && r.type !== 'hostssl') out.push({ kind: 'bad', text: 'Il certificato client richiede il tipo “hostssl”.' });
  if (r.type !== 'local' && open && r.method !== 'reject') out.push({ kind: 'warn', text: 'Aperta a qualsiasi indirizzo: restringila alla rete che deve davvero connettersi.' });
  if (r.type === 'host' && r.method !== 'reject') out.push({ kind: 'info', text: 'Con “host” le connessioni possono essere non cifrate. Preferisci “hostssl”.' });
  if (repl && r.type === 'local') out.push({ kind: 'info', text: 'La replica fisica arriva dalla rete: di solito serve una regola host/hostssl.' });
  if (repl && r.user === 'all') out.push({ kind: 'warn', text: 'Per la replica indica l’utente dedicato, non “all”.' });
  if (!repl && r.database === 'all' && r.user === 'all' && r.method !== 'reject' && r.type !== 'local') out.push({ kind: 'warn', text: 'Tutti gli utenti su tutti i database: valuta di limitare utente o database.' });
  if (r.type === 'local' && r.address) out.push({ kind: 'bad', text: 'Le regole locali non hanno un indirizzo.' });
  return out;
}

/** Fetches what the agent sees on every online node (one node for a Patroni cluster: the DCS list is shared). */
function useHbaState(c: any) {
  const [reads, setReads] = useState<NodeRead[] | null>(null); const [loading, setLoading] = useState(false); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const fresh = (c.agentNodes || []).filter((n: any) => n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45000);
      if (!fresh.length) throw new Error('Nessun agent online su questo cluster.');
      const pick = c.haState?.managedByPatroni ? fresh.slice(0, 1) : fresh;
      const out = await Promise.all(pick.map(async (n: any): Promise<NodeRead> => {
        try { const op = await runOp(c.id, 'hba_read', {}, n.id); return { nodeId: n.id, nodeName: n.name, ok: true, data: op.result }; }
        catch (e: any) { return { nodeId: n.id, nodeName: n.name, ok: false, error: e.message }; }
      }));
      setReads(out);
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  }, [c.id, c.agentNodes, c.haState?.managedByPatroni]);
  return { reads, loading, err, load };
}

export function HbaTab({ c }: { c: any }) {
  if (c.isSandbox) return <Banner kind="info" title="Non disponibile sul cluster demo">Collega un cluster reale con l’agent per gestire pg_hba.</Banner>;
  if (c.source === 'direct') return <Card><Empty icon="lock" title="Serve l’agent">pg_hba.conf si modifica sul server del database: installa l’agent su un nodo di questo cluster.</Empty></Card>;
  return <HbaInner c={c} />;
}

function HbaInner({ c }: { c: any }) {
  const st = useHbaState(c);
  const tpls = useQuery<{ templates: Tpl[]; suggested: Record<string, string[]> }>('/api/hba/templates');
  useEffect(() => { st.load(); /* eslint-disable-next-line */ }, [c.id]);
  const okReads = (st.reads || []).filter(r => r.ok);
  const first = okReads[0]?.data;
  const patroni = first?.mode === 'patroni';

  // ---- editable managed set ----
  const [rows, setRows] = useState<Row[]>([]); const [order, setOrder] = useState<Order>('specific'); const [baseSig, setBaseSig] = useState('');
  useEffect(() => {
    if (!first) return;
    const m: Rule[] = (first.managed?.rules || []).map((r: any) => ({ type: r.type, database: r.database, user: r.user, address: r.address || '', method: r.method, options: r.options, comment: r.comment }));
    setRows(m.map(toRow)); setBaseSig(sig(m)); setPlanned(null); setApplyRes(null);
    // eslint-disable-next-line
  }, [st.reads]);

  const shown: Row[] = useMemo(() => (order === 'manual' ? rows : sortRules(rows, order)), [rows, order]);
  const existing: Rule[] = useMemo(() => {
    const mk = new Set(shown.map(r => key(r)));
    return ((first?.effective || []) as any[]).filter(r => !r.error).map(fromEffective).filter(r => !mk.has(key(r)));
  }, [first, shown]);
  // rules that live in the file outside the managed block, as the server sees them now; adopting = pulling every one of them into the block
  const serverUnmanaged: Rule[] = useMemo(() => {
    const mk = new Set((first?.managed?.rules || []).map((r: any) => key({ type: r.type, database: r.database, user: r.user, address: r.address || '', method: r.method, options: r.options } as Rule)));
    return ((first?.effective || []) as any[]).filter(r => !r.error).map(fromEffective).filter(r => !mk.has(key(r)));
  }, [first]);
  const adopt = !patroni && serverUnmanaged.length > 0 && serverUnmanaged.every(u => shown.some(s => key(s) === key(u)));
  // Evaluation order = managed block first (top of the rules), then everything that was already in the file.
  const all: Rule[] = useMemo(() => [...shown, ...existing], [shown, existing]);
  const issues = useMemo(() => analyze(all), [all]);
  const byIndex = (i: number) => issues.filter(x => x.index === i);
  const dirty = sig(shown) !== baseSig;
  const errorsInDraft = issues.some(x => x.index < shown.length && x.level === 'error' && x.code === 'duplicate');

  const add = (rs: Rule[]) => {
    const have = new Set(rows.map(r => key(r))); const fresh = rs.filter(r => !have.has(key(r)));
    if (!fresh.length) { toast('Regola già presente: niente da aggiungere', 'info'); return 0; }
    const nr = [...rows, ...fresh.map(toRow)];
    setRows(nr); setPlanned(null); setApplyRes(null);
    return fresh.length;
  };
  const remove = (id: string) => { setRows(rows.filter(r => r._id !== id)); setPlanned(null); setApplyRes(null); };
  const move = (id: string, d: -1 | 1) => {
    const base = order === 'manual' ? rows : shown; const i = base.findIndex(r => r._id === id); const j = i + d; if (j < 0 || j >= base.length) return;
    const n = [...base]; [n[i], n[j]] = [n[j], n[i]]; setRows(n); setOrder('manual'); setPlanned(null);
  };
  const setOrderMode = (o: Order) => { if (o === 'manual') setRows(shown); setOrder(o); setPlanned(null); };

  // ---- plan / apply ----
  const [planned, setPlanned] = useState<{ sig: string; reads: { node: string; res?: any; error?: string }[] } | null>(null); const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false); const [applyRes, setApplyRes] = useState<{ node: string; ok: boolean; text: string }[] | null>(null); const [force, setForce] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const keyRef = useRef<{ sig: string; key: string } | null>(null);
  const curSig = sig(shown);
  const doPlan = async () => {
    setPlanning(true); setApplyRes(null);
    try {
      const rules = shown.map(clean);
      const out = await Promise.all(okReads.map(async n => { try { const op = await runOp(c.id, 'hba_plan', { rules, adopt }, n.nodeId); return { node: n.nodeName, res: op.result }; } catch (e: any) { return { node: n.nodeName, error: e.message }; } }));
      setPlanned({ sig: curSig, reads: out });
    } finally { setPlanning(false); }
  };
  const plans = planned?.sig === curSig ? planned.reads : null;
  const lock = (plans || []).flatMap(p => (p.res?.would_lock_out || []).map((l: string) => `${p.node}: ${l}`));
  const invalid = (plans || []).some(p => p.error || p.res?.valid === false);
  const nothing = !!plans && plans.every(p => p.res && p.res.changed === false);
  const doApply = async () => {
    setConfirmApply(false); setApplying(true); setApplyRes(null);
    try {
      if (!keyRef.current || keyRef.current.sig !== curSig + force + adopt) keyRef.current = { sig: curSig + force + adopt, key: uid('hba') };
      const baseRevs: Record<string, string> = {}; okReads.forEach(n => { baseRevs[n.nodeId] = n.data.rev; });
      const r: any = await api<{ mode: string; approval?: any; operations: { nodeId: string; nodeName: string; operation: Op }[] }>('POST', `/api/clusters/${encodeURIComponent(c.id)}/hba/apply`, { rules: shown.map(clean), baseRevs, force, adopt }, { key: keyRef.current.key });
      if (r.approval) { toast('Richiesta inviata: serve l’approvazione di un altro amministratore (pagina Oggi).', 'info', 9000); keyRef.current = null; return; }
      const done = await Promise.all((r.operations as any[]).map(async o => { try { const op = await waitOp(o.operation); return { node: o.nodeName, ok: true, text: op.result?.changed === false ? 'già aggiornato' : op.result?.note || 'applicato e verificato' }; } catch (e: any) { return { node: o.nodeName, ok: false, text: e.message }; } }));
      setApplyRes(done); keyRef.current = null;
      if (done.every(d => d.ok)) toast('Regole applicate e verificate', 'ok'); else toast('Alcuni nodi non hanno applicato le regole', 'bad');
      await st.load();
    } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setApplying(false); }
  };
  const [rb, setRb] = useState(false);
  const doRollback = async () => {
    setRb(false); setApplying(true);
    try { const out = await Promise.all(okReads.map(async n => { try { await runOp(c.id, 'hba_rollback', {}, n.nodeId); return `${n.nodeName}: ripristinato`; } catch (e: any) { return `${n.nodeName}: ${e.message}`; } })); toast(out.join(' · '), 'info', 8000); await st.load(); }
    finally { setApplying(false); }
  };

  if (st.loading && !st.reads) return <div className="stack"><Skeleton h={50} /><Skeleton h={200} /></div>;
  if (st.err) return <Banner kind="bad" title="Impossibile leggere pg_hba" actions={<Button sm onClick={st.load}>Riprova</Button>}>{st.err}</Banner>;
  if (!st.reads) return null;
  if (!okReads.length) return <Banner kind="bad" title="Lettura non riuscita" actions={<Button sm onClick={st.load}>Riprova</Button>}>{st.reads.map(r => `${r.nodeName}: ${r.error}`).join(' · ')}</Banner>;

  // nodes whose rules differ from the first one (per-node mode)
  const drift = okReads.filter(r => r.data.rev !== first.rev);
  const sugg = (tpls.data?.suggested?.[c.environment] || []);
  const hosts: string[] = (c.haState?.nodes || []).map((n: any) => String(n.host || '')).filter((h: string) => /^\d+\.\d+\.\d+\.\d+$/.test(h));
  const probs = (first.errors || []) as any[];

  return <div className="stack-l">
    <div className="row wrap">
      {patroni ? <Badge kind="accent" title="Le regole stanno nella configurazione dinamica di Patroni (DCS): una modifica vale per tutti i membri.">Patroni · configurazione condivisa (DCS)</Badge>
        : okReads.length > 1 ? <Badge title="Ogni nodo ha il proprio pg_hba.conf: la modifica viene applicata a tutti.">{okReads.length} nodi · file per nodo</Badge> : <Badge title={first.hba_file}>Nodo singolo · file pg_hba.conf</Badge>}
      {first.ssl === false ? <Badge kind="warn" title="ssl=off: le regole hostssl non corrispondono finché TLS non è attivo.">TLS disattivo</Badge> : null}
      <span className="small muted mono">{patroni ? 'postgresql.pg_hba' : first.hba_file}</span>
      <div className="grow" /><Button sm icon="refresh" busy={st.loading} onClick={st.load}>Rileggi</Button></div>

    {st.reads.some(r => !r.ok) ? <Banner kind="warn" title="Alcuni nodi non hanno risposto">{st.reads.filter(r => !r.ok).map(r => `${r.nodeName}: ${r.error}`).join(' · ')}</Banner> : null}
    {drift.length ? <Banner kind="warn" title="I nodi hanno regole diverse">{drift.map(d => d.nodeName).join(', ')} {drift.length > 1 ? 'differiscono' : 'differisce'} da {okReads[0].nodeName}. Applicando da qui tutti i nodi riceveranno lo stesso blocco gestito; le regole scritte a mano fuori dal blocco restano com’erano.</Banner> : null}
    {probs.length ? <Banner kind="bad" title="PostgreSQL segnala errori nel file attuale">{probs.slice(0, 3).map((p: any) => `riga ${p.line_number}: ${p.error}`).join(' · ')}</Banner> : null}
    {first.has_includes ? <Banner kind="info" title="Il file usa include">Le regole importate con include non sono analizzate qui: l’ordine mostrato potrebbe non riflettere l’intero file.</Banner> : null}

    <Suggestions rows={shown} existing={existing} first={first} add={add} c={c} />

    <Card title="Regole gestite dalla console" actions={<div className="row">
      <label className="small muted" htmlFor="hba-order">Ordine</label>
      <select id="hba-order" className="input" style={{ width: 'auto' }} value={order} onChange={e => setOrderMode(e.target.value as Order)}>
        <option value="specific">Specifico prima (consigliato)</option><option value="wide">Rete più ampia in alto</option><option value="manual">Manuale</option></select></div>} pad={false}>
      {order === 'wide' ? <div className="bd"><Banner kind="info" title="Come funziona l’ordine">PostgreSQL usa la prima regola che corrisponde. Con le reti più ampie in alto, le regole più strette sotto di loro possono non essere mai raggiunte: sono segnalate in rosso.</Banner></div> : null}
      {!shown.length ? <div className="bd"><Empty icon="lock" title="Nessuna regola gestita">Aggiungi una regola o parti da un modello qui sotto. Le regole già presenti nel file restano intatte.</Empty></div> :
        <div className="tablewrap"><table className="t hba"><thead><tr><th style={{ width: 28 }} /><th>Regola</th><th>Dettagli</th><th /></tr></thead><tbody>
          {shown.map((r, i) => <RuleLine key={r._id} r={r} n={i + 1} issues={byIndex(i)} manual={order === 'manual'} onMove={d => move(r._id, d)} onRemove={() => remove(r._id)} />)}
        </tbody></table></div>}
    </Card>

    <AddRule rows={shown} existing={existing} first={first} hosts={hosts} order={order} onAdd={r => add([r])} />

    <Templates tpls={tpls.data?.templates || []} sugg={sugg} env={c.environment} all={all} hosts={hosts} onAdd={rs => add(rs)} />

    {existing.length ? <Card title={`Regole già presenti nel file (${existing.length})`} pad={false} actions={!patroni && !adopt ? <Button sm onClick={() => add(serverUnmanaged)} title="Le sposta nel blocco gestito mantenendo lo stesso ordine di valutazione: potrai modificarle e riordinarle.">Adotta nel blocco gestito</Button> : <span className="small muted">Valgono dopo il blocco gestito · sola lettura</span>}>
      <div className="tablewrap"><table className="t hba"><tbody>{existing.map((r, i) => {
        const gi = shown.length + i; const is = issues.filter(x => x.index === gi);
        return <tr key={i}><td className="num muted" style={{ width: 28 }}>{gi + 1}</td><td><div>{describe(r)}</div>{is.map((x, k) => <div key={k} className={`small ${x.level === 'error' ? 'hba-err' : 'muted'}`}>{x.message}</div>)}</td>
          <td><Badge kind={tag(r).kind}>{tag(r).label}</Badge></td><td className="mono small muted">{r.type} {r.database} {r.user} {r.address || ''} {r.method}</td></tr>;
      })}</tbody></table></div></Card> : null}

    <Card title="Verifica e applica">
      <div className="stack">
        {!dirty ? <p className="muted">Nessuna modifica rispetto a ciò che c’è sul {patroni ? 'cluster' : okReads.length > 1 ? 'cluster' : 'nodo'}.</p> : <p>Hai modifiche non applicate. Prima controlla l’effetto: la simulazione verifica che nessuna connessione esistente (replica e amministrazione locale) venga bloccata.</p>}
        <div className="row wrap"><Button icon="eye" busy={planning} disabled={planning || applying || errorsInDraft} onClick={doPlan}>Verifica effetto</Button>
          <Button kind="primary" icon="check" busy={applying} disabled={!plans || invalid || nothing || errorsInDraft || (lock.length > 0 && !force) || applying} onClick={() => setConfirmApply(true)}>{patroni ? 'Applica a tutto il cluster' : okReads.length > 1 ? `Applica a ${okReads.length} nodi` : 'Applica'}</Button>
          {!patroni && first.backups?.length ? <Button icon="restore" disabled={applying} onClick={() => setRb(true)}>Ripristina versione precedente</Button> : null}</div>
        {errorsInDraft ? <Banner kind="bad" title="Ci sono regole duplicate">Rimuovi i duplicati segnalati in rosso prima di continuare.</Banner> : null}
        {plans ? <PlanView plans={plans} lock={lock} force={force} setForce={setForce} /> : null}
        {applyRes ? <div className="stack">{applyRes.map(a => <Banner key={a.node} kind={a.ok ? 'ok' : 'bad'} title={a.node}>{a.text}</Banner>)}</div> : null}
      </div></Card>

    <details className="card"><summary className="hd" style={{ cursor: 'pointer' }}><h2>Testo grezzo del file</h2></summary><div className="bd"><pre className="out">{first.raw}</pre>{first.truncated ? <p className="small muted">Mostrate solo le prime 200 000 byte.</p> : null}</div></details>

    {confirmApply ? <Confirm title={patroni ? 'Applicare al cluster?' : 'Applicare le regole?'} confirmLabel="Applica" onClose={() => setConfirmApply(false)} onConfirm={doApply} danger={lock.length > 0}>
      <p>{patroni ? 'La lista viene scritta nella configurazione dinamica di Patroni e tutti i membri la ricaricano.' : `Il blocco gestito viene scritto in modo atomico su ${okReads.length} nodo/i, ricaricato e verificato con pg_hba_file_rules. Se la verifica fallisce il file precedente viene rimesso.`}</p>
      {lock.length ? <Banner kind="bad" title="Forzatura attiva">Questa modifica blocca: {lock.join('; ')}.</Banner> : null}</Confirm> : null}
    {rb ? <Confirm title="Ripristinare la versione precedente?" confirmLabel="Ripristina" onClose={() => setRb(false)} onConfirm={doRollback}><p>Il file torna alla copia salvata prima dell’ultima modifica ({first.backups[first.backups.length - 1]}). Prima di sovrascrivere viene salvata la versione attuale.</p></Confirm> : null}
  </div>;
}

function RuleLine({ r, n, issues, manual, onMove, onRemove }: { r: Row; n: number; issues: Issue[]; manual: boolean; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  const t = tag(r);
  return <tr>
    <td className="num muted">{n}</td>
    <td><div className="row wrap gap-s"><Badge kind={t.kind}>{t.label}</Badge>{untilOf(r.comment) != null ? <Badge kind="warn" title={new Date(untilOf(r.comment)!).toLocaleString('it-CH')}>Temporanea · {untilLabel(untilOf(r.comment)!)}</Badge> : null}<span>{describe(r)}</span></div>
      {stripUntil(r.comment) ? <div className="small muted">{stripUntil(r.comment)}</div> : null}
      {issues.map((x, k) => <div key={k} className={`small ${x.level === 'error' ? 'hba-err' : x.level === 'warn' ? 'hba-warn' : 'muted'}`}><Icon n={x.level === 'info' ? 'info' : 'alert'} s={13} /> {x.message}</div>)}</td>
    <td className="mono small muted">{r.type} {r.database} {r.user} {r.address || ''} {r.method}</td>
    <td className="num"><div className="row gap-s" style={{ justifyContent: 'flex-end' }}>
      {manual ? <><Button sm kind="ghost" aria-label="Sposta su" onClick={() => onMove(-1)}><Icon n="down" className="flip" /></Button><Button sm kind="ghost" aria-label="Sposta giù" onClick={() => onMove(1)}><Icon n="down" /></Button></> : null}
      <Button sm kind="ghost" aria-label="Rimuovi regola" onClick={onRemove}><Icon n="trash" /></Button></div></td></tr>;
}

/** Suggestions derived from live data: replication clients that no rule would currently allow. */
function Suggestions({ rows, existing, first, add, c }: { rows: Rule[]; existing: Rule[]; first: any; add: (r: Rule[]) => number; c: any }) {
  const cur = [...rows, ...existing];
  const items = ((first.suggest?.replication_clients || []) as any[]).map(x => {
    const addr = String(x.address).split('/')[0]; const ip = addr.includes(':') ? `${addr}/128` : `${addr}/32`;
    const rule: Rule = { type: x.ssl ? 'hostssl' : 'host', database: 'replication', user: x.user, address: ip, method: 'scram-sha-256', comment: `Replica da ${addr}` };
    return { rule, ok: cur.some(e => covers(e, rule) && e.method !== 'reject') };
  }).filter(x => !x.ok);
  if (!items.length) return null;
  return <Banner kind="warn" icon="zap" title="Repliche attive senza una regola esplicita" actions={<Button sm onClick={() => add(items.map(i => i.rule))}>Aggiungi {items.length > 1 ? 'tutte' : ''}</Button>}>
    <span>{items.map(i => `${i.rule.user} da ${i.rule.address.replace(/\/\d+$/, '')}`).join(', ')}. Si connettono oggi perché una regola più ampia o manuale le copre; con una regola precisa, restano protette anche se quella cambia.</span></Banner>;
}

function AddRule({ rows, existing, first, hosts, order, onAdd }: { rows: Row[]; existing: Rule[]; first: any; hosts: string[]; order: Order; onAdd: (r: Rule) => void }) {
  const [open, setOpen] = useState(false); const [valid, setValid] = useState('0'); const canTemp = first.mode !== 'patroni';
  const blank: Rule = { type: 'hostssl', database: 'all', user: '', address: '', method: 'scram-sha-256', comment: '' };
  const [r, setR] = useState<Rule>(blank);
  const set = (p: Partial<Rule>) => setR(x => {
    const n = { ...x, ...p };
    if (p.type === 'local') { n.address = ''; if (n.method === 'scram-sha-256') n.method = 'peer'; }
    if (p.type && p.type !== 'local' && n.method === 'peer') n.method = 'scram-sha-256';
    return n;
  });
  const dbs: string[] = ['all', 'replication', ...(first.suggest?.databases || [])]; const users: string[] = ['all', ...(first.suggest?.roles || [])];
  const addrErr = r.type === 'local' ? null : !r.address ? 'Indica un indirizzo o una rete.' : r.address === 'all' || validCidr(r.address) || ['samehost', 'samenet'].includes(r.address) ? null : 'Usa il formato CIDR, ad esempio 10.0.20.0/24 (un solo host: 10.0.20.5/32).';
  const ready = !!r.user.trim() && !!r.database.trim() && !addrErr;
  const cand: Rule = { ...r, user: r.user.trim() || 'all', database: r.database.trim() || 'all', comment: withUntil(r.comment, valid === '0' || !canTemp ? null : Date.now() + Number(valid) * 3600_000) };
  // what would happen to this rule if it were added now
  const preview = useMemo(() => {
    if (!ready) return { issues: [] as Issue[] };
    const nr = [...rows, { ...cand, _id: '__new' } as Row]; const ord = order === 'manual' ? nr : sortRules(nr, order); const idx = ord.findIndex(x => (x as Row)._id === '__new');
    const is = analyze([...ord, ...existing]);
    return { issues: is.filter(x => x.index === idx || x.with === idx) , idx };
  }, [ready, r, rows, existing, order]);
  const dup = preview.issues.some(x => x.code === 'duplicate');
  const adv = ready ? advice(cand) : [];
  const nets = useMemo(() => { const s = new Set<string>(); hosts.forEach(h => { s.add(`${h}/32`); s.add(h.replace(/\.\d+$/, '.0/24')); }); return [...s]; }, [hosts]);
  if (!open) return <div><Button icon="plus" onClick={() => setOpen(true)}>Aggiungi una regola</Button></div>;
  return <Card title="Nuova regola" actions={<Button sm kind="ghost" onClick={() => setOpen(false)} aria-label="Chiudi"><Icon n="x" /></Button>}>
    <div className="stack">
      <div className="grid g3">
        <Field label="Tipo di connessione"><select className="input" value={r.type} onChange={e => set({ type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Database" hint="“replication” = replica fisica; “all” non la include."><input className="input" list="hba-dbs" value={r.database} onChange={e => set({ database: e.target.value })} /><datalist id="hba-dbs">{dbs.map(d => <option key={d} value={d} />)}</datalist></Field>
        <Field label="Utente o gruppo" hint="Per un gruppo scrivi +nomeruolo."><input className="input" list="hba-users" value={r.user} onChange={e => set({ user: e.target.value })} placeholder="app" /><datalist id="hba-users">{users.map(d => <option key={d} value={d} />)}{(first.suggest?.roles || []).map((u: string) => <option key={'+' + u} value={'+' + u} />)}</datalist></Field>
        {r.type !== 'local' ? <Field label="Rete di provenienza (CIDR)" error={r.address ? addrErr : null} hint="Più è stretta, meglio è."><input className="input mono" value={r.address} onChange={e => set({ address: e.target.value.trim() })} placeholder="10.0.20.0/24" />
          {nets.length ? <div className="row wrap gap-s" style={{ marginTop: 4 }}>{nets.map(n => <button key={n} type="button" className="chip" onClick={() => set({ address: n })}>{n}</button>)}</div> : null}</Field> : null}
        <Field label="Autenticazione"><select className="input" value={r.method} onChange={e => set({ method: e.target.value })}>{METHODS.filter(([m]) => r.type === 'local' || m !== 'peer').map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Nota (solo per te)"><input className="input" value={r.comment || ''} onChange={e => set({ comment: e.target.value })} placeholder="A cosa serve" maxLength={120} /></Field>
        {canTemp ? <Field label="Validità" hint="Una regola temporanea viene rimossa da sola alla scadenza (accesso per un consulente, un intervento).">
          <select className="input" value={valid} onChange={e => setValid(e.target.value)} aria-label="Validità della regola"><option value="0">Permanente</option><option value="1">1 ora</option><option value="8">8 ore</option><option value="24">24 ore</option><option value="168">7 giorni</option><option value="720">30 giorni</option></select></Field> : null}
      </div>
      {ready ? <div className="hba-preview"><Icon n="eye" /> {describe(cand)}</div> : null}
      {adv.map((a, i) => <div key={i} className={a.kind === 'bad' ? 'hba-err' : a.kind === 'warn' ? 'hba-warn' : 'muted small'}><Icon n={a.kind === 'info' ? 'info' : 'alert'} s={14} /> {a.text}</div>)}
      {preview.issues.map((x, i) => <div key={i} className={x.level === 'error' ? 'hba-err' : x.level === 'warn' ? 'hba-warn' : 'muted small'}><Icon n="alert" s={14} /> {x.message}</div>)}
      <div className="row"><Button kind="primary" icon="plus" disabled={!ready || dup || advice(cand).some(a => a.kind === 'bad')} onClick={() => { onAdd(cand); setR(blank); setValid('0'); }}>Aggiungi alla lista</Button>
        <span className="small muted">Non viene scritto nulla finché non verifichi e applichi.</span></div>
    </div></Card>;
}

function Templates({ tpls, sugg, env, all, hosts, onAdd }: { tpls: Tpl[]; sugg: string[]; env: string; all: Rule[]; hosts: string[]; onAdd: (r: Rule[]) => number }) {
  const [sel, setSel] = useState<Tpl | null>(null); const [vars, setVars] = useState<Record<string, string>>({});
  const ordered = useMemo(() => [...tpls].sort((a, b) => (sugg.includes(a.id) ? sugg.indexOf(a.id) : 99) - (sugg.includes(b.id) ? sugg.indexOf(b.id) : 99)), [tpls, sugg]);
  const present = (t: Tpl) => { const defaults = Object.fromEntries(t.vars.map(v => [v.key, v.def])); const rs = fill(t, defaults); return rs.length > 0 && rs.every(r => all.some(e => key(e) === key(r) || (covers(e, r) && e.method === r.method))); };
  const open = (t: Tpl) => { const v: Record<string, string> = {}; const net = hosts[0]?.replace(/\.\d+$/, '.0/24'); t.vars.forEach(x => { v[x.key] = x.key === 'replNet' && net ? net : x.def; }); setVars(v); setSel(t); };
  const rules = sel ? fill(sel, vars) : [];
  const errs = sel ? sel.vars.filter(v => /net$/i.test(v.key) && !validCidr(vars[v.key] || '')).map(v => v.label) : [];
  if (!ordered.length) return null;
  return <Card title="Modelli" actions={<span className="small muted">Suggeriti per l’ambiente <strong>{env}</strong> in testa</span>}>
    <div className="grid g3">{ordered.map(t => { const pr = present(t); return <div key={t.id} className="tpl">
      <div className="row"><strong className="grow">{t.name}</strong>{sugg.includes(t.id) ? <Badge kind="accent">Consigliato</Badge> : null}</div>
      <p className="small muted" style={{ margin: '6px 0 10px' }}>{t.description}</p>
      <div className="row">{pr ? <Badge kind="ok" title="Le regole del modello con i valori predefiniti sono già coperte da regole esistenti.">Già presente</Badge> : null}<div className="grow" /><Button sm icon="plus" onClick={() => open(t)}>{pr ? 'Aggiungi comunque' : 'Usa'}</Button></div></div>; })}</div>
    {sel ? <Modal title={sel.name} onClose={() => setSel(null)} footer={<><Button onClick={() => setSel(null)}>Annulla</Button><Button kind="primary" disabled={!!errs.length} onClick={() => { const n = onAdd(rules); setSel(null); if (n) toast(`${n} regola/e aggiunta/e alla lista`, 'ok'); }}>Aggiungi alla lista</Button></>}>
      <div className="stack"><p className="muted">{sel.description}</p>
        {sel.vars.map(v => <Field key={v.key} label={v.label} hint={v.hint} error={/net$/i.test(v.key) && !validCidr(vars[v.key] || '') ? 'Formato CIDR, ad esempio 10.0.20.0/24' : null}><input className="input" value={vars[v.key] || ''} onChange={e => setVars({ ...vars, [v.key]: e.target.value.trim() })} /></Field>)}
        <div className="stack">{rules.map((r, i) => <div key={i} className="hba-preview"><Badge kind={tag(r).kind}>{tag(r).label}</Badge> {describe(r)}</div>)}</div>
      </div></Modal> : null}
  </Card>;
}

function PlanView({ plans, lock, force, setForce }: { plans: { node: string; res?: any; error?: string }[]; lock: string[]; force: boolean; setForce: (v: boolean) => void }) {
  const p0 = plans.find(p => p.res?.valid && p.res?.diff?.length) || plans[0];
  const warns = plans.flatMap(p => (p.res?.warnings || []).map((w: any) => w.message));
  return <div className="stack">
    {plans.filter(p => p.error || p.res?.valid === false).map(p => <Banner key={p.node} kind="bad" title={`${p.node}: regole non valide`}>{p.error || (p.res.errors || []).map((e: any) => `#${e.index + 1}: ${e.message}`).join(' · ')}</Banner>)}
    {lock.length ? <Banner kind="bad" title="Questa modifica bloccherebbe connessioni in uso">{lock.join(' · ')}
      <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} />So cosa sto facendo: applica comunque</label></Banner> : null}
    {warns.length ? <Banner kind="warn" title="Avvisi">{[...new Set(warns)].join(' · ')}</Banner> : null}
    {plans.every(p => p.res?.changed === false) ? <Banner kind="ok" title="Nessuna differenza">Le regole attuali coincidono già con la lista.</Banner> : null}
    {p0?.res?.simulation?.length ? <div className="tablewrap"><table className="t"><thead><tr><th>Connessione simulata</th><th>Prima</th><th>Dopo</th></tr></thead><tbody>
      {p0.res.simulation.map((s: any, i: number) => <tr key={i}><td>{s.label}</td><td>{s.before ? <Badge kind="ok">consentita</Badge> : <Badge>rifiutata</Badge>}</td><td>{s.after ? <Badge kind="ok">consentita</Badge> : <Badge kind={s.before ? 'bad' : undefined}>rifiutata</Badge>}{s.uncertain ? <span className="small muted"> (incerta)</span> : null}</td></tr>)}</tbody></table></div> : null}
    {p0?.res?.diff?.length ? <details open><summary className="small muted" style={{ cursor: 'pointer' }}>Differenze nel file</summary><pre className="out">{p0.res.diff.join('\n')}</pre></details> : null}
  </div>;
}
