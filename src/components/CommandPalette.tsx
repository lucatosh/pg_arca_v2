import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  Server,
  Database,
  Sliders,
  History,
  FolderSearch,
  Zap,
  ArrowRight,
  Shield,
  Activity,
  Layers,
  Calendar,
  X,
  Sparkles,
  Command,
  Terminal
} from 'lucide-react';
import { ManagedCluster } from '../App';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  clusters: ManagedCluster[];
  onSelectCluster: (clusterId: string, tab?: any) => void;
  onSelectGlobalTab: (tab: 'clusters' | 'discovery' | 'history' | 'policies' | 'templates' | 'ldap' | 'rbac' | 'features' | 'logs') => void;
}

interface PaletteItem {
  id: string;
  title: string;
  subtitle: string;
  category: 'Clusters' | 'Database & Tabelle' | 'Azioni Veloci' | 'Navigazione Globale';
  icon: React.ReactNode;
  badge?: string;
  badgeColor?: string;
  action: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  clusters,
  onSelectCluster,
  onSelectGlobalTab
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Build searchable items catalogue
  const items: PaletteItem[] = [];

  // 1. Navigation items
  items.push(
    {
      id: 'nav-logs',
      title: 'Live Log Tailing (WebSocket Stream)',
      subtitle: 'Streaming in tempo reale log Patroni, PostgreSQL engine, WAL archiver e agenti Unix',
      category: 'Navigazione Globale',
      icon: <Terminal className="w-4 h-4 text-cyan-400" />,
      badge: 'Real-Time WS',
      badgeColor: 'bg-cyan-950 text-cyan-300 border-cyan-800',
      action: () => {
        onSelectGlobalTab('logs');
        onClose();
      }
    },
    {
      id: 'nav-discovery',
      title: 'Discovery Engine & Network CIDR Scanner',
      subtitle: 'Probing asincrono TCP su porte 5432, 8008, 2379, 9898 per individuare nodi PostgreSQL e Patroni',
      category: 'Navigazione Globale',
      icon: <FolderSearch className="w-4 h-4 text-amber-400" />,
      badge: 'Auto-Scanner',
      badgeColor: 'bg-amber-950 text-amber-300 border-amber-800',
      action: () => {
        onSelectGlobalTab('discovery');
        onClose();
      }
    },
    {
      id: 'nav-history',
      title: 'Storico Globale & Audit Trail delle Operazioni',
      subtitle: 'Tracciamento completo di ripristini PITR, switchover HA, modifiche parametri e reload',
      category: 'Navigazione Globale',
      icon: <History className="w-4 h-4 text-cyan-400" />,
      badge: 'Audit & Compliance',
      badgeColor: 'bg-cyan-950 text-cyan-300 border-cyan-800',
      action: () => {
        onSelectGlobalTab('history');
        onClose();
      }
    },
    {
      id: 'nav-policies',
      title: 'Schedulazione & Retention Policy Backup',
      subtitle: 'Pianificazione crontab, GFS, archiviazione continua WAL e deduplicazione CAS',
      category: 'Navigazione Globale',
      icon: <Calendar className="w-4 h-4 text-emerald-400" />,
      action: () => {
        onSelectGlobalTab('policies');
        onClose();
      }
    },
    {
      id: 'nav-hba',
      title: 'Preset & Template pg_hba.conf Replicabili',
      subtitle: 'Regole di sicurezza con validazione strict, CIDR e certificati client TLS',
      category: 'Navigazione Globale',
      icon: <Shield className="w-4 h-4 text-indigo-400" />,
      action: () => {
        onSelectGlobalTab('templates');
        onClose();
      }
    },
    {
      id: 'nav-ldap',
      title: 'Active Directory / LDAP & ldap2pg Sync',
      subtitle: 'Provisioning automatico ruoli e membership da directory aziendale',
      category: 'Navigazione Globale',
      icon: <Layers className="w-4 h-4 text-purple-400" />,
      action: () => {
        onSelectGlobalTab('ldap');
        onClose();
      }
    }
  );

