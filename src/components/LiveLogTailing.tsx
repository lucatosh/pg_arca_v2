import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Terminal,
  Play,
  Pause,
  RotateCcw,
  Download,
  Copy,
  Check,
  Search,
  Filter,
  Trash2,
  Activity,
  Layers,
  ArrowDown,
  Wifi,
  WifiOff,
  Server,
  ShieldAlert,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
  Clock,
  ExternalLink,
  Info
} from 'lucide-react';
import { ManagedCluster } from '../App';

export interface LiveLogEntry {
  id: string;
  timestamp: string;
  clusterId: string;
  clusterName: string;
  nodeName: string;
  nodeHost: string;
  service: 'patroni' | 'postgres' | 'wal_archiver' | 'agent' | 'etcd';
  level: 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'DEBUG';
  message: string;
  raw: string;
  details?: Record<string, any>;
}

interface LiveLogTailingProps {
  cluster?: ManagedCluster | null;
  clusters?: ManagedCluster[];
  activeClusterId?: string;
  onSelectCluster?: (clusterId: string) => void;
}

export const LiveLogTailing: React.FC<LiveLogTailingProps> = ({
  cluster,
  clusters = [],
  activeClusterId,
  onSelectCluster
}) => {
  // Connection and stream state
  const [logs, setLogs] = useState<LiveLogEntry[]>([]);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [linesPerSecond, setLinesPerSecond] = useState<number>(0);
  
  // Filters state
  const [selectedClusterId, setSelectedClusterId] = useState<string>(activeClusterId || cluster?.id || (clusters[0]?.id || 'all'));
  const [selectedNode, setSelectedNode] = useState<string>('all');
  const [selectedService, setSelectedService] = useState<'all' | 'patroni' | 'postgres' | 'wal_archiver' | 'agent' | 'etcd'>('all');
  const [selectedLevel, setSelectedLevel] = useState<'all' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isRegex, setIsRegex] = useState<boolean>(false);
  
  // UI Display state
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [userScrolledUp, setUserScrolledUp] = useState<boolean>(false);
  const [showTimestampFormat, setShowTimestampFormat] = useState<'utc' | 'local' | 'relative'>('utc');
  const [copied, setCopied] = useState<boolean>(false);
  const [selectedLogForDetails, setSelectedLogForDetails] = useState<LiveLogEntry | null>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(false);

  // Refs
  const logContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const incomingCountRef = useRef<number>(0);
  const pingStartRef = useRef<number>(0);
  const reconnectTimeoutRef = useRef<any>(null);
  const activeCluster = cluster || clusters.find(c => c.id === selectedClusterId);

  // Synchronize when parent prop cluster changes
  useEffect(() => {
    if (cluster?.id && cluster.id !== selectedClusterId) {
      setSelectedClusterId(cluster.id);
      setSelectedNode('all');
    }
  }, [cluster?.id]);

  // Rate calculation (rolling 1-second interval)
  useEffect(() => {
    const rateInterval = setInterval(() => {
      setLinesPerSecond(incomingCountRef.current);
      incomingCountRef.current = 0;
    }, 1000);
    return () => clearInterval(rateInterval);
  }, []);

  // Fetch initial logs buffer via REST API first for immediate display
  useEffect(() => {
    let isCancelled = false;
    const fetchInitial = async () => {
      try {
        const queryParams = new URLSearchParams();
        if (selectedClusterId && selectedClusterId !== 'all') queryParams.append('clusterId', selectedClusterId);
        if (selectedNode && selectedNode !== 'all') queryParams.append('nodeName', selectedNode);
        if (selectedService && selectedService !== 'all') queryParams.append('service', selectedService);
        if (selectedLevel && selectedLevel !== 'all') queryParams.append('level', selectedLevel);
        queryParams.append('limit', '300');

        const res = await fetch(`/api/logs/history?${queryParams.toString()}`);
        if (res.ok) {
          const data = await res.json();
          if (!isCancelled && Array.isArray(data.entries)) {
            setLogs(data.entries);
          }
        }
      } catch (err) {
        console.warn('Initial logs fetch fallback error:', err);
      }
    };
    fetchInitial();
    return () => {
      isCancelled = true;
    };
  }, [selectedClusterId]);

  // WebSocket Connection Management
  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {
        // ignore
      }
      wsRef.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/logs`;

    setWsStatus('connecting');

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsStatus('connected');
        // Send initial subscription options
        ws.send(JSON.stringify({
          type: 'subscribe',
          clusterId: selectedClusterId,
          nodeName: selectedNode,
          service: selectedService,
          minLevel: selectedLevel,
          search: searchQuery
        }));

        // Initial latency check
        pingStartRef.current = Date.now();
        ws.send(JSON.stringify({ type: 'ping' }));
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'pong') {
            const rtt = Date.now() - pingStartRef.current;
            setLatencyMs(rtt);
            return;
          }

          if (payload.type === 'init' && Array.isArray(payload.logs)) {
            setLogs(prev => {
              const existingIds = new Set(prev.map(l => l.id));
              const fresh = payload.logs.filter((l: LiveLogEntry) => !existingIds.has(l.id));
              const combined = [...prev, ...fresh].slice(-2000);
              return combined;
            });
            return;
          }

          if (payload.type === 'log' && payload.entry) {
            incomingCountRef.current += 1;
            if (!isPaused) {
              setLogs(prev => {
                // Keep buffer bounded at 2000 items to avoid DOM performance degradation
                const next = [...prev, payload.entry];
                if (next.length > 2000) {
                  return next.slice(next.length - 2000);
                }
                return next;
              });
            }
          }
        } catch (e) {
          // ignore corrupted frame
        }
      };

      ws.onerror = () => {
        setWsStatus('disconnected');
      };

      ws.onclose = () => {
        setWsStatus('reconnecting');
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          connectWebSocket();
        }, 3000);
      };
    } catch (err) {
      setWsStatus('disconnected');
    }
  }, [selectedClusterId, selectedNode, selectedService, selectedLevel, searchQuery, isPaused]);

  // Connect on mount and update subscription when filters change
  useEffect(() => {
    connectWebSocket();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [selectedClusterId]);

  // Periodic ping for live latency
  useEffect(() => {
    const pingInterval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        pingStartRef.current = Date.now();
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 5000);
    return () => clearInterval(pingInterval);
  }, []);

  // Update subscription when filter states change
  useEffect(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'filter',
        clusterId: selectedClusterId,
        nodeName: selectedNode,
        service: selectedService,
        minLevel: selectedLevel,
        search: searchQuery,
        isPaused
      }));
    }
  }, [selectedClusterId, selectedNode, selectedService, selectedLevel, searchQuery, isPaused]);

  // Handle Autoscroll
  const scrollToBottom = useCallback(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      setUserScrolledUp(false);
    }
  }, []);

  useEffect(() => {
    if (autoScroll && !userScrolledUp) {
      scrollToBottom();
    }
  }, [logs, autoScroll, userScrolledUp, scrollToBottom]);

  const handleScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    if (!isAtBottom) {
      setUserScrolledUp(true);
    } else {
      setUserScrolledUp(false);
    }
  };

  // Filtered Logs
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // Cluster filter
      if (selectedClusterId !== 'all' && log.clusterId !== selectedClusterId) {
        return false;
      }
      // Node filter
      if (selectedNode !== 'all' && log.nodeName !== selectedNode) {
        return false;
      }
      // Service filter
      if (selectedService !== 'all' && log.service !== selectedService) {
        return false;
      }
      // Level filter
      if (selectedLevel !== 'all' && log.level !== selectedLevel) {
        return false;
      }
      // Query filter
      if (searchQuery.trim()) {
        if (isRegex) {
          try {
            const regex = new RegExp(searchQuery, 'i');
            if (!regex.test(log.message) && !regex.test(log.nodeName) && !regex.test(log.raw)) {
              return false;
            }
          } catch (e) {
            return false;
          }
        } else {
          const q = searchQuery.toLowerCase();
          if (!log.message.toLowerCase().includes(q) &&
              !log.nodeName.toLowerCase().includes(q) &&
              !log.raw.toLowerCase().includes(q)) {
            return false;
          }
        }
      }
      return true;
    });
  }, [logs, selectedClusterId, selectedNode, selectedService, selectedLevel, searchQuery, isRegex]);

  // Clear buffer
  const handleClearBuffer = () => {
    setLogs([]);
    setSelectedLogForDetails(null);
  };

  // Copy filtered logs
  const handleCopyLogs = () => {
    const text = filteredLogs.map(l => l.raw || `[${l.timestamp}] [${l.level}] [${l.service}] [${l.nodeName}] ${l.message}`).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Download logs
  const handleDownloadLogs = () => {
    const text = filteredLogs.map(l => l.raw || `[${l.timestamp}] [${l.level}] [${l.service}] [${l.nodeName}] ${l.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `pg_arca_${selectedClusterId}_${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Timestamp formatting
  const formatTimestamp = (iso: string) => {
    try {
      const d = new Date(iso);
      if (showTimestampFormat === 'local') {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
      }
      if (showTimestampFormat === 'relative') {
        const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
        if (diffSec < 2) return 'just now';
        if (diffSec < 60) return `${diffSec}s ago`;
        return `${Math.floor(diffSec / 60)}m ago`;
      }
      // UTC standard ISO time
      return iso.replace('T', ' ').replace('Z', '').slice(11, 23);
    } catch (e) {
      return iso;
    }
  };

  // Text highlighting
  const renderMessageWithHighlight = (msg: string) => {
    if (!searchQuery.trim()) return msg;
    try {
      const parts = isRegex
        ? msg.split(new RegExp(`(${searchQuery})`, 'gi'))
        : msg.split(new RegExp(`(${searchQuery.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')})`, 'gi'));
      return parts.map((part, i) => {
        const isMatch = isRegex
          ? new RegExp(`^${searchQuery}$`, 'i').test(part)
          : part.toLowerCase() === searchQuery.toLowerCase();
        return isMatch ? (
          <mark key={i} className="bg-yellow-400 text-slate-950 font-semibold px-0.5 rounded">
            {part}
          </mark>
        ) : (
          part
        );
      });
    } catch (e) {
      return msg;
    }
  };

  // Node options for selector
  const availableNodes = useMemo(() => {
    if (!activeCluster) return [];
    return activeCluster.haState.nodes || [];
  }, [activeCluster]);

  return (
    <div className={`flex flex-col bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden transition-all duration-200 ${isExpanded ? 'fixed inset-4 z-50' : 'h-[750px] w-full'}`}>
      {/* 1. Header Toolbar: Status, Controls, Rate & Connectivity */}
      <div className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-cyan-950 border border-cyan-800 text-cyan-400">
              <Terminal className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-100 text-sm">Live Log Stream</span>
                <span className="text-[10px] text-cyan-400 font-semibold uppercase">WebSocket RFC 6455</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <span>{activeCluster?.name || 'Tutti i Cluster'}</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums font-semibold text-slate-300">{filteredLogs.length} righe visibili</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums text-cyan-400">{linesPerSecond} msg/s</span>
              </div>
            </div>
          </div>
        </div>

        {/* WebSocket Connection Telemetry Indicator */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-[11px]">
            {wsStatus === 'connected' ? (
              <>
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-300 font-medium">WS Connesso</span>
                {latencyMs !== null && (
                  <span className="text-slate-400 tabular-nums ml-1">({latencyMs}ms)</span>
                )}
              </>
            ) : wsStatus === 'connecting' || wsStatus === 'reconnecting' ? (
              <>
                <RotateCcw className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                <span className="text-amber-300 font-medium">Riconnessione...</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3.5 h-3.5 text-red-400" />
                <span className="text-red-400 font-medium">Disconnesso</span>
              </>
            )}
          </div>

          {/* Stream Pause / Resume Control */}
          <button
            onClick={() => setIsPaused(prev => !prev)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition cursor-pointer text-xs ${
              isPaused
                ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-sm'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
            }`}
            title={isPaused ? 'Riprendi flusso live' : 'Metti in pausa il tailing dei log'}
          >
            {isPaused ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5" />}
            <span>{isPaused ? 'Riprendi' : 'Pausa'}</span>
          </button>

          {/* Autoscroll Toggle */}
          <button
            onClick={() => {
              setAutoScroll(prev => !prev);
              if (!autoScroll) scrollToBottom();
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition border cursor-pointer ${
              autoScroll
                ? 'bg-cyan-950 text-cyan-300 border-cyan-800'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
            }`}
            title="Aggancia lo scorrimento alla fine del buffer (Autoscroll)"
          >
            <ArrowDown className={`w-3.5 h-3.5 ${autoScroll ? 'text-cyan-400' : 'text-slate-500'}`} />
            <span className="hidden sm:inline">Autoscroll</span>
          </button>

          {/* Copy Logs Button */}
          <button
            onClick={handleCopyLogs}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition cursor-pointer"
            title="Copia log filtrati negli appunti"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          {/* Download Logs */}
          <button
            onClick={handleDownloadLogs}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition cursor-pointer"
            title="Scarica log filtrati come file .log"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          {/* Clear Buffer */}
          <button
            onClick={handleClearBuffer}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-red-950/60 hover:text-red-300 hover:border-red-800 text-slate-400 border border-slate-700 transition cursor-pointer"
            title="Svuota buffer locale"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          {/* Maximize / Minimize Viewport */}
          <button
            onClick={() => setIsExpanded(prev => !prev)}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition cursor-pointer"
            title={isExpanded ? 'Riduci visualizzazione' : 'Espandi a schermo intero'}
          >
            {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* 2. Filter & Navigation Rail: Clusters, Nodes, Services, Level & Search */}
      <div className="bg-slate-900/90 border-b border-slate-800 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
        <div className="flex flex-wrap items-center gap-2">
          {/* Cluster Switcher if on global view */}
          {clusters.length > 0 && (
            <div className="flex items-center gap-1.5 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800">
              <Server className="w-3.5 h-3.5 text-cyan-400" />
              <select
                value={selectedClusterId}
                onChange={e => {
                  setSelectedClusterId(e.target.value);
                  setSelectedNode('all');
                  if (onSelectCluster && e.target.value !== 'all') {
                    onSelectCluster(e.target.value);
                  }
                }}
                className="bg-transparent text-slate-200 focus:outline-none cursor-pointer pr-1"
              >
                <option value="all" className="bg-slate-900">Tutti i Cluster</option>
                {clusters.map(c => (
                  <option key={c.id} value={c.id} className="bg-slate-900">
                    {c.name} ({c.environment})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Node Switcher */}
          <div className="flex items-center gap-1.5 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800">
            <span className="text-slate-400 text-[11px]">Nodo:</span>
            <select
              value={selectedNode}
              onChange={e => setSelectedNode(e.target.value)}
              className="bg-transparent text-cyan-300 font-semibold focus:outline-none cursor-pointer pr-1"
            >
              <option value="all" className="bg-slate-900">Tutti i Nodi</option>
              {availableNodes.map(n => (
                <option key={n.name} value={n.name} className="bg-slate-900">
                  {n.name} ({n.role})
                </option>
              ))}
            </select>
          </div>

          {/* Service Switcher */}
          <div className="flex items-center gap-1.5 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800">
            <span className="text-slate-400 text-[11px]">Servizio:</span>
            <select
              value={selectedService}
              onChange={e => setSelectedService(e.target.value as any)}
              className="bg-transparent text-slate-200 focus:outline-none cursor-pointer pr-1"
            >
              <option value="all" className="bg-slate-900">Tutti i Servizi</option>
              <option value="patroni" className="bg-slate-900">Patroni HA (8008)</option>
              <option value="postgres" className="bg-slate-900">PostgreSQL Core (5432)</option>
              <option value="wal_archiver" className="bg-slate-900">WAL Archiver & CAS</option>
              <option value="agent" className="bg-slate-900">pg_arca Node Agent</option>
              <option value="etcd" className="bg-slate-900">ETCD DCS (2379)</option>
            </select>
          </div>

          {/* Severity Level Switcher */}
          <div className="flex items-center gap-1.5 bg-slate-950 px-2 py-1 rounded-lg border border-slate-800">
            <span className="text-slate-400 text-[11px]">Livello:</span>
            <select
              value={selectedLevel}
              onChange={e => setSelectedLevel(e.target.value as any)}
              className="bg-transparent text-slate-200 focus:outline-none cursor-pointer pr-1"
            >
              <option value="all" className="bg-slate-900">Tutti i Livelli</option>
              <option value="FATAL" className="bg-slate-900 text-rose-400">FATAL / PANIC</option>
              <option value="ERROR" className="bg-slate-900 text-red-400">ERROR</option>
              <option value="WARN" className="bg-slate-900 text-amber-400">WARN</option>
              <option value="INFO" className="bg-slate-900 text-cyan-400">INFO</option>
              <option value="DEBUG" className="bg-slate-900 text-slate-400">DEBUG</option>
            </select>
          </div>
        </div>

        {/* Search Query Input */}
        <div className="flex items-center gap-2 flex-1 max-w-md min-w-[240px]">
          <div className="relative w-full">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Filtra testo, query, LSN, PID, error code..."
              className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-lg pl-8 pr-16 py-1 text-slate-100 placeholder-slate-500 focus:outline-none text-xs"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-8 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                ✕
              </button>
            )}
            <button
              onClick={() => setIsRegex(prev => !prev)}
              className={`absolute right-2 top-1/2 -translate-y-1/2 px-1 py-0.5 rounded text-[10px] font-bold transition ${
                isRegex ? 'bg-cyan-500 text-slate-950' : 'text-slate-500 hover:text-slate-300'
              }`}
              title="Attiva/Disattiva espressioni regolari (Regex)"
            >
              .*
            </button>
          </div>

          {/* Time display toggle */}
          <button
            onClick={() => setShowTimestampFormat(prev => prev === 'utc' ? 'local' : prev === 'local' ? 'relative' : 'utc')}
            className="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-400 hover:text-slate-200 text-[11px] shrink-0"
            title="Cambia formato ora: UTC / Locale / Relativo"
          >
            {showTimestampFormat.toUpperCase()}
          </button>
        </div>
      </div>

      {/* 3. Terminal Log Output Viewport */}
      <div className="relative flex-1 bg-[#070b14] overflow-hidden flex flex-col font-mono text-xs select-text">
        {/* Floating "Resume Autoscroll" pill if user scrolled up */}
        {userScrolledUp && (
          <button
            onClick={() => {
              setUserScrolledUp(false);
              setAutoScroll(true);
              scrollToBottom();
            }}
            className="absolute bottom-4 right-6 z-20 flex items-center gap-2 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-full shadow-lg text-xs font-semibold cursor-pointer transition animate-bounce"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            <span>Riprendi Scorrimento ({logs.length - filteredLogs.length} nuovi)</span>
          </button>
        )}

        {/* Scrollable list */}
        <div
          ref={logContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-3 space-y-0.5 divide-y divide-slate-900/60"
        >
          {filteredLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-500">
              <Terminal className="w-10 h-10 text-slate-600 mb-3 opacity-50" />
              <p className="text-sm font-medium text-slate-300">Nessun log corrispondente ai filtri attivi</p>
              <p className="text-xs text-slate-500 mt-1 max-w-md">
                In attesa di nuovi eventi dal cluster o prova ad azzerare il testo di ricerca e i filtri di severità.
              </p>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="mt-3 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-400 rounded-lg text-xs"
                >
                  Azzera Ricerca
                </button>
              )}
            </div>
          ) : (
            filteredLogs.map((log, idx) => {
              const isSelected = selectedLogForDetails?.id === log.id;
              
              // Level color coding
              const levelColor =
                log.level === 'FATAL' ? 'text-rose-400 bg-rose-950/80 border-rose-800' :
                log.level === 'ERROR' ? 'text-red-400 bg-red-950/80 border-red-800' :
                log.level === 'WARN' ? 'text-amber-300 bg-amber-950/80 border-amber-800' :
                log.level === 'INFO' ? 'text-cyan-400 bg-cyan-950/60 border-cyan-800' :
                'text-slate-400 bg-slate-900 border-slate-800';

              // Service color coding
              const serviceColor =
                log.service === 'patroni' ? 'text-cyan-300' :
                log.service === 'postgres' ? 'text-emerald-300' :
                log.service === 'wal_archiver' ? 'text-purple-300' :
                log.service === 'agent' ? 'text-orange-300' :
                'text-indigo-300';

              return (
                <div
                  key={log.id || `${log.timestamp}-${idx}`}
                  onClick={() => setSelectedLogForDetails(isSelected ? null : log)}
                  className={`group flex items-start gap-3 py-1 px-2 rounded hover:bg-slate-900/80 cursor-pointer transition ${
                    isSelected ? 'bg-cyan-950/40 border-l-2 border-cyan-400' : ''
                  }`}
                >
                  {/* Line Index */}
                  <span className="text-[11px] text-slate-600 w-10 text-right shrink-0 select-none tabular-nums font-mono">
                    {idx + 1}
                  </span>

                  {/* Timestamp */}
                  <span className="text-slate-500 tabular-nums shrink-0 whitespace-nowrap text-[11px]">
                    {formatTimestamp(log.timestamp)}
                  </span>

                  {/* Severity Badge */}
                  <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold border shrink-0 uppercase tracking-wide tabular-nums ${levelColor}`}>
                    {log.level.padEnd(5, ' ')}
                  </span>

                  {/* Service Badge */}
                  <span className={`font-semibold shrink-0 text-[11px] ${serviceColor}`}>
                    [{log.service}]
                  </span>

                  {/* Node Name */}
                  <span className="text-slate-400 shrink-0 text-[11px]">
                    [{log.nodeName}]
                  </span>

                  {/* Log Message Content */}
                  <span className="text-slate-200 flex-1 break-all whitespace-pre-wrap leading-relaxed">
                    {renderMessageWithHighlight(log.message)}
                  </span>

                  {/* Inspect Details indicator */}
                  <div className="opacity-0 group-hover:opacity-100 transition shrink-0 text-slate-500">
                    <ChevronRight className="w-3.5 h-3.5" />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 4. Structured Log Details Drawer (when a row is clicked) */}
        {selectedLogForDetails && (
          <div className="border-t border-slate-800 bg-slate-900/95 p-4 max-h-64 overflow-y-auto text-xs animate-in slide-in-from-bottom-4">
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-cyan-400" />
                <span className="font-bold text-slate-100">Dettaglio Strutturato Evento Log</span>
                <span className="text-slate-400">ID: {selectedLogForDetails.id}</span>
              </div>
              <button
                onClick={() => setSelectedLogForDetails(null)}
                className="text-slate-400 hover:text-slate-200 px-2 py-0.5 rounded bg-slate-800 text-xs cursor-pointer"
              >
                Chiudi
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1">
                <div className="text-[11px] text-slate-400">Timestamp Completo (ISO-8601 UTC):</div>
                <div className="text-cyan-300 font-mono select-all">{selectedLogForDetails.timestamp}</div>

                <div className="text-[11px] text-slate-400 mt-2">Nodo & Host Fisico:</div>
                <div className="text-slate-200 font-mono">{selectedLogForDetails.nodeName} ({selectedLogForDetails.nodeHost})</div>
              </div>

              <div className="space-y-1">
                <div className="text-[11px] text-slate-400">Servizio Origine & Severità:</div>
                <div className="text-slate-200 font-mono font-bold uppercase">
                  {selectedLogForDetails.service} • {selectedLogForDetails.level}
                </div>

                <div className="text-[11px] text-slate-400 mt-2">Cluster ID:</div>
                <div className="text-slate-300 font-mono">{selectedLogForDetails.clusterId} ({selectedLogForDetails.clusterName})</div>
              </div>

              <div className="space-y-1">
                <div className="text-[11px] text-slate-400">Record Raw / Metadati JSON:</div>
                <pre className="bg-slate-950 p-2 rounded text-[11px] text-emerald-400 overflow-x-auto max-h-24 font-mono select-all">
                  {JSON.stringify(selectedLogForDetails.details || { raw: selectedLogForDetails.raw }, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 5. Status Footer Bar */}
      <div className="bg-slate-900 border-t border-slate-800 px-4 py-2 flex flex-wrap items-center justify-between text-[11px] text-slate-400 font-mono">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
            <span>Patroni / Postgres Real-Time Stream</span>
          </div>
          <span aria-hidden="true">·</span>
          <span>Buffer: {logs.length} / 2000 log</span>
          <span aria-hidden="true">·</span>
          <span>Filtro Attivo: {selectedService !== 'all' ? selectedService : 'Tutti i servizi'} ({selectedLevel !== 'all' ? selectedLevel : 'Tutti i livelli'})</span>
        </div>

        <div className="flex items-center gap-2">
          <span>{isPaused ? 'Flusso in pausa' : 'Streaming attivo'}</span>
          <span aria-hidden="true">·</span>
          <span className="text-slate-500">pg_arca v1.0.0 Enterprise</span>
        </div>
      </div>
    </div>
  );
};
