import React, { useState, useEffect } from 'react';
import {
  FolderSearch,
  Server,
  Layers,
  Database,
  RefreshCw,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  FileCode,
  SlidersHorizontal,
  ArrowRight,
  ShieldCheck,
  Search,
  Copy,
  Check,
  Sliders,
  Cpu,
  Zap,
  Globe,
  HardDrive,
  Activity,
  Play,
  RotateCcw,
  Sparkles,
  Info,
  CheckCheck,
  Wifi,
  Network,
  Terminal,
  ExternalLink,
  ShieldAlert,
  Radio
} from 'lucide-react';

export interface SearchPathItem {
  id: string;
  path: string;
  tag: 'patroni' | 'postgres' | 'dcs' | 'pooler' | 'archive' | 'custom';
  description: string;
  enabled: boolean;
  recursive: boolean;
  pattern: string;
}

export interface DiscoveredEndpointItem {
  host: string;
  port: number;
  open: boolean;
  service: string;
  latencyMs: number;
  banner?: string;
  patroniData?: any;
  agentData?: any;
}

export interface DiscoveredClusterSynthesis {
  id: string;
  name: string;
  environment: 'prod' | 'prep' | 'int' | 'dev' | 'test';
  dcsType: 'etcd' | 'consul' | 'k8s-api';
  dcsEndpoint: string;
  pgVersion: string;
  activeTimeline: number;
  nodes: {
    name: string;
    role: 'primary' | 'sync_standby' | 'replica' | 'standby_leader';
    host: string;
    port: number;
    latencyMs: number;
    state: string;
  }[];
  isRealNetworkDetected: boolean;
}

interface GlobalDiscoveryHubProps {
  onClusterImported?: (cluster: any) => void;
  onNavigateToCluster?: (clusterId: string) => void;
  clustersCount?: number;
}