  // 2. Clusters
  clusters.forEach(c => {
    items.push({
      id: `cluster-${c.id}`,
      title: `${c.name} (${c.environment.toUpperCase()})`,
      subtitle: `PG ${c.pgVersion} • ${c.haState?.nodes?.length || 1} nodi Patroni • Timeline T${c.activeTimeline} • ${c.currentLSN}`,
      category: 'Clusters',
      icon: <Server className="w-4 h-4 text-cyan-400" />,
      badge: c.environment.toUpperCase(),
      badgeColor: c.environment === 'prod' ? 'bg-red-950 text-red-300 border-red-800' : 'bg-slate-800 text-slate-300 border-slate-700',
      action: () => {
        onSelectCluster(c.id, 'cluster');
        onClose();
      }
    });

    // Sub-actions per cluster
    items.push({
      id: `cluster-${c.id}-pitr`,
      title: `Granular PITR Studio • ${c.name}`,
      subtitle: `Ripristino chirurgico non distruttivo (database, schema, tabella) per ${c.name}`,
      category: 'Azioni Veloci',
      icon: <Zap className="w-4 h-4 text-amber-400" />,
      action: () => {
        onSelectCluster(c.id, 'pitr');
        onClose();
      }
    });

    items.push({
      id: `cluster-${c.id}-ha`,
      title: `Patroni HA & Failover • ${c.name}`,
      subtitle: `Topologia DCS, lag di replica e switchover leader su ${c.name}`,
      category: 'Azioni Veloci',
      icon: <Activity className="w-4 h-4 text-emerald-400" />,
      action: () => {
        onSelectCluster(c.id, 'ha');
        onClose();
      }
    });

    // Databases & Tables inside cluster
    c.databases?.forEach(db => {
      const totalTables = db.schemas?.reduce((acc, s) => acc + (s.tables?.length || 0), 0) || 0;
      items.push({
        id: `db-${c.id}-${db.name}`,
        title: `Database: ${db.name} (su ${c.name})`,
        subtitle: `${totalTables} tabelle censite su ${db.schemas?.length || 1} schemi • Dimensione: ${(db.size / (1024 * 1024)).toFixed(0)} MB`,
        category: 'Database & Tabelle',
        icon: <Database className="w-4 h-4 text-purple-400" />,
        action: () => {
          onSelectCluster(c.id, 'pitr');
          onClose();
        }
      });
    });
  });

  // Filter items
  const filtered = items.filter(item => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q)
    );
  }).slice(0, 20); // Top 20 for fast responsiveness

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1 < filtered.length ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 >= 0 ? prev - 1 : filtered.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        filtered[selectedIndex].action();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[75vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Search Input Bar */}
        <div className="p-3.5 border-b border-slate-800 flex items-center gap-3 bg-slate-950/70">
          <Search className="w-5 h-5 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Cerca cluster, nodi, database, comandi rapidi, o digita per filtrare..."
            className="w-full bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none"
          />
          <div className="flex items-center gap-1 shrink-0 text-[10px] font-mono text-slate-500 bg-slate-800 px-2 py-1 rounded">
            <span>ESC</span> per uscire
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results List */}
        <div className="overflow-y-auto p-2 divide-y divide-slate-800/40">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-slate-400">
              <Sparkles className="w-8 h-8 text-slate-600 mx-auto mb-2" />
              <p className="text-sm font-medium">Nessun risultato trovato per "{query}"</p>
              <p className="text-xs text-slate-500 mt-1">Prova a cercare per nome cluster, ambiente, nodo o database</p>
            </div>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  onClick={item.action}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`p-3 rounded-xl cursor-pointer transition flex items-center justify-between gap-3 ${
                    isSelected
                      ? 'bg-cyan-950/60 border border-cyan-800/60 text-white shadow-sm'
                      : 'hover:bg-slate-800/60 text-slate-300 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`p-2 rounded-lg shrink-0 ${isSelected ? 'bg-cyan-900/60 text-cyan-300' : 'bg-slate-800 text-slate-400'}`}>
                      {item.icon}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-white truncate">{item.title}</span>
                        {item.badge && (
                          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${item.badgeColor || 'bg-slate-800 text-slate-300 border-slate-700'}`}>
                            {item.badge}
                          </span>
                        )}
                        <span className="text-[10px] text-slate-500 font-mono hidden sm:inline">
                          [{item.category}]
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 truncate mt-0.5">{item.subtitle}</p>
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center text-slate-500 group-hover:text-cyan-400">
                    {isSelected && <ArrowRight className="w-4 h-4 text-cyan-400" />}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer shortcuts */}
        <div className="p-2.5 bg-slate-950/90 border-t border-slate-800 flex items-center justify-between text-[11px] font-mono text-slate-500">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-[10px]">↑</kbd>
              <kbd className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-[10px]">↓</kbd> Naviga
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-[10px]">↵</kbd> Seleziona
            </span>
          </div>
          <span>
            Risultati: <strong className="text-white">{filtered.length}</strong>
          </span>
        </div>
      </div>
    </div>
  );
};
