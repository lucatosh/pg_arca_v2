import React, { useState } from 'react';
import {
  Lock,
  ShieldCheck,
  CheckCircle2,
  FileCode,
  HardDrive,
  Copy,
  Check,
  Search,
  ExternalLink,
  AlertTriangle,
  Zap,
  Info
} from 'lucide-react';

export interface WalSegmentRecord {
  fileName: string;
  timeline: number;
  startLSN: string;
  endLSN: string;
  sizeBytes: number;
  sha256: string;
  archivedAt: string;
  transactionsCount: number;
  compression: 'zstd' | 'lz4' | 'none';
  status: 'CERTIFIED_ARCHIVED' | 'IN_FLIGHT';
}

interface ImmutableWalInspectorProps {
  selectedSegmentName: string | null;
  onSelectSegment: (segment: WalSegmentRecord) => void;
  targetLSN: string;
  targetTime: string;
}

export const defaultWalCatalog: WalSegmentRecord[] = [
  {
    fileName: '000000010000000000000028',
    timeline: 1,
    startLSN: '0/18000000',
    endLSN: '0/18FFFFFF',
    sizeBytes: 16777216,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    archivedAt: '2026-10-08T00:15:22Z',
    transactionsCount: 1420,
    compression: 'zstd',
    status: 'CERTIFIED_ARCHIVED'
  },
  {
    fileName: '000000010000000000000029',
    timeline: 1,
    startLSN: '0/19000000',
    endLSN: '0/19FFFFFF',
    sizeBytes: 16777216,
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    archivedAt: '2026-10-08T03:00:10Z',
    transactionsCount: 2890,
    compression: 'zstd',
    status: 'CERTIFIED_ARCHIVED'
  },
  {
    fileName: '00000001000000000000002A',
    timeline: 1,
    startLSN: '0/1A000000',
    endLSN: '0/1AFFFFFF',
    sizeBytes: 16777216,
    sha256: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
    archivedAt: '2026-10-08T06:00:48Z',
    transactionsCount: 3120,
    compression: 'zstd',
    status: 'CERTIFIED_ARCHIVED'
  },
  {
    fileName: '00000001000000000000002B',
    timeline: 1,
    startLSN: '0/1B000000',
    endLSN: '0/1BFFFFFF',
    sizeBytes: 16777216,
    sha256: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a',
    archivedAt: '2026-10-08T08:30:15Z',
    transactionsCount: 4500,
    compression: 'zstd',
    status: 'CERTIFIED_ARCHIVED'
  },
  {
    fileName: '00000001000000000000002C',
    timeline: 1,
    startLSN: '0/1C000000',
    endLSN: '0/1CFFFFFF',
    sizeBytes: 16777216,
    sha256: 'ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d',
    archivedAt: '2026-10-08T09:45:00Z',
    transactionsCount: 5210,
    compression: 'zstd',
    status: 'CERTIFIED_ARCHIVED'
  },
  {
    fileName: '00000001000000000000002D',
    timeline: 1,
    startLSN: '0/1D000000',
    endLSN: '0/1DFFFFFF',
    sizeBytes: 16777216,
    sha256: 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    archivedAt: '2026-10-08T10:15:00Z',
    transactionsCount: 3980,
    compression: 'zstd',
    status: 'CERTIFIED_ARCHIVED'
  },
  {
    fileName: '00000001000000000000002E',
    timeline: 1,
    startLSN: '0/1E000000',
    endLSN: '0/1EFFFFFF',
    sizeBytes: 16777216,
    sha256: 'cad8e1329c36209b55263a234f9644342531da7e53f191a92e10c73294c770c0',
    archivedAt: '2026-10-08T11:42:00Z',
    transactionsCount: 6840,
    compression: 'zstd',
    status: 'CERTIFIED_ARCHIVED'
  },
  {
    fileName: '00000001000000000000002F',
    timeline: 1,
    startLSN: '0/1F000000',
    endLSN: '0/1FFFFFFF',
    sizeBytes: 16777216,
    sha256: '4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865',
    archivedAt: '2026-10-08T13:00:00Z',
    transactionsCount: 7100,
    compression: 'zstd',
    status: 'CERTIFIED_ARCHIVED'
  }
];

