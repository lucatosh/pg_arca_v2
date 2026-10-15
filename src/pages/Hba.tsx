import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, get, uid } from '../api';
import { Badge, Banner, Button, Card, Confirm, Empty, Field, Icon, Modal, Skeleton, ago, dt, nof } from '../ui';
import { clearDrafts, isTerminal, Op, revalidate, toast, useDraft, useQuery } from '../hooks';
import { AccessNeed, Issue, Rule, accessCoverage, analyze, clusterNeeds, covers, describe, fill, fromEffective, key, sortRules, stripUntil, tag, untilLabel, untilOf, validCidr, withUntil } from '../hbaLogic';

type Row = Rule & { _id: string };
type Tpl = { id: string; name: string; description: string; envs: string[]; vars: { key: string; label: string; def: string; hint?: string }[]; rules: Rule[] };
type NodeRead = { nodeId: string; nodeName: string; ok: boolean; error?: string; data?: any };
type Order = 'specific' | 'wide' | 'manual';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function runOp(clusterId: string, type: string, params: any, nodeId?: string): Promise<Op> {
  const r = await api<{ operation?: Op; approval?: any }>('POST', `/api/clusters/${encodeURIComponent(clusterId)}/operations`, { type, params, nodeId }, { key: uid('op') });
  if (!r.operation) throw new Error('Request sent: another administrator must approve it (Today page).');
  return waitOp(r.operation);
}
async function waitOp(first: Op): Promise<Op> {
  let op = first; const t0 = Date.now();
  while (!isTerminal(op.status) && Date.now() - t0 < 180000) { await sleep(700); op = (await get<{ operation: Op }>(`/api/operations/${op.id}`)).operation; }
  if (op.status === 'failed') throw new Error(op.error || 'operation failed');
  if (op.status !== 'succeeded') throw new Error(op.status === 'expired' ? 'The node did not pick up the operation (offline or busy).' : 'operation not completed');
  return op;
}
const rid = () => Math.random().toString(36).slice(2, 9);
const toRow = (r: Rule): Row => ({ ...r, _id: rid() });
const clean = (r: Row): Rule => { const o: Rule = { type: r.type, database: r.database, user: r.user, address: r.address, method: r.method }; if (r.options) o.options = r.options; if (r.comment) o.comment = r.comment; return o; };
const sig = (rs: Rule[]) => JSON.stringify(rs.map(r => [key(r), r.comment || '']));

const TYPES: [string, string][] = [['hostssl', 'Network, TLS only (recommended)'], ['host', 'Network, with or without TLS'], ['hostnossl', 'Network, without TLS only'], ['local', 'Local socket']];
const METHODS: [string, string][] = [['scram-sha-256', 'SCRAM password (recommended)'], ['cert', 'Client certificate'], ['peer', 'OS user (local only)'], ['ldap', 'LDAP'], ['reject', 'Reject'], ['md5', 'MD5 password (deprecated)'], ['trust', 'No password (dangerous)']];

/** Plain-language advice on a single rule before it is added: catches the usual mistakes early. */
function advice(r: Rule): { kind: 'bad' | 'warn' | 'info'; text: string }[] {
  const out: { kind: 'bad' | 'warn' | 'info'; text: string }[] = [];
  const repl = r.database.split(',').map(s => s.trim()).includes('replication');
  const open = r.address === 'all' || r.address === '0.0.0.0/0' || r.address === '::/0';
  if (r.method === 'trust' && r.type !== 'local') out.push({ kind: 'bad', text: 'With “trust”, anyone who can reach the port gets in without a password.' });
  else if (r.method === 'trust') out.push({ kind: 'warn', text: '“trust”, even locally, lets every OS user on the server become any role.' });
  if (r.method === 'md5') out.push({ kind: 'warn', text: 'MD5 is deprecated: use scram-sha-256 if all clients support it.' });
  if (r.method === 'peer' && r.type !== 'local') out.push({ kind: 'bad', text: '“peer” works only on the local socket.' });
  if (r.method === 'cert' && r.type !== 'hostssl') out.push({ kind: 'bad', text: 'A client certificate requires the “hostssl” type.' });
  if (r.type !== 'local' && open && r.method !== 'reject') out.push({ kind: 'warn', text: 'Open to any address: restrict it to the network that actually needs to connect.' });
  if (r.type === 'host' && r.method !== 'reject') out.push({ kind: 'info', text: 'With “host”, connections may be unencrypted. Prefer “hostssl”.' });
  if (repl && r.type === 'local') out.push({ kind: 'info', text: 'Physical replication comes over the network: it usually needs a host/hostssl rule.' });
  if (repl && r.user === 'all') out.push({ kind: 'warn', text: 'For replication, name the dedicated user, not “all”.' });
  if (!repl && r.database === 'all' && r.user === 'all' && r.method !== 'reject' && r.type !== 'local') out.push({ kind: 'warn', text: 'All users on all databases: consider restricting the user or the database.' });
  if (r.type === 'local' && r.address) out.push({ kind: 'bad', text: 'Local rules have no address.' });
  return out;
}

/** Fetches what the agent sees on every online node (one node for a Patroni cluster: the DCS list is shared). */
function useHbaState(c: any) {
  const [reads, setReads] = useDraft<NodeRead[] | null>(`hba:${c.id}:reads`, null, { secret: true }); const [loading, setLoading] = useState(false); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const fresh = (c.agentNodes || []).filter((n: any) => n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45000);
      if (!fresh.length) throw new Error('No agent online on this cluster.');
      const readOne = async (n: any): Promise<NodeRead> => {
        try { const op = await runOp(c.id, 'hba_read', {}, n.id); return { nodeId: n.id, nodeName: n.name, ok: true, data: op.result }; }
        catch (e: any) { return { nodeId: n.id, nodeName: n.name, ok: false, error: e.message }; }
      };
      let out: NodeRead[];
      if (c.haState?.managedByPatroni) {
        // the rule list is shared through the DCS: one readable node is enough. A node whose PostgreSQL is down (replica being cloned, stopped) is skipped, not fatal.
        out = [];
        // prefer a member whose PostgreSQL is running (the simulation and the verification need it); a DCS-only read is kept as the fallback
        let fallback: NodeRead | null = null;
        for (const n of fresh) { const r = await readOne(n); out = [r]; if (r.ok && !r.data?.pg_down) break; if (r.ok && !fallback) fallback = r; }
        if (!(out[0]?.ok && !out[0].data?.pg_down) && fallback) out = [fallback];
      } else out = await Promise.all(fresh.map(readOne));    // single instance or independent servers: each has its own pg_hba.conf
      setReads(out);
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  }, [c.id, c.agentNodes, c.haState?.managedByPatroni]);
  return { reads, loading, err, load };
}

