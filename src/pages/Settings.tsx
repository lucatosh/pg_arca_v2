import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Field, Skeleton, ago } from '../ui';
import { revalidate, toast, useQuery, useDraft } from '../hooks';

const ENV_LABEL: Record<string, string> = { prod: 'Production', prep: 'Pre-production', int: 'Integration', dev: 'Development', test: 'Test' };
const SEV_LABEL: Record<string, string> = { critical: 'Urgent only', warning: 'Urgent and needs attention', info: 'Everything' };

export function SettingsPage() {
  return <>
    <div className="pagehead"><div className="grow"><h1>Settings</h1><p className="sub">Console alerts and safety controls. The defaults do not change the behavior: enable only what you need.</p></div></div>
    <ConsoleAddress /><Notifications /><Enrollment /><Approvals />
  </>;
}

type Hook = { id?: string; name: string; url?: string; urlMasked?: string; format: 'generic' | 'slack'; minSeverity: string; enabled: boolean; lastOk?: string; lastError?: string; open?: number };

function Notifications() {
  const q = useQuery<{ reminderHours: number; webhooks: Hook[] }>('/api/notifications');
  const [list, setList] = useDraft<Hook[] | null>('settings:notify:list', null, { secret: true }); const [rem, setRem] = useDraft('settings:notify:rem', 24); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);   // webhook URLs can carry tokens: memory only
  useEffect(() => { if (q.data && list === null) { setList(q.data.webhooks); setRem(q.data.reminderHours); } }, [q.data, list]);
  const set = (i: number, p: Partial<Hook>) => setList(l => l!.map((w, j) => (j === i ? { ...w, ...p } : w)));
  const save = async () => { setBusy(true); setErr(null); try {
    const r: any = await api('PUT', '/api/notifications', { reminderHours: rem, webhooks: list!.map(w => ({ id: w.id, name: w.name, url: w.url, format: w.format, minSeverity: w.minSeverity, enabled: w.enabled })) });
    setList(r.webhooks); setRem(r.reminderHours); revalidate('/api/notifications'); toast('Notifications saved', 'ok');
  } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  const test = async (w: Hook) => { try { await api('POST', '/api/notifications/test', { id: w.id }); toast('Test message delivered', 'ok'); } catch (e: any) { toast(e.body?.error ? `Delivery failed: ${e.body.error}` : e.message, 'bad'); } };
  return <Card title="Notifications">
    <p className="small muted" style={{ marginTop: 0 }}>A message when a problem appears, a reminder while it stays open, and one when it is resolved.</p>
    {!list ? <Skeleton h={60} /> : <div className="stack">
      {list.length === 0 ? <p className="muted small">No channels. Add a webhook (Slack, Teams, Mattermost or any service that accepts JSON).</p> : null}
      {list.map((w, i) => <div key={w.id || i} className="card" style={{ padding: 12 }}><div className="stack">
        <div className="row"><Field label="Name"><input className="input" value={w.name} onChange={e => set(i, { name: e.target.value })} aria-label="Channel name" /></Field>
          <Field label="Format"><select className="input" value={w.format} onChange={e => set(i, { format: e.target.value as any })}><option value="slack">Text (Slack, Teams, Mattermost)</option><option value="generic">Full JSON</option></select></Field>
          <Field label="What to send"><select className="input" value={w.minSeverity} onChange={e => set(i, { minSeverity: e.target.value })}>{Object.entries(SEV_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field></div>
        <Field label="Webhook URL" hint={w.id ? 'For security it is not shown in full: leave empty to keep it.' : 'It often contains a secret: it stays on the server only.'}>
          <input className="input mono" placeholder={w.urlMasked || 'https://hooks.example.com/…'} value={w.url ?? ''} onChange={e => set(i, { url: e.target.value || undefined })} aria-label="Webhook URL" /></Field>
        <div className="row"><label className="check"><input type="checkbox" checked={w.enabled} onChange={e => set(i, { enabled: e.target.checked })} />Enabled</label>
          {w.lastError ? <Badge kind="bad" title={w.lastError}>Last delivery failed</Badge> : w.lastOk ? <Badge kind="ok">Last delivery {ago(w.lastOk)}</Badge> : null}
          <div className="grow" />{w.id ? <Button sm onClick={() => test(w)}>Send test</Button> : null}<Button sm kind="ghost" onClick={() => setList(l => l!.filter((_, j) => j !== i))}>Remove</Button></div></div></div>)}
      <div className="row"><Button icon="plus" onClick={() => setList(l => [...(l || []), { name: '', url: '', format: 'slack', minSeverity: 'warning', enabled: true }])}>Add channel</Button><div className="grow" />
        <label className="small muted">Remind about open problems every <input className="input" type="number" min={1} max={720} style={{ width: 70, display: 'inline-block' }} value={rem} onChange={e => setRem(Number(e.target.value))} aria-label="Hours between reminders" /> hours</label>
        <Button kind="primary" busy={busy} onClick={save}>Save</Button></div>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div>}
  </Card>;
}

function Enrollment() {
  const q = useQuery<{ joinRequests: boolean }>('/api/advanced'); const [busy, setBusy] = useState(false);
  const set = async (on: boolean) => { setBusy(true); try { await api('PUT', '/api/advanced', { joinRequests: on }); revalidate('/api/advanced'); toast(on ? 'Self-announcement enabled' : 'Self-announcement disabled', 'ok'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setBusy(false); } };
  return <Card title="New servers">
    <p className="small muted" style={{ marginTop: 0 }}>An agent installed without a token announces itself to the console and waits: you decide whether to add it. It gets no access until you approve. Unanswered requests expire after 48 hours.</p>
    {!q.data ? <Skeleton h={30} /> : <label className="check"><input type="checkbox" disabled={busy} checked={q.data.joinRequests} onChange={e => set(e.target.checked)} />Accept join requests from servers (recommended on an internal network)</label>}
    <p className="small muted">If the console is reachable from untrusted networks, turn this off and use single-use enrollment tokens.</p>
  </Card>;
}

function Approvals() {
  const q = useQuery<{ approvals: Record<string, boolean>; environments: string[]; activeAdmins: number }>('/api/advanced');
  const [busy, setBusy] = useState(false);
  const toggle = async (env: string, on: boolean) => { if (!q.data) return; setBusy(true); try { await api('PUT', '/api/advanced', { approvals: { ...q.data.approvals, [env]: on } }); revalidate('/api/advanced'); toast(on ? `Approvals enabled for ${ENV_LABEL[env]}` : `Approvals disabled for ${ENV_LABEL[env]}`, 'ok'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setBusy(false); } };
  const d = q.data;
  return <Card title="Two-person approval">
    <p className="small muted" style={{ marginTop: 0 }}>In the selected environments, risky actions start only after another administrator gives the go-ahead.</p>
    {!d ? <Skeleton h={60} /> : <div className="stack">
      <p className="small muted">Risky actions are: access rule changes, parameter changes, switchover and failover, table replacement, row recovery. Backups, verifications and restores into separate directories need no approval. A request expires after 24 hours.</p>
      {d.activeAdmins < 2 ? <Banner kind="warn" title="A second administrator is needed">With only one active administrator, approvals cannot be enabled: nobody could grant them. Create another administrator on the Users page.</Banner> : null}
      <div className="stack">{d.environments.map(env => <label key={env} className="check"><input type="checkbox" disabled={busy || (!d.approvals[env] && d.activeAdmins < 2)} checked={!!d.approvals[env]} onChange={e => toggle(env, e.target.checked)} />{ENV_LABEL[env] || env}{env === 'prod' ? <span className="small muted"> (recommended)</span> : null}</label>)}</div></div>}
  </Card>;
}

/** The address the database servers use to reach the console: in every install / upgrade command (the browser's own address can be localhost or a proxy name). */
function ConsoleAddress() {
  const q = useQuery<{ publicUrl: string; effective: string; configured: boolean; warning?: string }>('/api/console-address');
  const [v, setV] = useDraft<string | null>('settings:console-address', null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (q.data && v === null) setV(q.data.publicUrl || ''); }, [q.data, v]);
  const save = async () => { setBusy(true); setErr(null); try { await api('PUT', '/api/console-address', { publicUrl: v || '' }); await revalidate('/api/console-address'); toast('Console address saved', 'ok'); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  return <Card title="Console address">
    <p className="small muted" style={{ marginTop: 0 }}>The address the database servers use to reach this console: it appears in the agent install and upgrade commands. If empty, the address you opened the console with in the browser is used.</p>
    {q.data?.warning && !q.data.configured ? <Banner kind="warn">{q.data.warning}</Banner> : null}
    <Field label="Address reachable from the servers" hint={q.data ? `In use now: ${q.data.effective}` : undefined} error={err}><div className="row gap-s"><input className="input mono" value={v ?? ''} onChange={e => setV(e.target.value)} placeholder="https://pgarca.example.com" /><Button kind="primary" busy={busy} disabled={v === null || v === (q.data?.publicUrl || '')} onClick={save}>Save address</Button></div></Field>
  </Card>;
}