export const GlobalDiscoveryHub: React.FC<GlobalDiscoveryHubProps> = ({
  onClusterImported,
  onNavigateToCluster,
  clustersCount = 0
}) => {
  const [activeTab, setActiveTab] = useState<'network_scan' | 'agent_nodes' | 'manual_add' | 'filesystem' | 'diff'>('network_scan');
  
  // Real Network Scanner State
  const [targetCidr, setTargetCidr] = useState<string>('127.0.0.1/32');
  const [selectedPorts, setSelectedPorts] = useState<number[]>([5432, 8008, 2379, 9898]);
  const [scanTimeoutMs, setScanTimeoutMs] = useState<number>(300);
  const [isScanningNetwork, setIsScanningNetwork] = useState<boolean>(false);
  const [networkInterfaces, setNetworkInterfaces] = useState<any[]>([]);
  const [networkScanResults, setNetworkScanResults] = useState<{
    durationMs: number;
    scannedIpsCount: number;
    activeEndpoints: DiscoveredEndpointItem[];
    discoveredClusters: DiscoveredClusterSynthesis[];
    discoveredAgents: any[];
  } | null>(null);

  // Single Probe Tool State
  const [probeHost, setProbeHost] = useState<string>('127.0.0.1');
  const [probePort, setProbePort] = useState<number>(5432);
  const [isProbingSingle, setIsProbingSingle] = useState<boolean>(false);
  const [singleProbeResult, setSingleProbeResult] = useState<any>(null);

  // Manual Add Cluster State
  const [manualName, setManualName] = useState<string>('');
  const [manualEnv, setManualEnv] = useState<'prod' | 'prep' | 'int' | 'dev' | 'test'>('prod');
  const [manualHost, setManualHost] = useState<string>('127.0.0.1');
  const [manualPort, setManualPort] = useState<number>(5432);
  const [manualPatroniPort, setManualPatroniPort] = useState<number>(8008);
  const [manualDcsEndpoint, setManualDcsEndpoint] = useState<string>('http://127.0.0.1:2379');
  const [manualAdding, setManualAdding] = useState<boolean>(false);
  const [manualTestResult, setManualTestResult] = useState<any>(null);

  // Agent Nodes state
  const [agentNodes, setAgentNodes] = useState<any[]>([]);
  const [copiedInstallCmd, setCopiedInstallCmd] = useState<boolean>(false);

  // Filesystem & Diff state (retained for config inspection)
  const [searchPaths, setSearchPaths] = useState<SearchPathItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('/etc/patroni/patroni.yml');
  const [fileContentData, setFileContentData] = useState<any>(null);
  const [diffNodeA, setDiffNodeA] = useState<string>('pg-node-01');
  const [diffNodeB, setDiffNodeB] = useState<string>('pg-node-02');
  const [diffData, setDiffData] = useState<any>(null);

  // Toast message
  const [actionMessage, setActionMessage] = useState<{ text: string; type: 'success' | 'info' | 'error' } | null>(null);

  const showToast = (text: string, type: 'success' | 'info' | 'error' = 'success') => {
    setActionMessage({ text, type });
    setTimeout(() => setActionMessage(null), 5000);
  };

  // Initial Data Fetch
  useEffect(() => {
    fetchNetworkInterfaces();
    fetchAgentNodes();
    fetchDiscoverySettings();
    fetchFileContent('/etc/patroni/patroni.yml');
    fetchDiff();
  }, []);

  const fetchNetworkInterfaces = async () => {
    try {
      const res = await fetch('/api/network/interfaces');
      if (res.ok) {
        const data = await res.json();
        setNetworkInterfaces(data.interfaces || []);
        if (data.defaultTarget) {
          setTargetCidr(data.defaultTarget);
        }
      }
    } catch (e) {
      console.warn('Network interfaces query error:', e);
    }
  };

  const fetchAgentNodes = async () => {
    try {
      const res = await fetch('/api/agent/nodes');
      if (res.ok) {
        const data = await res.json();
        setAgentNodes(data.nodes || []);
      }
    } catch (e) {
      console.warn('Agent nodes fetch error:', e);
    }
  };

  const fetchDiscoverySettings = async () => {
    try {
      const res = await fetch('/api/discovery/settings');
      if (res.ok) {
        const data = await res.json();
        setSearchPaths(data.searchPaths || []);
      }
    } catch (e) {
      console.warn('Discovery settings fetch error:', e);
    }
  };

  const fetchFileContent = async (path: string) => {
    setSelectedFile(path);
    try {
      const res = await fetch(`/api/discovery/file-content?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setFileContentData(data);
      }
    } catch (e) {
      console.warn('File inspection error:', e);
    }
  };

  const fetchDiff = async () => {
    try {
      const res = await fetch('/api/discovery/compare-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeA: diffNodeA, nodeB: diffNodeB })
      });
      if (res.ok) {
        const data = await res.json();
        setDiffData(data);
      }
    } catch (e) {
      console.warn('Diff error:', e);
    }
  };

  // Run Real Network Discovery Scan
  const handleRunNetworkScan = async () => {
    if (!targetCidr.trim()) {
      showToast('Inserisci un intervallo IP o CIDR valido (es. 127.0.0.1/32, 192.168.100.0/24)', 'error');
      return;
    }

    setIsScanningNetwork(true);
    setNetworkScanResults(null);

    try {
      const res = await fetch('/api/network/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targets: targetCidr.trim(),
          ports: selectedPorts,
          timeoutMs: scanTimeoutMs,
          concurrency: 25
        })
      });

      if (res.ok) {
        const data = await res.json();
        setNetworkScanResults(data);
        showToast(
          `Scansione completata in ${data.durationMs}ms: rilevati ${data.activeEndpoints?.length || 0} endpoint attivi e ${data.discoveredClusters?.length || 0} cluster.`,
          'success'
        );
      } else {
        showToast('Errore durante la scansione di rete', 'error');
      }
    } catch (err: any) {
      showToast(`Errore di rete: ${err.message}`, 'error');
    } finally {
      setIsScanningNetwork(false);
    }
  };

  // Test Single Node Probe
  const handleTestSingleProbe = async () => {
    setIsProbingSingle(true);
    setSingleProbeResult(null);
    try {
      const res = await fetch('/api/network/probe-node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: probeHost.trim(), port: probePort, timeoutMs: 500 })
      });
      if (res.ok) {
        const data = await res.json();
        setSingleProbeResult(data);
      }
    } catch (e: any) {
      setSingleProbeResult({ open: false, latencyMs: 0, service: 'Error', banner: e.message });
    } finally {
      setIsProbingSingle(false);
    }
  };

  // Import Discovered Cluster into Inventory
  const handleImportDiscoveredCluster = async (clusterSyn: DiscoveredClusterSynthesis) => {
    try {
      const res = await fetch('/api/network/import-discovered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clusterName: clusterSyn.name,
          environment: clusterSyn.environment,
          nodes: clusterSyn.nodes,
          dcsType: clusterSyn.dcsType,
          dcsEndpoint: clusterSyn.dcsEndpoint,
          pgVersion: clusterSyn.pgVersion
        })
      });

      if (res.ok) {
        const data = await res.json();
        showToast(data.message, 'success');
        if (onClusterImported) {
          onClusterImported(data.cluster);
        }
        if (onNavigateToCluster) {
          onNavigateToCluster(data.cluster.id);
        }
      } else {
        const err = await res.json();
        showToast(`Errore importazione: ${err.error || 'Operazione fallita'}`, 'error');
      }
    } catch (e: any) {
      showToast(`Errore: ${e.message}`, 'error');
    }
  };

  // Test and Add Manual Cluster
  const handleTestManualConnection = async () => {
    try {
      const res = await fetch('/api/network/probe-node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: manualHost.trim(), port: manualPort, timeoutMs: 600 })
      });
      if (res.ok) {
        const data = await res.json();
        setManualTestResult(data);
        if (data.open) {
          showToast(`Connessione riuscita a ${manualHost}:${manualPort} (${data.latencyMs}ms)`, 'success');
        } else {
          showToast(`Porta ${manualPort} chiusa o irraggiungibile su ${manualHost}`, 'error');
        }
      }
    } catch (e: any) {
      showToast(`Errore test connessione: ${e.message}`, 'error');
    }
  };

  const handleAddManualCluster = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualName.trim() || !manualHost.trim()) {
      showToast('Nome cluster e Host primario obbligatori', 'error');
      return;
    }

    setManualAdding(true);
    try {
      const res = await fetch('/api/network/import-discovered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clusterName: manualName.trim(),
          environment: manualEnv,
          nodes: [
            {
              name: `${manualName.trim()}-01`,
              role: 'primary',
              host: manualHost.trim(),
              port: manualPort
            }
          ],
          dcsType: 'etcd',
          dcsEndpoint: manualDcsEndpoint.trim() || `http://${manualHost.trim()}:2379`
        })
      });

      if (res.ok) {
        const data = await res.json();
        showToast(data.message, 'success');
        if (onClusterImported) {
          onClusterImported(data.cluster);
        }
        if (onNavigateToCluster) {
          onNavigateToCluster(data.cluster.id);
        }
      }
    } catch (e: any) {
      showToast(`Errore: ${e.message}`, 'error');
    } finally {
      setManualAdding(false);
    }
  };

  // Clear or Seed Sandbox Demo
  const handleClearSandbox = async () => {
    try {
      const res = await fetch('/api/clusters/clear-sandbox', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        showToast(data.message, 'info');
        window.location.reload();
      }
    } catch (e: any) {
      showToast('Errore durante la pulizia dei dati demo', 'error');
    }
  };

  const handleSeedSandbox = async () => {
    try {
      const res = await fetch('/api/clusters/seed-sandbox', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        showToast(data.message, 'success');
        window.location.reload();
      }
    } catch (e: any) {
      showToast('Errore durante il caricamento sandbox', 'error');
    }
  };

  const togglePort = (port: number) => {
    if (selectedPorts.includes(port)) {
      setSelectedPorts(selectedPorts.filter(p => p !== port));
    } else {
      setSelectedPorts([...selectedPorts, port]);
    }
  };

  const copyInstallCommand = () => {
    const cmd = `sudo mkdir -p /opt/pg-arca && cd /opt/pg-arca && cp -r unix-agent/* . && sudo ./install-agent.sh`;
    navigator.clipboard.writeText(cmd);
    setCopiedInstallCmd(true);
    setTimeout(() => setCopiedInstallCmd(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {actionMessage && (
        <div className={`p-4 rounded-xl border text-xs flex items-center justify-between ${
          actionMessage.type === 'success' ? 'bg-emerald-950/80 border-emerald-800 text-emerald-200' :
          actionMessage.type === 'error' ? 'bg-red-950/80 border-red-800 text-red-200' :
          'bg-cyan-950/80 border-cyan-800 text-cyan-200'
        }`}>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            <span>{actionMessage.text}</span>
          </div>
          <button onClick={() => setActionMessage(null)} className="opacity-70 hover:opacity-100 cursor-pointer">✕</button>
        </div>
      )}

      {/* Main Hero Banner: Real Enterprise Network Discovery */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-900 to-indigo-950/40 border border-slate-800 rounded-2xl p-6 shadow-xl relative overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xl font-extrabold tracking-tight text-white">Discovery & Network Architecture Engine</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800 font-mono">v1.0.0 Enterprise</span>
            </div>
            <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
              Rilevamento reale e non simulato tramite scansione socket TCP ad alte prestazioni dei nodi PostgreSQL (5432), orchestratori Patroni HA (8008), quorum etcd (2379) e agenti Unix (9898). Zero dati fittizi.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleClearSandbox}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-mono transition cursor-pointer"
              title="Rimuovi eventuali dati mock e mantieni solo cluster reali"
            >
              Pulisci Sandbox Demo
            </button>
            <button
              onClick={handleSeedSandbox}
              className="px-3 py-1.5 rounded-lg bg-indigo-950 hover:bg-indigo-900 text-indigo-300 border border-indigo-800 text-xs font-mono transition cursor-pointer"
              title="Carica cluster di test se non hai macchine attive"
            >
              Carica Demo Lab
            </button>
          </div>
        </div>

        {/* Tab Selector Rail */}
        <div className="flex flex-wrap items-center gap-2 mt-6 pt-4 border-t border-slate-800/80 text-xs font-mono">
          <button
            onClick={() => setActiveTab('network_scan')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition cursor-pointer ${
              activeTab === 'network_scan'
                ? 'bg-cyan-600 text-white font-bold shadow'
                : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            <Network className="w-3.5 h-3.5" />
            <span>Scansione Rete & CIDR</span>
          </button>

          <button
            onClick={() => setActiveTab('agent_nodes')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition cursor-pointer ${
              activeTab === 'agent_nodes'
                ? 'bg-cyan-600 text-white font-bold shadow'
                : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            <Radio className="w-3.5 h-3.5 text-emerald-400" />
            <span>Agenti Unix Connessi ({agentNodes.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('manual_add')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition cursor-pointer ${
              activeTab === 'manual_add'
                ? 'bg-cyan-600 text-white font-bold shadow'
                : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            <Plus className="w-3.5 h-3.5 text-cyan-400" />
            <span>Aggiungi Nodo / Cluster Diretto</span>
          </button>

          <button
            onClick={() => setActiveTab('filesystem')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition cursor-pointer ${
              activeTab === 'filesystem'
                ? 'bg-cyan-600 text-white font-bold shadow'
                : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            <FileCode className="w-3.5 h-3.5 text-amber-400" />
            <span>Ispezione Config Filesystem</span>
          </button>

          <button
            onClick={() => setActiveTab('diff')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition cursor-pointer ${
              activeTab === 'diff'
                ? 'bg-cyan-600 text-white font-bold shadow'
                : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-purple-400" />
            <span>Diff Multi-Nodo</span>
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: REAL NETWORK SCANNER & CIDR SUBNET PROBER                          */}
      {/* ========================================================================= */}
      {activeTab === 'network_scan' && (
        <div className="space-y-6">
          {/* Scanner Control Deck */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="space-y-1">
                <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
                  <Network className="w-4 h-4 text-cyan-400" />
                  Scanner Socket TCP & Auto-Discovery Rete
                </h3>
                <p className="text-xs text-slate-400">
                  Esegue probing asincrono in parallelo sui nodi indicati per intercettare porte attive e handshake protocollo.
                </p>
              </div>

              {/* Detected Subnets Quick Select */}
              {networkInterfaces.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono">
                  <span className="text-slate-500 text-[11px]">Interfacce Rilevate:</span>
                  {networkInterfaces.map(iface => (
                    <button
                      key={`${iface.name}-${iface.ip}`}
                      onClick={() => setTargetCidr(iface.cidr)}
                      className={`px-2 py-0.5 rounded border transition cursor-pointer text-[11px] ${
                        targetCidr === iface.cidr
                          ? 'bg-cyan-950 text-cyan-300 border-cyan-800 font-bold'
                          : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {iface.name}: {iface.cidr}
                    </button>
                  ))}
                  <button
                    onClick={() => setTargetCidr('192.168.100.11, 192.168.100.12, 192.168.100.13')}
                    className="px-2 py-0.5 rounded bg-slate-950 text-amber-300 border border-slate-800 hover:border-amber-700 text-[11px] cursor-pointer"
                    title="Preset per il lab KVM descritto in README.md"
                  >
                    KVM Lab 3 Nodi
                  </button>
                </div>
              )}
            </div>

            {/* Target CIDR Input + Ports Selector */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-2">
              <div className="md:col-span-6 space-y-1">
                <label className="text-[11px] font-mono text-slate-400">Intervallo CIDR / Indirizzi IP separati da virgola</label>
                <div className="relative">
                  <Globe className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={targetCidr}
                    onChange={e => setTargetCidr(e.target.value)}
                    placeholder="es. 127.0.0.1/32 oppure 192.168.100.0/24"
                    className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-lg pl-9 pr-3 py-2 text-xs font-mono text-slate-100 placeholder-slate-600"
                  />
                </div>
              </div>

              <div className="md:col-span-4 space-y-1">
                <label className="text-[11px] font-mono text-slate-400">Porte da analizzare</label>
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  {[
                    { port: 5432, label: 'PostgreSQL (5432)' },
                    { port: 8008, label: 'Patroni (8008)' },
                    { port: 2379, label: 'ETCD (2379)' },
                    { port: 9898, label: 'Agent (9898)' },
                    { port: 6432, label: 'PgBouncer (6432)' }
                  ].map(p => (
                    <button
                      key={p.port}
                      type="button"
                      onClick={() => togglePort(p.port)}
                      className={`px-2 py-1 rounded text-[11px] font-mono border transition cursor-pointer ${
                        selectedPorts.includes(p.port)
                          ? 'bg-cyan-950 text-cyan-300 border-cyan-800 font-bold'
                          : 'bg-slate-950 text-slate-500 border-slate-800 hover:text-slate-300'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="md:col-span-2 flex items-end">
                <button
                  onClick={handleRunNetworkScan}
                  disabled={isScanningNetwork}
                  className="w-full py-2 px-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-bold font-mono transition cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50 shadow-md"
                >
                  {isScanningNetwork ? (
                    <>
                      <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                      <span>Scansione...</span>
                    </>
                  ) : (
                    <>
                      <Search className="w-3.5 h-3.5" />
                      <span>Avvia Probing</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Quick Single Node Ping / Probe Box */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 text-xs font-mono">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" />
                <span className="font-semibold text-slate-200">Test Singolo Endpoint Immediato:</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 flex-1 max-w-xl justify-end">
                <input
                  type="text"
                  value={probeHost}
                  onChange={e => setProbeHost(e.target.value)}
                  placeholder="Host o IP (es. 127.0.0.1)"
                  className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-slate-200 w-36"
                />
                <input
                  type="number"
                  value={probePort}
                  onChange={e => setProbePort(parseInt(e.target.value, 10) || 5432)}
                  className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 w-20"
                />
                <button
                  onClick={handleTestSingleProbe}
                  disabled={isProbingSingle}
                  className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-400 rounded border border-slate-700 transition cursor-pointer disabled:opacity-50"
                >
                  {isProbingSingle ? 'Probing...' : 'Test Ping'}
                </button>
                {singleProbeResult && (
                  <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                    singleProbeResult.open
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                      : 'bg-red-950 text-red-300 border border-red-800'
                  }`}>
                    {singleProbeResult.open ? `APERTA (${singleProbeResult.latencyMs}ms)` : 'CHIUSA / TIMEOUT'}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Scan Results: Discovered Clusters and Endpoints */}
          {networkScanResults && (
            <div className="space-y-6">
              {/* Telemetry Strip */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                  <span className="text-slate-400 text-[11px]">IP Scansionati</span>
                  <div className="text-lg font-bold text-white tabular-nums mt-0.5">{networkScanResults.scannedIpsCount}</div>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                  <span className="text-slate-400 text-[11px]">Endpoint Raggiunti</span>
                  <div className="text-lg font-bold text-emerald-400 tabular-nums mt-0.5">{networkScanResults.activeEndpoints.length}</div>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                  <span className="text-slate-400 text-[11px]">Cluster Sintetizzati</span>
                  <div className="text-lg font-bold text-cyan-400 tabular-nums mt-0.5">{networkScanResults.discoveredClusters.length}</div>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                  <span className="text-slate-400 text-[11px]">Tempo Totale Probing</span>
                  <div className="text-lg font-bold text-amber-400 tabular-nums mt-0.5">{networkScanResults.durationMs}ms</div>
                </div>
              </div>

              {/* Synthesized Clusters Found */}
              {networkScanResults.discoveredClusters.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-xs font-bold font-mono text-cyan-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Server className="w-4 h-4" /> Cluster PostgreSQL & Patroni Rilevati sulla Rete ({networkScanResults.discoveredClusters.length})
                  </h4>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {networkScanResults.discoveredClusters.map((clusterSyn) => (
                      <div
                        key={clusterSyn.id}
                        className="bg-slate-900 border border-slate-800 hover:border-cyan-500/50 rounded-2xl p-5 space-y-4 shadow-lg transition"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <h5 className="font-bold text-base text-white">{clusterSyn.name}</h5>
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800 font-mono uppercase font-bold">
                                {clusterSyn.environment}
                              </span>
                            </div>
                            <p className="text-xs text-slate-400 mt-1 font-mono">
                              DCS: {clusterSyn.dcsType} • Timeline: T{clusterSyn.activeTimeline} • PG {clusterSyn.pgVersion}
                            </p>
                          </div>

                          <button
                            onClick={() => handleImportDiscoveredCluster(clusterSyn)}
                            className="px-3.5 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-bold font-mono transition cursor-pointer flex items-center gap-1.5 shadow"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Importa Cluster</span>
                          </button>
                        </div>

                        {/* Discovered Nodes in Cluster */}
                        <div className="space-y-1.5 bg-slate-950 p-3 rounded-xl border border-slate-800/80 font-mono text-xs">
                          <span className="text-[11px] text-slate-500 font-semibold block mb-1">Nodi Fisici Rilevati:</span>
                          {clusterSyn.nodes.map(node => (
                            <div key={node.name} className="flex items-center justify-between text-slate-300 py-0.5 border-b border-slate-900/60 last:border-none">
                              <div className="flex items-center gap-2">
                                <span className={`w-2 h-2 rounded-full ${node.role === 'primary' ? 'bg-cyan-400' : 'bg-emerald-400'}`}></span>
                                <span className="font-bold">{node.name}</span>
                                <span className="text-slate-500">({node.host}:{node.port})</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`text-[10px] uppercase font-bold ${node.role === 'primary' ? 'text-cyan-400' : 'text-emerald-400'}`}>
                                  {node.role}
                                </span>
                                <span className="text-[10px] text-slate-500 tabular-nums">
                                  {node.latencyMs}ms
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* All Raw Responsive Endpoints Table */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-lg">
                <div className="p-4 border-b border-slate-800 flex items-center justify-between font-mono text-xs">
                  <span className="font-bold text-slate-200">Tutti gli Endpoint Aperti ({networkScanResults.activeEndpoints.length})</span>
                  <span className="text-slate-400 text-[11px]">Risposte socket verificate</span>
                </div>

                {networkScanResults.activeEndpoints.length === 0 ? (
                  <div className="p-8 text-center text-slate-500 text-xs font-mono">
                    Nessun endpoint ha risposto con porte aperte sull'intervallo specificato ({targetCidr}).
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs font-mono">
                      <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] border-b border-slate-800">
                        <tr>
                          <th className="py-2.5 px-4">Indirizzo IP</th>
                          <th className="py-2.5 px-4">Porta</th>
                          <th className="py-2.5 px-4">Servizio Rilevato</th>
                          <th className="py-2.5 px-4">Latenza RTT</th>
                          <th className="py-2.5 px-4">Dettagli / Banner</th>
                          <th className="py-2.5 px-4 text-right">Azione</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {networkScanResults.activeEndpoints.map((ep, idx) => (
                          <tr key={`${ep.host}-${ep.port}-${idx}`} className="hover:bg-slate-850 transition">
                            <td className="py-2.5 px-4 font-bold text-slate-200">{ep.host}</td>
                            <td className="py-2.5 px-4 text-cyan-400 tabular-nums font-semibold">{ep.port}</td>
                            <td className="py-2.5 px-4">
                              <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-300 font-semibold">
                                {ep.service}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 text-slate-400 tabular-nums">{ep.latencyMs}ms</td>
                            <td className="py-2.5 px-4 text-slate-300 text-[11px] truncate max-w-xs">{ep.banner || 'OK'}</td>
                            <td className="py-2.5 px-4 text-right">
                              <button
                                onClick={() => {
                                  setManualHost(ep.host);
                                  setManualPort(ep.port);
                                  setManualName(`cluster-${ep.host.replace(/\./g, '-')}`);
                                  setActiveTab('manual_add');
                                }}
                                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-400 text-xs font-semibold cursor-pointer"
                              >
                                Configura
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: UNIX AGENT LIVE NODES & INSTALLATION SNIPPET                       */}
      {/* ========================================================================= */}
      {activeTab === 'agent_nodes' && (
        <div className="space-y-6">
          {/* Quick Installation Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-3 font-mono text-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <span className="font-bold text-sm text-slate-100">Installazione Rapida Agente sui Nodi Unix / VM</span>
              </div>
              <button
                onClick={copyInstallCommand}
                className="flex items-center gap-1.5 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 cursor-pointer"
              >
                {copiedInstallCmd ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedInstallCmd ? 'Copiato' : 'Copia Comando'}</span>
              </button>
            </div>

            <p className="text-slate-400 text-[11px]">
              Esegui questo comando sul nodo PostgreSQL (Ubuntu / Debian / RHEL). L'installer configura l'agente come servizio systemd su porta 9898 e invia l'heartbeat automatico al control plane.
            </p>

            <pre className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-emerald-400 overflow-x-auto select-all">
              sudo mkdir -p /opt/pg-arca && cd /opt/pg-arca && cp -r unix-agent/* . && sudo ./install-agent.sh
            </pre>
          </div>

          {/* Registered Agents List */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-lg">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between font-mono text-xs">
              <span className="font-bold text-slate-200">Agenti Connessi in Ascolto ({agentNodes.length})</span>
              <button
                onClick={fetchAgentNodes}
                className="flex items-center gap-1 text-cyan-400 hover:underline cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" /> Aggiorna Heartbeat
              </button>
            </div>

            {agentNodes.length === 0 ? (
              <div className="p-12 text-center text-slate-500 text-xs font-mono">
                <Radio className="w-8 h-8 mx-auto mb-2 opacity-40 text-slate-400 animate-pulse" />
                <p className="font-semibold text-slate-300">Nessun agente registrato al momento</p>
                <p className="text-slate-500 mt-1 max-w-md mx-auto">
                  Installa l'agente con lo script sopra su uno dei nodi per vederlo comparire qui automaticamente con telemetria in tempo reale.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-800">
                {agentNodes.map(node => (
                  <div key={node.node_name || node.remoteIp} className="p-4 flex items-center justify-between font-mono text-xs">
                    <div className="flex items-center gap-3">
                      <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse"></div>
                      <div>
                        <div className="font-bold text-slate-100">{node.node_name || 'Unix Node'}</div>
                        <div className="text-[11px] text-slate-400">{node.remoteIp} • Ultimo ping: {node.lastHeartbeat}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-[11px]">
                      <span className="text-slate-300">Stato: <span className="text-emerald-400 font-bold uppercase">{node.status}</span></span>
                      <button
                        onClick={() => {
                          setManualHost(node.remoteIp);
                          setManualName(node.node_name || 'discovered-cluster');
                          setActiveTab('manual_add');
                        }}
                        className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-400 font-bold cursor-pointer"
                      >
                        Importa
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: DIRECT MANUAL ADD CLUSTER FORM                                     */}
      {/* ========================================================================= */}
      {activeTab === 'manual_add' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl max-w-2xl mx-auto space-y-5 font-mono text-xs">
          <div className="border-b border-slate-800 pb-3">
            <h3 className="font-bold text-base text-white flex items-center gap-2">
              <Plus className="w-4 h-4 text-cyan-400" />
              Aggiungi Cluster o Istanza Reale Esistente
            </h3>
            <p className="text-slate-400 text-xs mt-1">
              Inserisci i parametri di rete dell'istanza per testare la connettività e censirla immediatamente.
            </p>
          </div>

          <form onSubmit={handleAddManualCluster} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-slate-400 text-[11px]">Nome Univoco Cluster *</label>
                <input
                  type="text"
                  required
                  value={manualName}
                  onChange={e => setManualName(e.target.value)}
                  placeholder="es. pg-cluster-prod-kvm"
                  className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-lg p-2 text-slate-200"
                />
              </div>

              <div className="space-y-1">
                <label className="text-slate-400 text-[11px]">Ambiente di Riferimento</label>
                <select
                  value={manualEnv}
                  onChange={e => setManualEnv(e.target.value as any)}
                  className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-lg p-2 text-slate-200"
                >
                  <option value="prod">Produzione (PROD)</option>
                  <option value="prep">Pre-Produzione (PREP)</option>
                  <option value="int">Integrazione (INT)</option>
                  <option value="dev">Sviluppo (DEV)</option>
                  <option value="test">Test Lab (TEST)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-slate-400 text-[11px]">Indirizzo IP / Host Primario *</label>
                <input
                  type="text"
                  required
                  value={manualHost}
                  onChange={e => setManualHost(e.target.value)}
                  placeholder="es. 192.168.100.11 o 127.0.0.1"
                  className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-lg p-2 text-slate-200"
                />
              </div>

              <div className="space-y-1">
                <label className="text-slate-400 text-[11px]">Porta PostgreSQL</label>
                <input
                  type="number"
                  value={manualPort}
                  onChange={e => setManualPort(parseInt(e.target.value, 10) || 5432)}
                  className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-lg p-2 text-slate-200"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-slate-400 text-[11px]">Porta REST API Patroni (opzionale)</label>
                <input
                  type="number"
                  value={manualPatroniPort}
                  onChange={e => setManualPatroniPort(parseInt(e.target.value, 10) || 8008)}
                  className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-lg p-2 text-slate-200"
                />
              </div>

              <div className="space-y-1">
                <label className="text-slate-400 text-[11px]">Endpoint DCS (etcd/consul)</label>
                <input
                  type="text"
                  value={manualDcsEndpoint}
                  onChange={e => setManualDcsEndpoint(e.target.value)}
                  placeholder="http://192.168.100.11:2379"
                  className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-lg p-2 text-slate-200"
                />
              </div>
            </div>

            {/* Test Connection Result */}
            {manualTestResult && (
              <div className={`p-3 rounded-lg border text-xs ${
                manualTestResult.open ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300' : 'bg-red-950/60 border-red-800 text-red-300'
              }`}>
                {manualTestResult.open
                  ? `✓ Connessione stabilita con successo in ${manualTestResult.latencyMs}ms (${manualTestResult.banner || 'PostgreSQL'})`
                  : '✕ Impossibile connettersi all\'host indicato: verifica IP e porta.'}
              </div>
            )}

            <div className="flex items-center justify-between pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={handleTestManualConnection}
                className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition cursor-pointer"
              >
                Testa Connessione Ora
              </button>

              <button
                type="submit"
                disabled={manualAdding}
                className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg font-bold transition cursor-pointer disabled:opacity-50"
              >
                {manualAdding ? 'Salvataggio...' : 'Registra Cluster nel Sistema'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 4: CONFIGURATION FILESYSTEM INSPECTOR                                 */}
      {/* ========================================================================= */}
      {activeTab === 'filesystem' && (
        <div className="space-y-4 font-mono text-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-amber-400" />
              <span className="font-bold text-slate-200">File di Configurazione Unix Rilevati</span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {[
                '/etc/patroni/patroni.yml',
                '/etc/postgresql/16/main/postgresql.conf',
                '/etc/postgresql/16/main/pg_hba.conf',
                '/etc/etcd/etcd.conf.yml'
              ].map(p => (
                <button
                  key={p}
                  onClick={() => fetchFileContent(p)}
                  className={`px-2.5 py-1 rounded border transition cursor-pointer ${
                    selectedFile === p
                      ? 'bg-amber-950 text-amber-300 border-amber-800 font-bold'
                      : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  {p.split('/').pop()}
                </button>
              ))}
            </div>
          </div>

          {fileContentData && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-lg">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <div>
                  <span className="font-bold text-white text-sm">{fileContentData.filename}</span>
                  <span className="text-slate-500 ml-2">({fileContentData.path})</span>
                </div>
                <span className="text-slate-400 tabular-nums">{fileContentData.sizeBytes} bytes</span>
              </div>

              {/* Best Practice Notes */}
              {Array.isArray(fileContentData.bestPracticeNotes) && (
                <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800/80 space-y-1 text-emerald-400">
                  {fileContentData.bestPracticeNotes.map((note: string, i: number) => (
                    <div key={i}>{note}</div>
                  ))}
                </div>
              )}

              <pre className="bg-[#070b14] p-4 rounded-xl border border-slate-800 text-slate-200 overflow-x-auto max-h-96 leading-relaxed select-all">
                {fileContentData.content}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 5: MULTI-NODE CONFIGURATION DIFF COMPARATOR                           */}
      {/* ========================================================================= */}
      {activeTab === 'diff' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-4 font-mono text-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
            <div>
              <h4 className="font-bold text-sm text-slate-100 flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-purple-400" />
                Comparatore Diff Cross-Nodo (Primary vs Standby)
              </h4>
              <p className="text-slate-400 text-xs mt-0.5">
                Rileva discrepanze architetturali che potrebbero ostacolare il failover a zero downtime o la continuità WAL.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={diffNodeA}
                onChange={e => setDiffNodeA(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200"
              >
                <option value="pg-node-01">pg-node-01 (Primary)</option>
                <option value="pg-node-02">pg-node-02 (Standby)</option>
              </select>
              <span className="text-slate-500">vs</span>
              <select
                value={diffNodeB}
                onChange={e => setDiffNodeB(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200"
              >
                <option value="pg-node-02">pg-node-02 (Standby)</option>
                <option value="pg-node-03">pg-node-03 (Replica)</option>
              </select>
              <button
                onClick={fetchDiff}
                className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-400 rounded border border-slate-700 cursor-pointer"
              >
                Compara
              </button>
            </div>
          </div>

          {diffData && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950 text-slate-400 uppercase text-[10px] border-b border-slate-800">
                  <tr>
                    <th className="py-2 px-3">Parametro</th>
                    <th className="py-2 px-3">{diffNodeA}</th>
                    <th className="py-2 px-3">{diffNodeB}</th>
                    <th className="py-2 px-3">Stato Allineamento</th>
                    <th className="py-2 px-3">Note Impatto Operativo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {diffData.comparison.map((item: any, i: number) => (
                    <tr key={i} className="hover:bg-slate-850">
                      <td className="py-2 px-3 font-bold text-slate-200">{item.parameter}</td>
                      <td className="py-2 px-3 text-cyan-300 font-semibold">{item.nodeAValue}</td>
                      <td className="py-2 px-3 text-purple-300 font-semibold">{item.nodeBValue}</td>
                      <td className="py-2 px-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          item.match ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-amber-950 text-amber-300 border border-amber-800'
                        }`}>
                          {item.match ? 'ALLINEATO' : 'DISALLINEATO'}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-slate-400 text-[11px]">{item.note || 'Coerente tra i nodi'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