export function HbaTab({ c }: { c: any }) {
  if (c.isSandbox) return <Banner kind="info" title="Not available on the demo cluster">Connect a real cluster with the agent to manage pg_hba.</Banner>;
  if (c.source === 'direct') return <Card><Empty icon="lock" title="The agent is required">pg_hba.conf is edited on the database server: install the agent on a node of this cluster.</Empty></Card>;
  return <HbaInner c={c} />;
}

/** The rules PostgreSQL applies on one node besides the managed block: the other DCS entries on Patroni, else what the server loaded from its file. */
function outsideOf(data: any): Rule[] {
  return Array.isArray(data?.dcs_rules) ? (data.dcs_rules as any[]).map(r => ({ type: r.type, database: r.database, user: r.user, address: r.address || '', method: r.method, options: r.options || undefined }) as Rule)
    : ((data?.effective || []) as any[]).filter(r => !r.error).map(fromEffective);
}

function HbaInner({ c }: { c: any }) {
  const st = useHbaState(c);
  const tpls = useQuery<{ templates: Tpl[]; suggested: Record<string, string[]> }>('/api/hba/templates');
  useEffect(() => { st.load(); /* eslint-disable-next-line */ }, [c.id]);
  const okReads = (st.reads || []).filter(r => r.ok);
  const first = okReads[0]?.data;
  const patroni = first?.mode === 'patroni';

  // ---- editable managed set ----
  // the rules being edited are a draft: leaving the page (another tab, a link, Back) and coming back gives them back as they were
  const HK = `hba:${c.id}`;
  const [rows, setRows] = useDraft<Row[]>(HK + ':rows', []); const [order, setOrder] = useDraft<Order>(HK + ':order', 'specific'); const [baseSig, setBaseSig] = useDraft(HK + ':base', '');
  const [serverMoved, setServerMoved] = useState(false);
  useEffect(() => {
    if (!first) return;
    const m: Rule[] = (first.managed?.rules || []).map((r: any) => ({ type: r.type, database: r.database, user: r.user, address: r.address || '', method: r.method, options: r.options, comment: r.comment }));
    const server = sig(m);
    const edited = !!baseSig && sig(order === 'manual' ? rows : sortRules(rows, order)) !== baseSig;
    if (edited) { if (server !== baseSig) { setServerMoved(true); setBaseSig(server); setPlanned(null); } return; }    // keep the user's work; say if the server changed meanwhile
    setRows(m.map(toRow)); setBaseSig(server); setPlanned(null); setApplyRes(null); setServerMoved(false);
    // eslint-disable-next-line
  }, [st.reads]);

  const shown: Row[] = useMemo(() => (order === 'manual' ? rows : sortRules(rows, order)), [rows, order]);
  // rules outside the managed block: on Patroni the other entries of the DCS list (what Patroni writes), elsewhere what PostgreSQL loaded from the file
  const outside: Rule[] = useMemo(() => (Array.isArray(first?.dcs_rules) ? (first.dcs_rules as any[]).map(r => ({ type: r.type, database: r.database, user: r.user, address: r.address || '', method: r.method, options: r.options || undefined }) as Rule)
    : ((first?.effective || []) as any[]).filter(r => !r.error).map(fromEffective)), [first]);
  const existing: Rule[] = useMemo(() => {
    const mk = new Set(shown.map(r => key(r)));
    return outside.filter(r => !mk.has(key(r)));
  }, [outside, shown]);
  // rules that live in the file outside the managed block, as the server sees them now; adopting = pulling every one of them into the block
  const serverUnmanaged: Rule[] = useMemo(() => {
    const mk = new Set((first?.managed?.rules || []).map((r: any) => key({ type: r.type, database: r.database, user: r.user, address: r.address || '', method: r.method, options: r.options } as Rule)));
    return outside.filter(r => !mk.has(key(r)));
  }, [first, outside]);
  const adopt = serverUnmanaged.length > 0 && serverUnmanaged.every(u => shown.some(s => key(s) === key(u)));
  // Evaluation order = managed block first (top of the rules), then everything that was already in the file.
  const all: Rule[] = useMemo(() => [...shown, ...existing], [shown, existing]);
  const issues = useMemo(() => analyze(all), [all]);
  const byIndex = (i: number) => issues.filter(x => x.index === i);
  const dirty = sig(shown) !== baseSig;
  const errorsInDraft = issues.some(x => x.index < shown.length && x.level === 'error' && x.code === 'duplicate');

  const add = (rs: Rule[]) => {
    const have = new Set(rows.map(r => key(r))); const fresh = rs.filter(r => !have.has(key(r)));
    if (!fresh.length) { toast('Rule already present: nothing to add', 'info'); return 0; }
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
  const [planned, setPlanned] = useDraft<{ sig: string; reads: { node: string; res?: any; error?: string }[] } | null>(HK + ':planned', null, { secret: true }); const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false); const [applyRes, setApplyRes] = useDraft<{ node: string; ok: boolean; text: string }[] | null>(HK + ':applied', null); const [force, setForce] = useState(false);
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
      if (r.approval) { toast('Request sent: another administrator must approve it (Today page).', 'info', 9000); keyRef.current = null; return; }
      const done = await Promise.all((r.operations as any[]).map(async o => { try { const op = await waitOp(o.operation); return { node: o.nodeName, ok: true, text: op.result?.changed === false ? 'already up to date' : op.result?.note || 'applied and verified' }; } catch (e: any) { return { node: o.nodeName, ok: false, text: e.message }; } }));
      setApplyRes(done); keyRef.current = null; revalidate(`/api/clusters/${encodeURIComponent(c.id)}/hba/history`);
      if (done.every(d => d.ok)) { toast('Rules applied and verified', 'ok'); clearDrafts(`hba:add:${c.id}`); clearDrafts(`hba:tpl:${c.id}`); } else toast('Some nodes did not apply the rules', 'bad');
      await st.load();
    } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setApplying(false); }
  };
  const [rb, setRb] = useState(false);
  const doRollback = async () => {
    setRb(false); setApplying(true);
    try { const out = await Promise.all(okReads.map(async n => { try { await runOp(c.id, 'hba_rollback', {}, n.nodeId); return `${n.nodeName}: rolled back`; } catch (e: any) { return `${n.nodeName}: ${e.message}`; } })); toast(out.join(' · '), 'info', 8000); await st.load(); }
    finally { setApplying(false); }
  };

  if (st.loading && !st.reads) return <div className="stack"><Skeleton h={50} /><Skeleton h={200} /></div>;
  if (st.err) return <Banner kind="bad" title="Cannot read pg_hba" actions={<Button sm onClick={st.load}>Retry</Button>}>{st.err}</Banner>;
  if (!st.reads) return null;
  if (!okReads.length) return <Banner kind="bad" title="Read failed" actions={<Button sm onClick={st.load}>Retry</Button>}>{st.reads.map(r => `${r.nodeName}: ${r.error}`).join(' · ')}</Banner>;

  // nodes whose rules differ from the first one (per-node mode)
  const drift = okReads.filter(r => r.data.rev !== first.rev);
  const sugg = (tpls.data?.suggested?.[c.environment] || []);
  const hosts: string[] = (c.haState?.nodes || []).map((n: any) => String(n.host || '')).filter((h: string) => /^\d+\.\d+\.\d+\.\d+$/.test(h));
  const probs = (first.errors || []) as any[];

  return <div className="stack-l">
    <div className="row wrap">
      {patroni ? <Badge kind="accent" title="The rules live in Patroni’s dynamic configuration (DCS): a change applies to all members.">Patroni · shared configuration (DCS)</Badge>
        : okReads.length > 1 ? <Badge title="Each node has its own pg_hba.conf: the change is applied to all of them.">{okReads.length} nodes · one file per node</Badge> : <Badge title={first.hba_file}>Single node · pg_hba.conf file</Badge>}
      {first.ssl === false ? <Badge kind="warn" title="ssl=off: hostssl rules do not match until TLS is enabled.">TLS off</Badge> : null}
      <span className="small muted mono">{patroni ? 'postgresql.pg_hba' : first.hba_file}</span>
      <div className="grow" /><Button sm icon="refresh" busy={st.loading} onClick={st.load}>Reload</Button></div>

    {patroni && first.external_hba_file ? <Banner kind="bad" title="Patroni does not generate pg_hba on this cluster"><span className="mono">hba_file = {first.external_hba_file}</span> is set: Patroni ignores the DCS <span className="mono">postgresql.pg_hba</span> list, so changes made here would have no effect and are blocked. Remove <span className="mono">hba_file</span> from the Patroni configuration to manage the rules through the DCS.</Banner> : null}
    {patroni && first.dcs_seed ? <Banner kind="info" title="The Patroni DCS does not hold pg_hba yet">The rules shown are those in effect according to PostgreSQL (pg_hba_file_rules), i.e. the ones Patroni wrote from the nodes’ local configuration. On the first change they become the DCS list and from then on apply to all members.{first.seed_skipped ? ` ${nof(first.seed_skipped, 'line')} with errors ${first.seed_skipped === 1 ? 'was' : 'were'} not carried over.` : ''}</Banner> : null}
    {first.pg_down ? <Banner kind="warn" title={`PostgreSQL is not running on ${okReads[0].nodeName}`}>The DCS list can be read and edited, but the simulation against active connections and the verification run on a member with PostgreSQL running.</Banner> : null}
    {st.reads.some(r => !r.ok) ? <Banner kind="warn" title="Some nodes did not respond">{st.reads.filter(r => !r.ok).map(r => `${r.nodeName}: ${r.error}`).join(' · ')}</Banner> : null}
    {drift.length ? <Banner kind="warn" title="The nodes have different rules">{drift.map(d => d.nodeName).join(', ')} {drift.length > 1 ? 'differ' : 'differs'} from {okReads[0].nodeName}. Applying from here gives every node the same managed block; rules written by hand outside the block stay as they were.</Banner> : null}
    {probs.length ? <Banner kind="bad" title="PostgreSQL reports errors in the current file">{probs.slice(0, 3).map((p: any) => `line ${p.line_number}: ${p.error}`).join(' · ')}</Banner> : null}
    {first.has_includes ? <Banner kind="info" title="The file uses include">Rules imported with include are not analyzed here: the order shown may not reflect the whole file.</Banner> : null}

    <ClusterAccess c={c} all={all} first={first} add={add} patroni={patroni} perNode={patroni ? [] : okReads.map(r => ({ node: r.nodeName, all: [...shown, ...outsideOf(r.data).filter(x => !shown.some(y => key(y) === key(x)))] }))} />
    <Suggestions rows={shown} existing={existing} first={first} add={add} c={c} />

    <Card title="Rules managed by the console" actions={<div className="row">
      <label className="small muted" htmlFor="hba-order">Order</label>
      <select id="hba-order" className="input" style={{ width: 'auto' }} value={order} onChange={e => setOrderMode(e.target.value as Order)}>
        <option value="specific">Most specific first (recommended)</option><option value="wide">Widest network on top</option><option value="manual">Manual</option></select></div>} pad={false}>
      {order === 'wide' ? <div className="bd"><Banner kind="info" title="How ordering works">PostgreSQL uses the first rule that matches. With the widest networks on top, narrower rules below them may never be reached: they are flagged in red.</Banner></div> : null}
      {!shown.length ? <div className="bd"><Empty icon="lock" title="No managed rules">Add a rule or start from a template below. The rules already in the file stay untouched.</Empty></div> :
        <div className="tablewrap"><table className="t hba"><thead><tr><th style={{ width: 28 }} /><th>Rule</th><th>Details</th><th /></tr></thead><tbody>
          {shown.map((r, i) => <RuleLine key={r._id} r={r} n={i + 1} issues={byIndex(i)} manual={order === 'manual'} onMove={d => move(r._id, d)} onRemove={() => remove(r._id)} />)}
        </tbody></table></div>}
    </Card>

    <AddRule ck={c.id} rows={shown} existing={existing} first={first} hosts={hosts} order={order} onAdd={r => add([r])} />

    <Templates ck={c.id} tpls={tpls.data?.templates || []} sugg={sugg} env={c.environment} all={all} hosts={hosts} onAdd={rs => add(rs)} />

    {existing.length ? <Card title={patroni ? `Other rules in the DCS list (${existing.length})` : `Rules already in the file (${existing.length})`} pad={false} actions={!adopt ? <Button sm onClick={() => add(serverUnmanaged)} title="Moves them into the managed block keeping the same evaluation order: you can then edit and reorder them.">Adopt into the managed block</Button> : <span className="small muted">Evaluated after the managed block · read-only</span>}>
      <div className="tablewrap"><table className="t hba"><tbody>{existing.map((r, i) => {
        const gi = shown.length + i; const is = issues.filter(x => x.index === gi);
        return <tr key={i}><td className="num muted" style={{ width: 28 }}>{gi + 1}</td><td><div>{describe(r)}</div>{is.map((x, k) => <div key={k} className={`small ${x.level === 'error' ? 'hba-err' : 'muted'}`}>{x.message}</div>)}</td>
          <td><Badge kind={tag(r).kind}>{tag(r).label}</Badge></td><td className="mono small muted">{r.type} {r.database} {r.user} {r.address || ''} {r.method}</td></tr>;
      })}</tbody></table></div></Card> : null}

    <Card title="Check and apply">
      <div className="stack">
        {!dirty ? <p className="muted">No changes compared with what is on the {patroni ? 'cluster' : okReads.length > 1 ? 'cluster' : 'node'}.</p> : <div className="row wrap gap-s"><p className="grow" style={{ margin: 0 }}>You have unapplied changes (they stay here even if you change page). Check the effect first: the simulation verifies that no existing connection (replication and local administration) gets blocked.</p>
          <Button sm kind="ghost" onClick={() => { const m: Rule[] = (first.managed?.rules || []).map((r: any) => ({ type: r.type, database: r.database, user: r.user, address: r.address || '', method: r.method, options: r.options, comment: r.comment })); setRows(m.map(toRow)); setOrder('specific'); setPlanned(null); setApplyRes(null); setServerMoved(false); }}>Discard changes</Button></div>}
        {dirty && serverMoved ? <Banner kind="warn" title="The rules on the server changed while you were editing">Your changes have been kept. Check the effect again before applying (or discard them to start over from the current rules).</Banner> : null}
        <div className="row wrap"><Button icon="eye" busy={planning} disabled={planning || applying || errorsInDraft} onClick={doPlan}>Check the effect</Button>
          <Button kind="primary" icon="check" busy={applying} disabled={!plans || invalid || nothing || errorsInDraft || (lock.length > 0 && !force) || applying} onClick={() => setConfirmApply(true)}>{patroni ? 'Apply to the whole cluster' : okReads.length > 1 ? `Apply to ${okReads.length} nodes` : 'Apply'}</Button>
          {!patroni && first.backups?.length ? <Button icon="restore" disabled={applying} onClick={() => setRb(true)}>Restore the previous version</Button> : null}</div>
        {patroni ? <p className="small muted">Written only to the Patroni DCS (like <span className="mono">patronictl edit-config</span>): Patroni rewrites pg_hba.conf on every member and reloads; the agent verifies with PostgreSQL (pg_hba_file_rules) that the rules are in effect. The files on the nodes are never read or changed.</p> : null}
        {errorsInDraft ? <Banner kind="bad" title="There are duplicate rules">Remove the duplicates flagged in red before continuing.</Banner> : null}
        {plans ? <PlanView plans={plans} lock={lock} force={force} setForce={setForce} patroni={patroni} /> : null}
        {applyRes ? <div className="stack">{applyRes.map(a => <Banner key={a.node} kind={a.ok ? 'ok' : 'bad'} title={a.node}>{a.text}</Banner>)}</div> : null}
      </div></Card>

    {patroni ? <DcsHistory c={c} rev={first.rev} onDone={st.load} /> : null}

    <details className="card"><summary className="hd" style={{ cursor: 'pointer' }}><h2>{patroni ? (first.dcs_seed ? 'Rules in effect (from PostgreSQL)' : 'DCS list (postgresql.pg_hba)') : 'Raw file content'}</h2></summary><div className="bd"><pre className="out">{first.raw}</pre>{first.truncated ? <p className="small muted">Only the first 200,000 bytes are shown.</p> : null}</div></details>

    {confirmApply ? <Confirm title={patroni ? 'Apply to the cluster?' : 'Apply the rules?'} confirmLabel="Apply" onClose={() => setConfirmApply(false)} onConfirm={doApply} danger={lock.length > 0}>
      <p>{patroni ? `The list is written to Patroni’s dynamic configuration (DCS) and every member reloads it.${first.dcs_seed ? ' The DCS has no pg_hba list today: the rules in effect are copied into the DCS together with the change, so nothing is lost.' : ''} The current version is kept among the previous versions.` : `The managed block is written atomically on ${nof(okReads.length, 'node')}, reloaded and verified with pg_hba_file_rules. If verification fails, the previous file is put back.`}</p>
      {lock.length ? <Banner kind="bad" title="Override active">This change blocks: {lock.join('; ')}.</Banner> : null}</Confirm> : null}
    {rb ? <Confirm title="Restore the previous version?" confirmLabel="Restore" onClose={() => setRb(false)} onConfirm={doRollback}><p>The file goes back to the copy saved before the last change ({first.backups[first.backups.length - 1]}). The current version is saved before it is overwritten.</p></Confirm> : null}
  </div>;
}