export const ImmutableWalInspector: React.FC<ImmutableWalInspectorProps> = ({
  selectedSegmentName,
  onSelectSegment,
  targetLSN,
  targetTime
}) => {
  const [copiedName, setCopiedName] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [showCatalogModal, setShowCatalogModal] = useState(false);

  // Active segment
  const activeSeg = defaultWalCatalog.find(s => s.fileName === selectedSegmentName) || defaultWalCatalog[6];

  const filteredCatalog = defaultWalCatalog.filter(s => {
    if (!filterQuery) return true;
    const q = filterQuery.toLowerCase();
    return s.fileName.toLowerCase().includes(q) || s.startLSN.toLowerCase().includes(q) || s.endLSN.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-3 font-mono text-xs">
      {/* Field Protection Header */}
      <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-slate-300 font-bold flex items-center gap-1.5 text-xs">
            <Lock className="w-3.5 h-3.5 text-amber-400" />
            Segmento WAL Fisico (Identificatore Immutabile):
          </label>
          <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 flex items-center gap-1">
            <ShieldCheck className="w-3 h-3" /> Immutabile (Anti-Tampering)
          </span>
        </div>

        {/* Read-Only Protected Field with Copy & Selector Button */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              readOnly
              value={activeSeg.fileName}
              className="w-full bg-slate-900/90 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-cyan-300 font-bold select-all cursor-not-allowed"
              title="Questo campo è rigorosamente immutabile. Il nome del file WAL corrisponde alla posizione binaria esatta nel catalogo dei registri."
            />
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-slate-500">
              <Lock className="w-3.5 h-3.5 text-slate-500" />
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(activeSeg.fileName);
              setCopiedName(true);
              setTimeout(() => setCopiedName(false), 2000);
            }}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition cursor-pointer"
            title="Copia nome file WAL"
          >
            {copiedName ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={() => setShowCatalogModal(true)}
            className="px-3 py-2 bg-cyan-950 hover:bg-cyan-900 text-cyan-300 border border-cyan-800 rounded-lg text-xs font-bold font-mono transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
          >
            <Search className="w-3.5 h-3.5" />
            Catalogo WAL ({defaultWalCatalog.length})
          </button>
        </div>

        {/* Explanatory DBA Note */}
        <div className="text-[11px] text-slate-400 flex items-start gap-1.5 bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/80 leading-relaxed font-sans">
          <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
          <span>
            <strong className="text-slate-200">Garanzia di Sicurezza Enterprise:</strong> Il nome del file WAL (es. <code className="text-cyan-300 font-mono">{activeSeg.fileName}</code>) è calcolato deterministicamente da timeline, ID log e offset del segmento. Non può essere modificato a mano per scongiurare disallineamenti di checkpoint o blocchi irreversibili dell'istanza durante il replay.
          </span>
        </div>

        {/* Metadata of active segment */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[11px]">
          <div className="p-2 rounded bg-slate-900 border border-slate-800">
            <span className="text-slate-500 block text-[10px]">LSN Range:</span>
            <span className="text-white font-bold">{activeSeg.startLSN} → {activeSeg.endLSN}</span>
          </div>
          <div className="p-2 rounded bg-slate-900 border border-slate-800">
            <span className="text-slate-500 block text-[10px]">Dimensione File:</span>
            <span className="text-emerald-400 font-bold">16.0 MiB ({activeSeg.compression})</span>
          </div>
          <div className="p-2 rounded bg-slate-900 border border-slate-800">
            <span className="text-slate-500 block text-[10px]">Transazioni Nel Segmento:</span>
            <span className="text-amber-300 font-bold">{activeSeg.transactionsCount} tx commit</span>
          </div>
          <div className="p-2 rounded bg-slate-900 border border-slate-800">
            <span className="text-slate-500 block text-[10px]">Archiviato UTC:</span>
            <span className="text-cyan-300 font-bold truncate block">{activeSeg.archivedAt}</span>
          </div>
        </div>
      </div>

      {/* Catalog Selector Modal */}
      {showCatalogModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-3xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-white text-sm">Catalogo Segmenti WAL Certificati per PITR</h3>
              </div>
              <button
                onClick={() => setShowCatalogModal(false)}
                className="text-slate-400 hover:text-white px-2 py-1 rounded-lg hover:bg-slate-800 text-xs font-mono"
              >
                Chiudi [ESC]
              </button>
            </div>

            <div className="p-4 border-b border-slate-800 bg-slate-950/60">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={filterQuery}
                  onChange={e => setFilterQuery(e.target.value)}
                  placeholder="Filtra per nome file WAL esatto (es. 00000001000000000000002E) o LSN..."
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>
            </div>

            <div className="overflow-y-auto p-3 space-y-2 max-h-[55vh]">
              {filteredCatalog.map(seg => {
                const isSelected = seg.fileName === activeSeg.fileName;
                return (
                  <div
                    key={seg.fileName}
                    onClick={() => {
                      onSelectSegment(seg);
                      setShowCatalogModal(false);
                    }}
                    className={`p-3 rounded-xl border cursor-pointer transition flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${
                      isSelected
                        ? 'bg-amber-950/40 border-amber-500 text-white shadow-md'
                        : 'bg-slate-950 border-slate-800 hover:border-slate-700 text-slate-300'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold font-mono text-cyan-300 text-xs">{seg.fileName}</span>
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono">
                          TIMELINE {seg.timeline}
                        </span>
                        {isSelected && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-950 text-amber-300 border border-amber-800 font-mono font-bold">
                            ATTIVO
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 flex items-center gap-3">
                        <span>LSN: <strong className="text-white">{seg.startLSN} → {seg.endLSN}</strong></span>
                        <span>Archiviato: <strong className="text-slate-300">{seg.archivedAt}</strong></span>
                        <span>Tx: <strong className="text-amber-300">{seg.transactionsCount}</strong></span>
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono truncate max-w-lg">
                        SHA256: {seg.sha256}
                      </div>
                    </div>

                    <button
                      type="button"
                      className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition shrink-0 ${
                        isSelected
                          ? 'bg-amber-500 text-slate-950'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
                      }`}
                    >
                      {isSelected ? 'Selezionato' : 'Usa Questo'}
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="p-3 bg-slate-950 border-t border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
              <span>Tutti i segmenti sono indicizzati nell'archivio continuo pg_arca.</span>
              <span className="font-bold text-emerald-400">Continuità 100% verificata (0 gap)</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
