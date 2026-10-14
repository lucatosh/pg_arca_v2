import React, { useState } from 'react';
import { Banner, Button, Confirm } from '../ui';
import { toast, useOpRunner } from '../hooks';
import { OpPanel } from './shared';
import { itCheck } from '../i18n';

/** «Riavvia PostgreSQL» for a STANDALONE instance (Patroni members restart through Patroni). The agent first says HOW it would do it
 *  (the server's own systemd unit, or pg_ctl where there is no systemd), then the typed confirmation, then the result with what is still pending. */
export function RestartPg({ c, label = 'Restart PostgreSQL', onDone }: { c: any; label?: string; onDone?: () => void }) {
  const [ask, setAsk] = useState(false);
  // the plan runs on the agent: the confirmation opens when it has ANSWERED (run() returns the submitted operation, not its outcome)
  const plan = useOpRunner(c.id, o => { if (o.status === 'succeeded' && o.result?.plan?.method !== 'refuse' && o.result?.plan?.allowed !== false) setAsk(true); }); const run = useOpRunner(c.id, o => { if (o.status === 'succeeded') toast(`PostgreSQL restarted${o.result?.unit ? ` (${o.result.unit})` : ''}`, 'ok'); onDone?.(); });   // the card that asked may disappear at once: the toast stays
  if (c.haState?.managedByPatroni || c.source === 'direct' || c.isSandbox) return null;
  const p = plan.op?.status === 'succeeded' ? plan.op.result?.plan : null;
  const how = p ? (p.method === 'systemd' ? <>through the server’s service: <code>systemctl restart {p.unit}</code></> : p.method === 'pg_ctl' ? <>with <code>pg_ctl restart -m fast</code> (no systemd service manages it)</> : null) : null;
  const res = run.op?.status === 'succeeded' ? run.op.result : null;
  return <div className="stack">
    <div className="row wrap"><Button icon="refresh" busy={plan.busy || run.busy} onClick={() => { plan.run('pg_restart', { dry_run: true }); }}>{label}</Button></div>
    {p?.method === 'refuse' ? <Banner kind="warn" title="Restart from here not possible">{itCheck(p.why)}</Banner> : null}
    {p && p.allowed === false ? <Banner kind="warn" title="The agent is not allowed to restart the service">{itCheck(p.why)}{p.manual ? <div style={{ marginTop: 6 }}>Command to run on the server: <code>{p.manual}</code></div> : null}</Banner> : null}
    {plan.op?.status === 'failed' ? <OpPanel op={plan.op} error={plan.error} /> : null}
    {(run.op || run.error) && !res ? <OpPanel op={run.op} error={run.error} label="PostgreSQL restart" /> : null}
    {res ? <Banner kind={(res.pending_restart || []).length ? 'warn' : 'ok'} title="PostgreSQL restarted">Done {res.unit ? <>with <code>{res.unit}</code></> : 'with pg_ctl'}. {(res.pending_restart || []).length ? <>Still pending a restart: {res.pending_restart.join(', ')}.</> : (res.pending_before || []).length ? <>Now in effect: {res.pending_before.join(', ')}.</> : null}</Banner> : null}
    {ask ? <Confirm title="Restart PostgreSQL?" danger requireText="RESTART" confirmLabel="Restart" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); run.run('pg_restart', { confirm: 'RESTART' }); }}>
      <p>All connections are closed and the database is unreachable for a few seconds (running transactions are rolled back). The restart happens {how || 'the way the server is managed'}.</p>
      <p className="small muted">If the agent is not allowed to restart the service, the operation stops without touching anything and shows the rule to add (or the command to run by hand).</p></Confirm> : null}
  </div>;
}
