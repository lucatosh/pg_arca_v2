import React, { useState, useEffect } from 'react';
import {
  History,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Server,
  Zap,
  Activity,
  Shield,
  FolderSearch,
  Download,
  RefreshCw,
  Eye,
  X,
  Copy,
  Check,
  Calendar,
  Layers,
  FileText
} from 'lucide-react';

export interface AuditEntry {
  id: string;
  timestamp: string;
  clusterId?: string;
  clusterName?: string;
  category: 'pitr' | 'ha_patroni' | 'parameters' | 'security' | 'backup' | 'discovery' | 'agent';
  action: string;
  status: 'SUCCESS' | 'WARNING' | 'FAILED';
  user: string;
  details: string;
  metadata?: Record<string, any>;
}

interface GlobalAuditHistoryProps {
  onNavigateToCluster?: (clusterId: string, tab?: any) => void;
}

export const GlobalAuditHistory: React.FC<GlobalAuditHistoryProps> = ({
  onNavigateToCluster
}) => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'SUCCESS' | 'WARNING' | 'FAILED'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);
  const [copiedId, setCopiedId] = useState(false);

  const fetchAuditLog = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/audit/history');
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries || []);
      }
    } catch (err) {
      console.error('Failed to load audit entries:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditLog();
  }, []);

  const filteredEntries = entries.filter(e => {
    if (statusFilter !== 'all' && e.status !== statusFilter) return false;
    if (categoryFilter !== 'all' && e.category !== categoryFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        e.action.toLowerCase().includes(q) ||
        e.details.toLowerCase().includes(q) ||
        (e.clusterName && e.clusterName.toLowerCase().includes(q)) ||
        e.user.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'SUCCESS':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950 text-emerald-300 border border-emerald-800">
            <CheckCircle2 className="w-3 h-3" /> SUCCESSO
          </span>
        );
      case 'WARNING':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950 text-amber-300 border border-amber-800">
            <AlertTriangle className="w-3 h-3" /> ATTENZIONE
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-red-950 text-red-300 border border-red-800">
            <XCircle className="w-3 h-3" /> FALLITO
          </span>
        );
      default:
        return null;
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'pitr':
        return <Zap className="w-4 h-4 text-amber-400" />;
      case 'ha_patroni':
        return <Activity className="w-4 h-4 text-emerald-400" />;
      case 'parameters':
        return <FileText className="w-4 h-4 text-cyan-400" />;
      case 'security':
        return <Shield className="w-4 h-4 text-purple-400" />;
      case 'discovery':
        return <FolderSearch className="w-4 h-4 text-blue-400" />;
      default:
        return <Layers className="w-4 h-4 text-slate-400" />;
    }
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(filteredEntries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pg_arca_audit_log_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="p-2 rounded-xl bg-cyan-950 border border-cyan-800 text-cyan-400">
              <History className="w-6 h-6" />
            </div>
            <h2 className="text-xl font-bold text-white">Registro Audit & Storico Operazioni Enterprise</h2>
          </div>
          <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
            Tracciamento immutabile di tutte le azioni amministrative eseguite sull'infrastruttura PostgreSQL, inclusi ripristini Granular PITR, switchover failover Patroni, modifiche dinamiche a postgresql.conf, allineamenti LDAP e scansioni Unix.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={fetchAuditLog}
            disabled={loading}
            className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-xl text-xs font-mono transition cursor-pointer flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Aggiorna Registro
          </button>
          <button
            onClick={exportJSON}
            className="px-3.5 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-mono font-bold transition cursor-pointer flex items-center gap-1.5 shadow"
          >
            <Download className="w-3.5 h-3.5" />
            Esporta JSON
          </button>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span>Eventi Tracciati Totali</span>
            <History className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-white">{entries.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">Conformità SOC2 / GDPR</div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span>Operazioni a Buon Fine</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-400">
            {entries.filter(e => e.status === 'SUCCESS').length}
          </div>
          <div className="text-[11px] text-emerald-500/80 mt-1">
            {entries.length > 0 ? Math.round((entries.filter(e => e.status === 'SUCCESS').length / entries.length) * 100) : 100}% Tasso di successo
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span>Interventi PITR & Ripristini</span>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-amber-300">
            {entries.filter(e => e.category === 'pitr').length}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Ripristini granulari chirurgici</div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span>Eventi Failover & Switchover</span>
            <Activity className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-indigo-300">
            {entries.filter(e => e.category === 'ha_patroni').length}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Gestione DCS Patroni/etcd</div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-[280px]">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Cerca per azione, dettagli, cluster o operatore..."
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 p-1 rounded-lg">
            <span className="text-slate-500 px-2 text-[11px]">Stato:</span>
            {(['all', 'SUCCESS', 'WARNING', 'FAILED'] as const).map(st => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`px-2 py-0.5 rounded cursor-pointer transition ${
                  statusFilter === st ? 'bg-cyan-950 text-cyan-300 font-bold border border-cyan-800' : 'text-slate-400 hover:text-white'
                }`}
              >
                {st === 'all' ? 'TUTTI' : st}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 p-1 rounded-lg">
            <span className="text-slate-500 px-2 text-[11px]">Categoria:</span>
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              className="bg-transparent text-slate-300 text-xs focus:outline-none cursor-pointer"
            >
              <option value="all" className="bg-slate-900">Tutte le categorie</option>
              <option value="pitr" className="bg-slate-900">Granular PITR</option>
              <option value="ha_patroni" className="bg-slate-900">Patroni HA</option>
              <option value="parameters" className="bg-slate-900">Configurazione & Parametri</option>
              <option value="security" className="bg-slate-900">Sicurezza & LDAP</option>
              <option value="backup" className="bg-slate-900">Backup & Storage</option>
              <option value="discovery" className="bg-slate-900">Discovery Engine</option>
            </select>
          </div>
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-slate-950 border-b border-slate-800 text-slate-400 text-[11px]">
              <tr>
                <th className="p-3.5">Timestamp (UTC)</th>
                <th className="p-3.5">Categoria</th>
                <th className="p-3.5">Azione Eseguita</th>
                <th className="p-3.5">Cluster Coinvolto</th>
                <th className="p-3.5">Operatore / Servizio</th>
                <th className="p-3.5">Esito</th>
                <th className="p-3.5 text-right">Dettagli</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredEntries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500 font-sans">
                    Nessun evento corrisponde ai criteri di filtro impostati.
                  </td>
                </tr>
              ) : (
                filteredEntries.map(entry => (
                  <tr
                    key={entry.id}
                    className="hover:bg-slate-800/40 transition cursor-pointer"
                    onClick={() => setSelectedEntry(entry)}
                  >
                    <td className="p-3.5 text-slate-400 whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleString('it-IT', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                      })}
                    </td>
                    <td className="p-3.5 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 text-slate-300">
                        {getCategoryIcon(entry.category)}
                        <span className="capitalize">{entry.category.replace('_', ' ')}</span>
                      </div>
                    </td>
                    <td className="p-3.5 font-bold text-white max-w-[240px] truncate">
                      {entry.action}
                    </td>
                    <td className="p-3.5 whitespace-nowrap">
                      {entry.clusterName ? (
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            if (entry.clusterId && onNavigateToCluster) {
                              onNavigateToCluster(entry.clusterId, 'cluster');
                            }
                          }}
                          className="text-cyan-400 hover:underline flex items-center gap-1"
                        >
                          <Server className="w-3 h-3" />
                          {entry.clusterName}
                        </button>
                      ) : (
                        <span className="text-slate-500">Sistema Globale</span>
                      )}
                    </td>
                    <td className="p-3.5 text-slate-400 whitespace-nowrap">
                      {entry.user}
                    </td>
                    <td className="p-3.5 whitespace-nowrap">
                      {getStatusBadge(entry.status)}
                    </td>
                    <td className="p-3.5 text-right whitespace-nowrap">
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setSelectedEntry(entry);
                        }}
                        className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition"
                        title="Ispeziona Payload"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Inspect Event Modal */}
      {selectedEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in">
          <div
            className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950">
              <div className="flex items-center gap-2">
                {getCategoryIcon(selectedEntry.category)}
                <h3 className="font-bold text-white text-sm">{selectedEntry.action}</h3>
                {getStatusBadge(selectedEntry.status)}
              </div>
              <button
                onClick={() => setSelectedEntry(null)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 font-mono text-xs">
              <div className="grid grid-cols-2 gap-3 p-3 bg-slate-950 rounded-xl border border-slate-800">
                <div>
                  <span className="text-slate-500 block text-[11px]">ID Evento Immutabile:</span>
                  <span className="text-white font-bold">{selectedEntry.id}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[11px]">Data & Ora UTC:</span>
                  <span className="text-cyan-300">{selectedEntry.timestamp}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[11px]">Operatore Responsabile:</span>
                  <span className="text-amber-300">{selectedEntry.user}</span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[11px]">Cluster di Destinazione:</span>
                  <span className="text-white">{selectedEntry.clusterName || 'Tutti i nodi'}</span>
                </div>
              </div>

              <div>
                <span className="text-slate-400 block mb-1 font-bold text-slate-300">Descrizione e Log di Esecuzione:</span>
                <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-slate-300 leading-relaxed">
                  {selectedEntry.details}
                </div>
              </div>

              {selectedEntry.metadata && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-slate-400 font-bold text-slate-300">Dati Tecnici & Coordinate (JSON):</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(JSON.stringify(selectedEntry.metadata, null, 2));
                        setCopiedId(true);
                        setTimeout(() => setCopiedId(false), 2000);
                      }}
                      className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer"
                    >
                      {copiedId ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      {copiedId ? 'Copiato!' : 'Copia Metadati'}
                    </button>
                  </div>
                  <pre className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-[11px] text-cyan-300 overflow-x-auto max-h-56">
                    {JSON.stringify(selectedEntry.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-slate-800 bg-slate-950 flex items-center justify-end">
              <button
                onClick={() => setSelectedEntry(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-mono transition cursor-pointer"
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
