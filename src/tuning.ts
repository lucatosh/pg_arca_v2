/** Sizing advice from the machine (RAM, CPU) and the workload. Pure. Values are PostgreSQL-ready strings. */
export type Workload = 'oltp' | 'mixed' | 'olap';
export interface Advice { name: string; current: string; recommended: string; why: string; restart: boolean; differs: boolean }
const MB = 1024 * 1024;
const UNIT: Record<string, number> = { shared_buffers: 8192, effective_cache_size: 8192, work_mem: 1024, maintenance_work_mem: 1024, max_wal_size: MB, min_wal_size: MB, checkpoint_timeout: 1 };

/** pg_settings.setting (raw units) → bytes (or seconds for checkpoint_timeout). */
export const rawToNum = (name: string, raw: any): number | null => { const v = Number(raw); return Number.isFinite(v) ? v * (UNIT[name] ?? 1) : null; };
export function fmtMem(bytes: number): string {
  const mb = Math.max(1, Math.round(bytes / MB));
  return mb % 1024 === 0 ? `${mb / 1024}GB` : `${mb}MB`;
}
const fmtCur = (name: string, raw: any) => { const n = rawToNum(name, raw); return n == null ? '—' : name === 'checkpoint_timeout' ? `${n}s` : fmtMem(n); };

export function advise(sys: { cpu: number; mem: number }, settings: Record<string, any>, w: Workload): Advice[] {
  const ram = sys.mem; const cpu = Math.max(1, sys.cpu);
  const maxConn = Number(settings.max_connections) || 100;
  const sb = Math.min(ram * 0.25, 64 * 1024 * MB);
  const ecs = ram * 0.75;
  const maint = Math.min(2 * 1024 * MB, ram / 16);
  const wmDiv = w === 'oltp' ? 3 : w === 'mixed' ? 4 : 6;                       // fewer concurrent sorts per connection in analytic loads → larger share per sort
  const work = Math.max(4 * MB, Math.min((ram - sb) / (maxConn * wmDiv) * (w === 'olap' ? 3 : 1), 1024 * MB));
  const maxWal = w === 'oltp' ? 4096 : w === 'mixed' ? 8192 : 16384;
  const out: [string, string, string, boolean][] = [
    ['shared_buffers', fmtMem(sb), 'Un quarto della RAM: la cache di PostgreSQL. Il resto lo usa la cache del sistema.', true],
    ['effective_cache_size', fmtMem(ecs), 'Tre quarti della RAM: aiuta il planner a scegliere gli indici. Non alloca memoria.', false],
    ['maintenance_work_mem', fmtMem(maint), 'Per VACUUM e creazione indici (max 2GB).', false],
    ['work_mem', fmtMem(work), `Per ogni ordinamento/hash, calcolato su ${maxConn} connessioni: più alto di così rischia di esaurire la RAM.`, false],
    ['max_wal_size', `${maxWal}MB`, 'Meno checkpoint forzati sotto carico di scrittura; più spazio WAL e recovery un po’ più lunga.', false],
    ['checkpoint_completion_target', '0.9', 'Distribuisce le scritture del checkpoint: meno picchi di I/O.', false],
    ['wal_compression', 'on', 'Riduce i WAL (e lo spazio dell’archivio) con un costo CPU contenuto.', false],
  ];
  if (cpu >= 4) out.push(['max_parallel_workers_per_gather', String(Math.min(4, Math.floor(cpu / 2))), 'Parallelismo delle query in base ai core.', false]);
  return out.map(([name, rec, why, restart]) => {
    const raw = settings[name];
    const cur = raw === undefined ? '—' : ['shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem', 'max_wal_size'].includes(name) ? fmtCur(name, raw) : String(raw);
    const same = raw !== undefined && (name in UNIT ? rawToNum(name, raw) === parse(rec, name) : String(raw) === rec);
    return { name, current: cur, recommended: rec, why, restart, differs: !same };
  });
}
function parse(v: string, name: string): number { const m = /^(\d+(?:\.\d+)?)(MB|GB)$/.exec(v); if (!m) return NaN; return Number(m[1]) * (m[2] === 'GB' ? 1024 : 1) * MB; }
