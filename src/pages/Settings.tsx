import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Field, Skeleton, ago } from '../ui';
import { revalidate, toast, useQuery } from '../hooks';

const ENV_LABEL: Record<string, string> = { prod: 'Produzione', prep: 'Pre-produzione', int: 'Integrazione', dev: 'Sviluppo', test: 'Test' };
const SEV_LABEL: Record<string, string> = { critical: 'Solo urgenti', warning: 'Urgenti e da controllare', info: 'Tutto' };

export function SettingsPage() {
  return <>
    <div className="pagehead"><div className="grow"><h1>Impostazioni</h1><p className="sub">Avvisi e controlli di sicurezza della console. Le impostazioni predefinite non cambiano il comportamento: attiva solo ciò che ti serve.</p></div></div>
    <Notifications /><Enrollment /><Approvals />
  </>;
}

type Hook = { id?: string; name: string; url?: string; urlMasked?: string; format: 'generic' | 'slack'; minSeverity: string; enabled: boolean; lastOk?: string; lastError?: string; open?: number };

function Notifications() {
  const q = useQuery<{ reminderHours: number; webhooks: Hook[] }>('/api/notifications');
  const [list, setList] = useState<Hook[] | null>(null); const [rem, setRem] = useState(24); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (q.data && list === null) { setList(q.data.webhooks); setRem(q.data.reminderHours); } }, [q.data, list]);
  const set = (i: number, p: Partial<Hook>) => setList(l => l!.map((w, j) => (j === i ? { ...w, ...p } : w)));
  const save = async () => { setBusy(true); setErr(null); try {
    const r: any = await api('PUT', '/api/notifications', { reminderHours: rem, webhooks: list!.map(w => ({ id: w.id, name: w.name, url: w.url, format: w.format, minSeverity: w.minSeverity, enabled: w.enabled })) });
    setList(r.webhooks); setRem(r.reminderHours); revalidate('/api/notifications'); toast('Notifiche salvate', 'ok');
  } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  const test = async (w: Hook) => { try { await api('POST', '/api/notifications/test', { id: w.id }); toast('Messaggio di prova consegnato', 'ok'); } catch (e: any) { toast(e.body?.error ? `Consegna fallita: ${e.body.error}` : e.message, 'bad'); } };
  return <Card title="Notifiche">
    <p className="small muted" style={{ marginTop: 0 }}>Un messaggio quando compare un problema, un promemoria se resta aperto, uno quando si risolve.</p>
    {!list ? <Skeleton h={60} /> : <div className="stack">
      {list.length === 0 ? <p className="muted small">Nessun canale. Aggiungi un webhook (Slack, Teams, Mattermost o qualunque servizio che accetta JSON).</p> : null}
      {list.map((w, i) => <div key={w.id || i} className="card" style={{ padding: 12 }}><div className="stack">
        <div className="row"><Field label="Nome"><input className="input" value={w.name} onChange={e => set(i, { name: e.target.value })} aria-label="Nome del canale" /></Field>
          <Field label="Formato"><select className="input" value={w.format} onChange={e => set(i, { format: e.target.value as any })}><option value="slack">Testo (Slack, Teams, Mattermost)</option><option value="generic">JSON completo</option></select></Field>
          <Field label="Cosa inviare"><select className="input" value={w.minSeverity} onChange={e => set(i, { minSeverity: e.target.value })}>{Object.entries(SEV_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field></div>
        <Field label="Indirizzo del webhook" hint={w.id ? 'Per sicurezza non viene mostrato per intero: lascia vuoto per mantenerlo.' : 'Contiene spesso un segreto: resta solo sul server.'}>
          <input className="input mono" placeholder={w.urlMasked || 'https://hooks.example.com/…'} value={w.url ?? ''} onChange={e => set(i, { url: e.target.value || undefined })} aria-label="Indirizzo del webhook" /></Field>
        <div className="row"><label className="check"><input type="checkbox" checked={w.enabled} onChange={e => set(i, { enabled: e.target.checked })} />Attivo</label>
          {w.lastError ? <Badge kind="bad" title={w.lastError}>Ultimo invio fallito</Badge> : w.lastOk ? <Badge kind="ok">Ultimo invio {ago(w.lastOk)}</Badge> : null}
          <div className="grow" />{w.id ? <Button sm onClick={() => test(w)}>Invia prova</Button> : null}<Button sm kind="ghost" onClick={() => setList(l => l!.filter((_, j) => j !== i))}>Rimuovi</Button></div></div></div>)}
      <div className="row"><Button icon="plus" onClick={() => setList(l => [...(l || []), { name: '', url: '', format: 'slack', minSeverity: 'warning', enabled: true }])}>Aggiungi canale</Button><div className="grow" />
        <label className="small muted">Ricorda i problemi aperti ogni <input className="input" type="number" min={1} max={720} style={{ width: 70, display: 'inline-block' }} value={rem} onChange={e => setRem(Number(e.target.value))} aria-label="Ore tra i promemoria" /> ore</label>
        <Button kind="primary" busy={busy} onClick={save}>Salva</Button></div>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div>}
  </Card>;
}

function Enrollment() {
  const q = useQuery<{ joinRequests: boolean }>('/api/advanced'); const [busy, setBusy] = useState(false);
  const set = async (on: boolean) => { setBusy(true); try { await api('PUT', '/api/advanced', { joinRequests: on }); revalidate('/api/advanced'); toast(on ? 'Annuncio automatico attivo' : 'Annuncio automatico disattivato', 'ok'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setBusy(false); } };
  return <Card title="Nuovi server">
    <p className="small muted" style={{ marginTop: 0 }}>Un agent installato senza token si annuncia alla console e resta in attesa: tu decidi se aggiungerlo. Non riceve alcun accesso finché non approvi. Le richieste senza risposta scadono dopo 48 ore.</p>
    {!q.data ? <Skeleton h={30} /> : <label className="check"><input type="checkbox" disabled={busy} checked={q.data.joinRequests} onChange={e => set(e.target.checked)} />Accetta richieste di adesione dai server (consigliato nella rete interna)</label>}
    <p className="small muted">Se la console è raggiungibile da reti non fidate, disattiva l’opzione e usa i token di iscrizione monouso.</p>
  </Card>;
}

function Approvals() {
  const q = useQuery<{ approvals: Record<string, boolean>; environments: string[]; activeAdmins: number }>('/api/advanced');
  const [busy, setBusy] = useState(false);
  const toggle = async (env: string, on: boolean) => { if (!q.data) return; setBusy(true); try { await api('PUT', '/api/advanced', { approvals: { ...q.data.approvals, [env]: on } }); revalidate('/api/advanced'); toast(on ? `Approvazioni attive su ${ENV_LABEL[env]}` : `Approvazioni disattivate su ${ENV_LABEL[env]}`, 'ok'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setBusy(false); } };
  const d = q.data;
  return <Card title="Approvazione a due persone">
    <p className="small muted" style={{ marginTop: 0 }}>Sugli ambienti scelti, le azioni rischiose partono solo dopo il via libera di un altro amministratore.</p>
    {!d ? <Skeleton h={60} /> : <div className="stack">
      <p className="small muted">Sono rischiose: modifica delle regole di accesso, cambio dei parametri, switchover e failover, sostituzione di una tabella, recupero di righe. Backup, verifiche e ripristini in cartelle separate non richiedono approvazione. La richiesta scade dopo 24 ore.</p>
      {d.activeAdmins < 2 ? <Banner kind="warn" title="Serve un secondo amministratore">Con un solo amministratore attivo non è possibile attivare le approvazioni: nessuno potrebbe concederle. Crea un altro amministratore nella pagina Utenti.</Banner> : null}
      <div className="stack">{d.environments.map(env => <label key={env} className="check"><input type="checkbox" disabled={busy || (!d.approvals[env] && d.activeAdmins < 2)} checked={!!d.approvals[env]} onChange={e => toggle(env, e.target.checked)} />{ENV_LABEL[env] || env}{env === 'prod' ? <span className="small muted"> (consigliato)</span> : null}</label>)}</div></div>}
  </Card>;
}
