import { go } from './router';
import { writeDraft } from './hooks';

/** Task-first entry points (independent review, big idea 2): "what do you need?" leads straight to the right page with the right choice made,
 *  from the cluster overview and from the Ctrl+K palette. One list, so both places say the same thing. */
export type RestoreIntent = 'table' | 'rows' | 'database' | 'cluster';
const pending: Record<string, RestoreIntent> = {};
/** The restore wizard takes it at mount: the situation is already chosen. */
export const takePendingIntent = (clusterId: string): RestoreIntent | null => { const i = pending[clusterId] || null; delete pending[clusterId]; return i; };
export function openRestore(clusterId: string, intent?: RestoreIntent) { if (intent) pending[clusterId] = intent; go(`c/${encodeURIComponent(clusterId)}/restore`); }

export interface Task { id: string; label: string; hint: string; icon: string; run: (clusterId: string) => void; agentOnly?: boolean }
export const CLUSTER_TASKS: Task[] = [
  { id: 'table', label: 'Put back a dropped or emptied table', hint: 'pg_arca finds when it happened', icon: 'trash', run: id => openRestore(id, 'table'), agentOnly: true },
  { id: 'rows', label: 'Undo a wrong DELETE or UPDATE', hint: 'pick the rows to put back', icon: 'file', run: id => openRestore(id, 'rows'), agentOnly: true },
  { id: 'database', label: 'Restore a database as it was', hint: 'in place or as a copy', icon: 'db', run: id => openRestore(id, 'database'), agentOnly: true },
  { id: 'cluster', label: 'Restore the whole server', hint: 'disaster or damage', icon: 'server', run: id => openRestore(id, 'cluster'), agentOnly: true },
  { id: 'protection', label: 'Check how well it is protected', hint: 'backups, WAL, objectives', icon: 'shield', run: id => go(`c/${encodeURIComponent(id)}/backup`), agentOnly: true },
  { id: 'schedule', label: 'Change the backup schedule', hint: 'policy and retention', icon: 'settings', run: id => go(`c/${encodeURIComponent(id)}/backup`), agentOnly: true },
  { id: 'hba', label: 'Allow a new client to connect', hint: 'pg_hba rules', icon: 'lock', run: id => go(`c/${encodeURIComponent(id)}/hba`) },
  { id: 'who', label: 'See who did what on this cluster', hint: 'activity log', icon: 'list', run: id => { writeDraft('history:cl', id); go('history'); } },
];
