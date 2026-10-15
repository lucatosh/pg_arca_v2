export interface TabItem { id: string; label: string; icon?: string; preview?: boolean }
export const TAB_ITEMS: TabItem[] = [
  { id: 'overview', label: 'Overview', icon: 'layers' }, { id: 'nodes', label: 'Nodes', icon: 'server' }, { id: 'ha', label: 'High availability', icon: 'swap' },
  { id: 'backup', label: 'Backup', icon: 'shield' }, { id: 'restore', label: 'Restore', icon: 'restore' },
  { id: 'operations', label: 'Operations', icon: 'list' }, { id: 'logs', label: 'Logs', icon: 'logs' }, { id: 'params', label: 'Parameters', icon: 'settings' }, { id: 'tuning', label: 'Tuning', icon: 'zap' },
  { id: 'hba', label: 'Access (HBA)', icon: 'lock' },
];
/** The pages of a cluster live in four areas (the 'Preview' placeholders for features that now exist elsewhere - policies, users and roles,
 *  directory sign-in - were removed: they contradicted the real pages), so the bar never needs more than one short row of pills and one of pages. */
export const TAB_GROUPS: { id: string; label: string; icon: string; tabs: string[] }[] = [
  { id: 'state', label: 'Status', icon: 'layers', tabs: ['overview', 'nodes', 'ha'] },
  { id: 'protect', label: 'Protection', icon: 'shield', tabs: ['backup', 'restore'] },
  { id: 'ops', label: 'Maintenance', icon: 'activity', tabs: ['operations', 'logs', 'params', 'tuning'] },
  { id: 'access', label: 'Access', icon: 'lock', tabs: ['hba'] },
];
export const groupOf = (tab: string) => TAB_GROUPS.find(g => g.tabs.includes(tab)) || TAB_GROUPS[0];
