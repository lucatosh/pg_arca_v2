import React, { useState } from 'react';
import { Banner, Button, Confirm } from '../ui';
import { useOpRunner } from '../hooks';
import { OpPanel } from './shared';
import { itCheck } from '../i18n';

/** «Riavvia PostgreSQL» for a STANDALONE instance (Patroni members restart through Patroni). The agent first says HOW it would do it
 *  (the server's own systemd unit, or pg_ctl where there is no systemd), then the typed confirmation, then the result with what is still pending. */
export function RestartPg({ c, label = 'Riavvia PostgreSQL', onDone }: { c: any; label?: string; onDone?: () => void }) {
  const plan = useOpRunner(c.id); const run = useOpRunner(c.id, onDone); const [ask, setAsk] = useState(false);
  if (c.haState?.managedByPatroni || c.source === 'direct' || c.isSandbox) return null;
  const p = plan.op?.status === 'succeeded' ? plan.op.result?.plan : null;
  const how = p ? (p.method === 'systemd' ? <>con il servizio del server: <code>systemctl restart {p.unit}</code></> : p.method === 'pg_ctl' ? <>con <code>pg_ctl restart -m fast</code> (nessun servizio systemd lo gestisce)</> : null) : null;
  const res = run.op?.status === 'succeeded' ? run.op.result : null;
  return <div className="stack">
    <div className="row wrap"><Button icon="refresh" busy={plan.busy || run.busy} onClick={async () => { const o = await plan.run('pg_restart', { dry_run: true }); if (o?.status === 'succeeded' && o.result?.plan?.method !== 'refuse') setAsk(true); }}>{label}</Button></div>
    {p?.method === 'refuse' ? <Banner kind="warn" title="Riavvio da qui non possibile">{itCheck(p.why)}</Banner> : null}
    {plan.op?.status === 'failed' ? <OpPanel op={plan.op} error={plan.error} /> : null}
    {(run.op || run.error) && !res ? <OpPanel op={run.op} error={run.error} label="Riavvio di PostgreSQL" /> : null}
    {res ? <Banner kind={(res.pending_restart || []).length ? 'warn' : 'ok'} title="PostgreSQL riavviato">Fatto {res.unit ? <>con <code>{res.unit}</code></> : 'con pg_ctl'}. {(res.pending_restart || []).length ? <>Ancora in attesa di riavvio: {res.pending_restart.join(', ')}.</> : (res.pending_before || []).length ? <>Ora in vigore: {res.pending_before.join(', ')}.</> : null}</Banner> : null}
    {ask ? <Confirm title="Riavviare PostgreSQL?" danger requireText="RIAVVIA" confirmLabel="Riavvia" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); run.run('pg_restart', { confirm: 'RIAVVIA' }); }}>
      <p>Tutte le connessioni vengono chiuse e il database resta irraggiungibile per qualche secondo (le transazioni in corso vengono annullate). Il riavvio avviene {how || 'nel modo in cui il server è gestito'}.</p>
      <p className="small muted">Se l’agent non ha il permesso di riavviare il servizio, l’operazione si ferma senza toccare nulla e indica la regola da aggiungere (o il comando da eseguire a mano).</p></Confirm> : null}
  </div>;
}
