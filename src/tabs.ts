export interface TabItem { id: string; label: string; icon?: string; preview?: boolean }
export const TAB_ITEMS: TabItem[] = [
  { id: 'overview', label: 'Panoramica', icon: 'layers' }, { id: 'nodes', label: 'Nodi', icon: 'server' }, { id: 'ha', label: 'Alta affidabilità', icon: 'swap' },
  { id: 'backup', label: 'Backup', icon: 'shield' }, { id: 'restore', label: 'Ripristino', icon: 'restore' },
  { id: 'operations', label: 'Operazioni', icon: 'list' }, { id: 'logs', label: 'Log', icon: 'logs' }, { id: 'params', label: 'Parametri', icon: 'settings' }, { id: 'tuning', label: 'Tuning', icon: 'zap' }, { id: 'templates', label: 'Modelli', preview: true },
  { id: 'hba', label: 'Accessi (HBA)', icon: 'lock' }, { id: 'ldap', label: 'LDAP / AD', preview: true }, { id: 'rbac', label: 'Ruoli (RBAC)', preview: true },
];
/** The thirteen pages of a cluster live in four areas, so the bar never needs more than one short row of pills and one of pages. */
export const TAB_GROUPS: { id: string; label: string; icon: string; tabs: string[] }[] = [
  { id: 'state', label: 'Stato', icon: 'layers', tabs: ['overview', 'nodes', 'ha'] },
  { id: 'protect', label: 'Protezione', icon: 'shield', tabs: ['backup', 'restore'] },
  { id: 'ops', label: 'Operatività', icon: 'activity', tabs: ['operations', 'logs', 'params', 'tuning', 'templates'] },
  { id: 'access', label: 'Accessi', icon: 'lock', tabs: ['hba', 'ldap', 'rbac'] },
];
export const groupOf = (tab: string) => TAB_GROUPS.find(g => g.tabs.includes(tab)) || TAB_GROUPS[0];