function RuleLine({ r, n, issues, manual, onMove, onRemove }: { r: Row; n: number; issues: Issue[]; manual: boolean; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  const t = tag(r);
  return <tr>
    <td className="num muted">{n}</td>
    <td><div className="row wrap gap-s"><Badge kind={t.kind}>{t.label}</Badge>{untilOf(r.comment) != null ? <Badge kind="warn" title={dt(untilOf(r.comment)!)}>Temporary · {untilLabel(untilOf(r.comment)!)}</Badge> : null}<span>{describe(r)}</span></div>
      {stripUntil(r.comment) ? <div className="small muted">{stripUntil(r.comment)}</div> : null}
      {issues.map((x, k) => <div key={k} className={`small ${x.level === 'error' ? 'hba-err' : x.level === 'warn' ? 'hba-warn' : 'muted'}`}><Icon n={x.level === 'info' ? 'info' : 'alert'} s={13} /> {x.message}</div>)}</td>
    <td className="mono small muted">{r.type} {r.database} {r.user} {r.address || ''} {r.method}</td>
    <td className="num"><div className="row gap-s" style={{ justifyContent: 'flex-end' }}>
      {manual ? <><Button sm kind="ghost" aria-label="Move up" onClick={() => onMove(-1)}><Icon n="down" className="flip" /></Button><Button sm kind="ghost" aria-label="Move down" onClick={() => onMove(1)}><Icon n="down" /></Button></> : null}
      <Button sm kind="ghost" aria-label="Remove rule" onClick={onRemove}><Icon n="trash" /></Button></div></td></tr>;
}

/** Suggestions derived from live data: replication clients that no rule would currently allow. */
/** Every node -> every node: the replication user and the superuser must be accepted from each member's address, otherwise a failover,
 *  a re-clone (pg_basebackup) or a pg_rewind towards THAT member fails. Shown as a matrix with one click to add what is missing. */
function ClusterAccess({ c, all, first, add, patroni, perNode }: { c: any; all: Rule[]; first: any; add: (r: Rule[]) => number; patroni: boolean; perNode: { node: string; all: Rule[] }[] }) {
  const nodes: { name: string; host?: string }[] = (c.haState?.nodes || []).map((n: any) => ({ name: n.name, host: String(n.host || '') }));
  const facts = first?.facts || {};
  const learnt: string = (facts.replication_users || [])[0] || (first?.suggest?.replication_clients || [])[0]?.user || '';
  const CK = `hba:access:${c.id}`;
  const [replUser, setReplUser] = useDraft(CK + ':repl', learnt || 'replicator');
  const [superuser, setSuperuser] = useDraft(CK + ':su', (facts.superusers || []).includes('postgres') || !(facts.superusers || []).length ? 'postgres' : facts.superusers[0]);
  const [ssl, setSsl] = useDraft(CK + ':ssl', first?.ssl === true);
  const [extra, setExtra] = useDraft(CK + ':extra', '');
  const [open, setOpen] = useDraft(CK + ':open', false);
  const method = facts.password_encryption === 'md5' ? 'md5' : 'scram-sha-256';
  const extraNets = extra.split(/[\s,]+/).filter(Boolean);
  const needs = useMemo(() => clusterNeeds(nodes, { replUser: replUser.trim(), superuser: superuser.trim(), ssl, method, extraNets }), [JSON.stringify(nodes), replUser, superuser, ssl, method, extra]);
  const cov = useMemo(() => accessCoverage(all, needs), [all, needs]);
  // without Patroni every node has its own file: a need is covered only where EVERY node's rules cover it (the draft block is applied to all)
  const perNodeCov = useMemo(() => perNode.map(pn => ({ node: pn.node, cov: accessCoverage(pn.all, needs) })), [perNode, needs]);
  const missingOn = (need: AccessNeed) => perNodeCov.filter(pn => { const x = pn.cov.find(y => y.need === need); return x && (x.by === null || x.blocked); }).map(pn => pn.node);
  const missing = cov.filter(x => x.by === null || (perNodeCov.length > 1 && missingOn(x.need).length > 0)).map(x => x.need.rule);
  const blocked = cov.filter(x => x.blocked);
  const froms = [...new Set(needs.map(n => n.from))];
  const cell = (from: string, kind: 'replication' | 'admin') => {
    const x = cov.find(y => y.need.from === from && y.need.kind === kind); if (!x) return <span className="faint">—</span>;
    if (x.blocked) return <Badge kind="bad" title={`Rule #${x.by! + 1} rejects it: ${describe(all[x.by!])}`}>blocked by #{x.by! + 1}</Badge>;
    if (x.by === null) return <Badge kind="warn">missing</Badge>;
    const elsewhere = perNodeCov.length > 1 ? missingOn(x.need) : [];
    if (elsewhere.length) return <Badge kind="warn" title="Each node has its own pg_hba.conf: covered here, not on every node">missing on {elsewhere.join(', ')}</Badge>;
    return <Badge kind="ok" title={describe(all[x.by])}>rule #{x.by + 1}</Badge>;
  };
  const noAddr = nodes.filter(n => !n.host || !/^[0-9a-fA-F.:]+$/.test(String(n.host).split('/')[0]));
  if (!nodes.length) return null;
  const kind = blocked.length ? 'bad' : missing.length ? 'warn' : 'ok';
  const title = blocked.length ? `${nof(blocked.length, 'cluster-internal connection')} ${blocked.length === 1 ? 'is' : 'are'} rejected by a rule above ${blocked.length === 1 ? 'it' : 'them'}` : missing.length ? `${nof(missing.length, 'rule')} missing for the nodes to reach each other` : 'Every node can replicate from and administer every other node';
  return <Card title="Cluster access (every node → every node)" actions={<Button sm kind="ghost" onClick={() => setOpen(!open)}>{open ? 'Hide settings' : 'Settings'}</Button>}>
    <div className="stack">
      <Banner kind={kind} title={title} actions={missing.length ? <Button sm kind="primary" icon="plus" onClick={() => { const n = add(missing); if (n) toast(`${nof(n, 'rule')} added to the managed block: check the effect, then apply`, 'ok'); }}>{missing.length === 1 ? 'Add the missing rule' : `Add the ${missing.length} missing rules`}</Button> : undefined}>
        <span>Any member can become the primary, be re-cloned or re-aligned with pg_rewind: the replication user <strong>{replUser || '?'}</strong>{superuser ? <> and the superuser <strong>{superuser}</strong></> : null} must be accepted from the address of every member, with one explicit /32 per node ({ssl ? 'TLS only, ' : ''}{method}).{patroni ? ' Under Patroni the list is one for the whole cluster, written to the DCS.' : ' Without Patroni the managed block is applied to every node.'}</span>
      </Banner>
      {open ? <div className="grid g3">
        <Field label="Replication user" hint={learnt ? `Seen replicating today: ${(facts.replication_users || []).join(', ')}` : 'The user in primary_conninfo (Patroni: postgresql.authentication.replication.username)'}><input className="input mono" value={replUser} onChange={e => setReplUser(e.target.value)} /></Field>
        <Field label="Superuser (empty = none)" hint={(facts.superusers || []).length ? `Superusers on the cluster: ${facts.superusers.join(', ')}` : undefined}><input className="input mono" value={superuser} onChange={e => setSuperuser(e.target.value)} /></Field>
        <Field label="Extra networks (CIDR, optional)" hint="For nodes that reach the cluster through another address (NAT, a second interface)"><input className="input mono" value={extra} onChange={e => setExtra(e.target.value)} placeholder="10.0.5.0/24" /></Field>
        <label className="check"><input type="checkbox" checked={ssl} onChange={e => setSsl(e.target.checked)} /><span>TLS only (hostssl){first?.ssl === false ? <span className="small muted"> — ssl is off on the server: hostssl rules would not match until it is enabled</span> : null}</span></label>
      </div> : null}
      <div className="tablewrap"><table className="t small"><thead><tr><th>From node</th><th>Address</th><th>Replication ({replUser || '—'})</th><th>Administration ({superuser || '—'})</th></tr></thead><tbody>
        {froms.map(f => { const n = nodes.find(x => x.name === f); return <tr key={f}><td><strong>{f}</strong></td><td className="mono">{n ? n.host : f}</td><td>{cell(f, 'replication')}</td><td>{superuser ? cell(f, 'admin') : <span className="faint">—</span>}</td></tr>; })}
        {noAddr.map(n => <tr key={n.name}><td><strong>{n.name}</strong></td><td className="mono muted">{n.host || 'address unknown'}</td><td colSpan={2}><span className="small muted">{n.host ? 'a host name: add its address under Extra networks to get an explicit rule' : 'the console does not know this node’s address yet'}</span></td></tr>)}
      </tbody></table></div>
    </div></Card>;
}

function Suggestions({ rows, existing, first, add, c }: { rows: Rule[]; existing: Rule[]; first: any; add: (r: Rule[]) => number; c: any }) {
  const cur = [...rows, ...existing];
  const plc = first.patroni_local;
  const local: Rule[] = (plc?.ok === false ? (plc.denied as string[]) : []).map(u => ({ type: 'host', database: 'replication', user: u, address: '127.0.0.1/32', method: 'scram-sha-256', comment: 'Patroni: local replication connection (replica timelines, pg_rewind)' }))
    .filter(r => !cur.some(e => covers(e, r) && e.method !== 'reject'));
  const patroniBanner = local.length ? <Banner kind="bad" icon="alert" title="Patroni cannot open the local replication connection" actions={<Button sm onClick={() => add(local)}>Add the rule</Button>}>
    <span>Patroni reads the replicas’ timeline through a replication connection on 127.0.0.1 ({local.map(r => r.user).join(', ')}). Without this rule, after a failover a replica that is ahead is not realigned with pg_rewind and stays stuck; on a standby site the whole site stalls.</span></Banner> : null;
  const items = ((first.suggest?.replication_clients || []) as any[]).map(x => {
    const addr = String(x.address).split('/')[0]; const ip = addr.includes(':') ? `${addr}/128` : `${addr}/32`;
    const rule: Rule = { type: x.ssl ? 'hostssl' : 'host', database: 'replication', user: x.user, address: ip, method: 'scram-sha-256', comment: `Replication from ${addr}` };
    return { rule, ok: cur.some(e => covers(e, rule) && e.method !== 'reject') };
  }).filter(x => !x.ok);
  if (!items.length) return patroniBanner;
  return <>{patroniBanner}<Banner kind="warn" icon="zap" title="Active replicas without an explicit rule" actions={<Button sm onClick={() => add(items.map(i => i.rule))}>Add {items.length > 1 ? 'all' : ''}</Button>}>
    <span>{items.map(i => `${i.rule.user} from ${i.rule.address.replace(/\/\d+$/, '')}`).join(', ')}. They connect today because a broader or manual rule covers them; with a precise rule they stay covered even if that one changes.</span></Banner></>;
}

function AddRule({ ck, rows, existing, first, hosts, order, onAdd }: { ck: string; rows: Row[]; existing: Rule[]; first: any; hosts: string[]; order: Order; onAdd: (r: Rule) => void }) {
  const [open, setOpen] = useDraft(`hba:add:${ck}:open`, false); const [valid, setValid] = useDraft(`hba:add:${ck}:valid`, '0'); const canTemp = true;
  const blank: Rule = { type: 'hostssl', database: 'all', user: '', address: '', method: 'scram-sha-256', comment: '' };
  const [r, setR] = useDraft<Rule>(`hba:add:${ck}:rule`, blank);
  const set = (p: Partial<Rule>) => setR(x => {
    const n = { ...x, ...p };
    if (p.type === 'local') { n.address = ''; if (n.method === 'scram-sha-256') n.method = 'peer'; }
    if (p.type && p.type !== 'local' && n.method === 'peer') n.method = 'scram-sha-256';
    return n;
  });
  const dbs: string[] = ['all', 'replication', ...(first.suggest?.databases || [])]; const users: string[] = ['all', ...(first.suggest?.roles || [])];
  const addrErr = r.type === 'local' ? null : !r.address ? 'Enter an address or a network.' : r.address === 'all' || validCidr(r.address) || ['samehost', 'samenet'].includes(r.address) ? null : 'Use CIDR notation, for example 10.0.20.0/24 (a single host: 10.0.20.5/32).';
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
  if (!open) return <div><Button icon="plus" onClick={() => setOpen(true)}>Add a rule</Button></div>;
  return <Card title="New rule" actions={<Button sm kind="ghost" onClick={() => setOpen(false)} aria-label="Close"><Icon n="x" /></Button>}>
    <div className="stack">
      <div className="grid g3">
        <Field label="Connection type"><select className="input" value={r.type} onChange={e => set({ type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Database" hint="“replication” = physical replication; “all” does not include it."><input className="input" list="hba-dbs" value={r.database} onChange={e => set({ database: e.target.value })} /><datalist id="hba-dbs">{dbs.map(d => <option key={d} value={d} />)}</datalist></Field>
        <Field label="User or group" hint="For a group, write +rolename."><input className="input" list="hba-users" value={r.user} onChange={e => set({ user: e.target.value })} placeholder="app" /><datalist id="hba-users">{users.map(d => <option key={d} value={d} />)}{(first.suggest?.roles || []).map((u: string) => <option key={'+' + u} value={'+' + u} />)}</datalist></Field>
        {r.type !== 'local' ? <Field label="Source network (CIDR)" error={r.address ? addrErr : null} hint="The narrower, the better."><input className="input mono" value={r.address} onChange={e => set({ address: e.target.value.trim() })} placeholder="10.0.20.0/24" />
          {nets.length ? <div className="row wrap gap-s" style={{ marginTop: 4 }}>{nets.map(n => <button key={n} type="button" className="chip" onClick={() => set({ address: n })}>{n}</button>)}</div> : null}</Field> : null}
        <Field label="Authentication"><select className="input" value={r.method} onChange={e => set({ method: e.target.value })}>{METHODS.filter(([m]) => r.type === 'local' || m !== 'peer').map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Note (for you only)"><input className="input" value={r.comment || ''} onChange={e => set({ comment: e.target.value })} placeholder="What it is for" maxLength={120} /></Field>
        {canTemp ? <Field label="Validity" hint="A temporary rule is removed automatically when it expires (access for a consultant, a maintenance job).">
          <select className="input" value={valid} onChange={e => setValid(e.target.value)} aria-label="Rule validity"><option value="0">Permanent</option><option value="1">1 hour</option><option value="8">8 hours</option><option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option></select></Field> : null}
      </div>
      {ready ? <div className="hba-preview"><Icon n="eye" /> {describe(cand)}</div> : null}
      {adv.map((a, i) => <div key={i} className={a.kind === 'bad' ? 'hba-err' : a.kind === 'warn' ? 'hba-warn' : 'muted small'}><Icon n={a.kind === 'info' ? 'info' : 'alert'} s={14} /> {a.text}</div>)}
      {preview.issues.map((x, i) => <div key={i} className={x.level === 'error' ? 'hba-err' : x.level === 'warn' ? 'hba-warn' : 'muted small'}><Icon n="alert" s={14} /> {x.message}</div>)}
      <div className="row"><Button kind="primary" icon="plus" disabled={!ready || dup || advice(cand).some(a => a.kind === 'bad')} onClick={() => { onAdd(cand); setR(blank); setValid('0'); }}>Add to the list</Button>
        <span className="small muted">Nothing is written until you check and apply.</span></div>
    </div></Card>;
}

function Templates({ ck, tpls, sugg, env, all, hosts, onAdd }: { ck: string; tpls: Tpl[]; sugg: string[]; env: string; all: Rule[]; hosts: string[]; onAdd: (r: Rule[]) => number }) {
  const [sel, setSel] = useDraft<Tpl | null>(`hba:tpl:${ck}:sel`, null); const [vars, setVars] = useDraft<Record<string, string>>(`hba:tpl:${ck}:vars`, {});
  const ordered = useMemo(() => [...tpls].sort((a, b) => (sugg.includes(a.id) ? sugg.indexOf(a.id) : 99) - (sugg.includes(b.id) ? sugg.indexOf(b.id) : 99)), [tpls, sugg]);
  const present = (t: Tpl) => { const defaults = Object.fromEntries(t.vars.map(v => [v.key, v.def])); const rs = fill(t, defaults); return rs.length > 0 && rs.every(r => all.some(e => key(e) === key(r) || (covers(e, r) && e.method === r.method))); };
  const open = (t: Tpl) => { const v: Record<string, string> = {}; const net = hosts[0]?.replace(/\.\d+$/, '.0/24'); t.vars.forEach(x => { v[x.key] = x.key === 'replNet' && net ? net : x.def; }); setVars(v); setSel(t); };
  const rules = sel ? fill(sel, vars) : [];
  const errs = sel ? sel.vars.filter(v => /net$/i.test(v.key) && !validCidr(vars[v.key] || '')).map(v => v.label) : [];
  if (!ordered.length) return null;
  return <Card title="Templates" actions={<span className="small muted">Suggested for the <strong>{env}</strong> environment first</span>}>
    <div className="grid g3">{ordered.map(t => { const pr = present(t); return <div key={t.id} className="tpl">
      <div className="row"><strong className="grow">{t.name}</strong>{sugg.includes(t.id) ? <Badge kind="accent">Recommended</Badge> : null}</div>
      <p className="small muted" style={{ margin: '6px 0 10px' }}>{t.description}</p>
      <div className="row">{pr ? <Badge kind="ok" title="The template’s rules with the default values are already covered by existing rules.">Already present</Badge> : null}<div className="grow" /><Button sm icon="plus" onClick={() => open(t)}>{pr ? 'Add anyway' : 'Use'}</Button></div></div>; })}</div>
    {sel ? <Modal title={sel.name} onClose={() => setSel(null)} footer={<><Button onClick={() => setSel(null)}>Cancel</Button><Button kind="primary" disabled={!!errs.length} onClick={() => { const n = onAdd(rules); setSel(null); if (n) toast(`${nof(n, 'rule')} added to the list`, 'ok'); }}>Add to the list</Button></>}>
      <div className="stack"><p className="muted">{sel.description}</p>
        {sel.vars.map(v => <Field key={v.key} label={v.label} hint={v.hint} error={/net$/i.test(v.key) && !validCidr(vars[v.key] || '') ? 'CIDR notation, for example 10.0.20.0/24' : null}><input className="input" value={vars[v.key] || ''} onChange={e => setVars({ ...vars, [v.key]: e.target.value.trim() })} /></Field>)}
        <div className="stack">{rules.map((r, i) => <div key={i} className="hba-preview"><Badge kind={tag(r).kind}>{tag(r).label}</Badge> {describe(r)}</div>)}</div>
      </div></Modal> : null}
  </Card>;
}

function PlanView({ plans, lock, force, setForce, patroni }: { plans: { node: string; res?: any; error?: string }[]; lock: string[]; force: boolean; setForce: (v: boolean) => void; patroni?: boolean }) {
  const p0 = plans.find(p => p.res?.valid && p.res?.diff?.length) || plans[0];
  const warns = plans.flatMap(p => (p.res?.warnings || []).map((w: any) => w.message));
  return <div className="stack">
    {plans.filter(p => p.error || p.res?.valid === false).map(p => <Banner key={p.node} kind="bad" title={`${p.node}: invalid rules`}>{p.error || (p.res.errors || []).map((e: any) => `#${e.index + 1}: ${e.message}`).join(' · ')}</Banner>)}
    {lock.length ? <Banner kind="bad" title="This change would block connections in use">{lock.join(' · ')}
      <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} />I know what I am doing: apply anyway</label></Banner> : null}
    {warns.length ? <Banner kind="warn" title="Warnings">{[...new Set(warns)].join(' · ')}</Banner> : null}
    {plans.every(p => p.res?.changed === false) ? <Banner kind="ok" title="No differences">The current rules already match the list.</Banner> : null}
    {p0?.res?.simulation?.length ? <div className="tablewrap"><table className="t"><thead><tr><th>Simulated connection</th><th>Before</th><th>After</th></tr></thead><tbody>
      {p0.res.simulation.map((s: any, i: number) => <tr key={i}><td>{s.label}</td><td>{s.before ? <Badge kind="ok">allowed</Badge> : <Badge>rejected</Badge>}</td><td>{s.after ? <Badge kind="ok">allowed</Badge> : <Badge kind={s.before ? 'bad' : undefined}>rejected</Badge>}{s.uncertain ? <span className="small muted"> (uncertain)</span> : null}</td></tr>)}</tbody></table></div> : null}
    {p0?.res?.diff?.length ? <details open><summary className="small muted" style={{ cursor: 'pointer' }}>{patroni ? 'Differences in the DCS list (postgresql.pg_hba)' : 'Differences in the file'}</summary><pre className="out">{p0.res.diff.join('\n')}</pre></details> : null}
  </div>;
}

/** Patroni: the DCS keeps only the current list; the console keeps the previous ones (each change made from here) so a change can be undone. */
function DcsHistory({ c, rev, onDone }: { c: any; rev: string; onDone: () => void }) {
  const h = useQuery<{ history: { index: number; at: string; by: string; seed: boolean; kind: string; rules: number; list: string[] }[] }>(`/api/clusters/${encodeURIComponent(c.id)}/hba/history`);
  const [pick, setPick] = useState<any>(null); const [busy, setBusy] = useState(false); const [force, setForce] = useState(false); const [err, setErr] = useState<string | null>(null);
  const items = h.data?.history || [];
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const r: any = await api('POST', `/api/clusters/${encodeURIComponent(c.id)}/hba/restore`, { index: pick.index, baseRev: rev, force }, { key: uid('hbarst') });
      if (r.approval) { toast('Request sent: another administrator must approve it (Today page).', 'info', 9000); setPick(null); return; }
      await waitOp(r.operation); toast('Version restored in the DCS and verified', 'ok'); setPick(null); revalidate(`/api/clusters/${encodeURIComponent(c.id)}/hba/history`); onDone();
    } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Card title="Previous versions" actions={<span className="small muted">Kept by the console · last 15</span>} pad={false}>
    {!items.length ? <div className="bd"><p className="muted small">No changes made from here yet. After each change the previous list stays available to go back.</p></div> :
      <div className="tablewrap"><table className="t"><thead><tr><th>Replaced on</th><th>By</th><th className="num">Rules</th><th /></tr></thead><tbody>
        {items.map(x => <tr key={x.index}><td>{dt(x.at)} <span className="faint small">({ago(x.at)})</span>{x.seed ? <Badge title="Rules in effect before the list was in the DCS">before the DCS</Badge> : null}</td><td>{x.by}</td><td className="num">{x.rules}</td>
          <td className="num"><Button sm icon="restore" onClick={() => { setPick(x); setForce(false); setErr(null); }}>Restore…</Button></td></tr>)}</tbody></table></div>}
    {pick ? <Modal title="Restore this version?" onClose={() => setPick(null)} footer={<><div className="grow" /><Button onClick={() => setPick(null)}>Cancel</Button><Button kind="primary" busy={busy} onClick={go}>Restore in the DCS</Button></>}>
      <div className="stack"><p>The list replaced on {dt(pick.at)} goes back into the Patroni DCS and every member reloads it. Before writing, the agent checks that no active connection (replicas, local administration) gets blocked; the current list is kept among the previous versions.</p>
        <pre className="out">{pick.list.join('\n')}</pre>
        {err ? <Banner kind="bad">{err}{/lock out/.test(err) ? <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} />I know what I am doing: restore anyway</label> : null}</Banner> : null}</div></Modal> : null}
  </Card>;
}
