"""Fast WAL forensics: which tables / databases were dropped or emptied, and when, found in the archived WAL.

Why it is fast (the first version copied every segment, ran ONE pg_waldump over all of them and parsed every output line in Python):
  * pg_waldump is told which resource managers to print (-r Transaction -r Storage -r Database), so almost no text is produced; the lines that remain are matched with
    a bytes-level substring test before any regex runs;
  * the archive is cut into windows of a few consecutive segments that are decompressed and scanned in PARALLEL (bounded by `process_max` and CPU count, `nice`d so the
    database server is not disturbed), newest first, each window overlapping the next segment so that a record that straddles a segment boundary is not lost;
  * segments are read without the sha256 / fsync a recovery needs (read-only analysis);
  * the result for every segment is CACHED (state dir) keyed by name + size + mtime: a second scan, or a scan that only extends the window, reads only what is new;
  * the window is bounded (hours / since backup), the scan reports progress, honours cancellation and a time budget, and returns a partial result that says it is partial.
pg_waldump < 16 accepts a single -r: there the scan runs once per resource manager (same windows, same cache).
Nothing here writes to the database or to the archive; the only thing created is the cache file and temporary segment copies in the scratch directory."""

import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from pg_arca.engine.util import EngineError, lsn_to_int, parse_wal_name, wal_name

CACHE_VERSION = 4                     # 4: Storage TRUNCATE (in-place / VACUUM) no longer reported
LSN_RE = re.compile(rb"lsn: ([0-9A-Fa-f]+/[0-9A-Fa-f]+)")
XID_RE = re.compile(rb"tx:\s*(\d+)")
TS_RE = re.compile(rb"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)? [A-Za-z0-9+:-]+)")
PATH_RE = re.compile(r"(?:base|pg_tblspc/\d+/[^/\s]+)/(\d+)/(\d+)")
TRIPLE_RE = re.compile(r"(\d+)/(\d+)/(\d+)")
PAIR_RE = re.compile(r"(\d+)/(\d+)")
FATAL_RE = re.compile(r"(different database system|incorrect|incompatible|not supported|unsupported|could not open|no such file|permission denied|invalid magic)", re.I)

KINDS = {"events": ("Transaction", "Storage", "Database"), "databases": ("Database",)}
CODE = {"events": "E", "databases": "D"}          # what a cache entry holds; "E" (everything) also answers a "D" question


def _major_of(exe):
    try:
        out = subprocess.run([exe, "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=15).stdout
        m = re.search(r"(\d+)(?:\.(\d+))?", out or "")
        return int(m.group(1)) if m else 0
    except (OSError, subprocess.SubprocessError):
        return 0


_ENV = dict(os.environ, TZ="UTC", PGTZ="UTC", LC_ALL="C")        # commit timestamps come out in UTC whatever the server zone is ("CEST" cannot be parsed back reliably)


def _nice():
    try:
        os.nice(10)
    except OSError:
        pass


def _lsn_s(v):
    return "%X/%08X" % (v >> 32, v & 0xFFFFFFFF)


def parse_line(line):
    """One pg_waldump line (bytes) -> event dict or None. Cheap tests first; regex only on the few lines that pass them."""
    if line.startswith(b"rmgr: Transaction"):
        if b"rels:" not in line or b"COMMIT" not in line:
            return None
        rels = PATH_RE.findall(line.split(b"rels:", 1)[1].decode("ascii", "replace"))
        if not rels:
            return None
        ts = TS_RE.search(line.split(b"COMMIT", 1)[1])
        kind = "DROP"
    elif line.startswith(b"rmgr: Storage") and b"CREATE" in line:
        # a new relation file. Alone it means nothing; with a COMMIT of the SAME transaction that drops files it is how TRUNCATE (and table rewrites:
        # VACUUM FULL, CLUSTER, ALTER TABLE ... TYPE) look in the WAL since PostgreSQL gives the emptied table a new file instead of truncating the old one
        rels = PATH_RE.findall(line.split(b"desc:", 1)[-1].decode("ascii", "replace"))
        if not rels:
            return None
        ts = None
        kind = "CREATE"
    elif line.startswith(b"rmgr: Storage"):
        # "TRUNCATE ... to N" is never the loss of committed data: PostgreSQL truncates a file in place only when the table was created (or already given a
        # new file) in the SAME transaction, and VACUUM trims empty trailing pages (to 0 after everything was DELETEd: the loss was the DELETE, earlier).
        # A real TRUNCATE gives the table a new file (Storage CREATE + COMMIT dropping the old one, see fold_creates). On PostgreSQL 18 VACUUM's record even
        # carries an xid, so it cannot be told apart by that: reporting these was a false "table emptied" (version matrix, PG18).
        return None
    elif line.startswith(b"rmgr: Database"):
        if b"DROP" not in line:
            return None
        desc = line.split(b"desc:", 1)[-1].decode("ascii", "replace")
        m = re.search(r"dir\s+(\d+)/(\d+)", desc)
        pairs = [m.groups()] if m else PAIR_RE.findall(desc)
        if not pairs:
            return None
        rels = [(p[1], "") for p in pairs]                  # (database oid, -)
        ts = None
        kind = "DROP DATABASE"
    else:
        return None
    m_lsn, m_xid = LSN_RE.search(line), XID_RE.search(line)
    if not m_lsn:
        return None
    return {"lsn": m_lsn.group(1).decode(), "xid": m_xid.group(1).decode() if m_xid else "?", "time": ts.group(1).decode() if ts else None,
            "kind": kind, "rels": [[a, b] for a, b in rels][:12], "nrels": len(rels)}


def fold_creates(events):
    """COMMIT that drops files + new files created by the same transaction = the table was emptied (TRUNCATE) or rewritten: report it as TRUNCATE, named
    after the NEW files (those the catalog knows today), with the caveat that a rewrite looks the same. Lone CREATE events are not reported."""
    made = {}
    for e in events:
        if e["kind"] == "CREATE" and e.get("xid") not in (None, "?", "0"):
            made.setdefault(e["xid"], []).extend(e["rels"])
    out = []
    for e in events:
        if e["kind"] == "CREATE":
            continue
        if e["kind"] == "DROP" and e.get("xid") in made:
            new = made[e["xid"]]
            out.append(dict(e, kind="TRUNCATE", rewrite_possible=True, rels=new[:12], nrels=len(new)))
            if e.get("nrels", len(e["rels"])) > len(new):         # the same transaction also dropped other relations (DROP TABLE ...; TRUNCATE ...): keep the DROP too
                out.append(dict(e, nrels=e.get("nrels", len(e["rels"])) - len(new), mixed=True))
            continue
        out.append(e)
    return out


class Cache(object):
    """Per-segment results, one JSON file per stanza. Thread-safe; written atomically; entries for segments that left the archive are dropped."""

    def __init__(self, path, seg_size):
        self.path, self.seg_size, self.lock, self.data, self.dirty = path, seg_size, threading.Lock(), {"v": CACHE_VERSION, "seg_size": seg_size, "segs": {}}, False
        if path:
            try:
                import json
                with open(path) as f:
                    d = json.load(f)
                if d.get("v") == CACHE_VERSION and d.get("seg_size") == seg_size:
                    self.data = d
            except (OSError, ValueError):
                pass

    def get(self, name, sig, code):
        e = self.data["segs"].get(name)
        if e and e.get("s") == sig and (e.get("k") == code or e.get("k") == "E"):
            return e["e"]
        return None

    def put(self, name, sig, code, events):
        with self.lock:
            self.data["segs"][name] = {"s": sig, "k": code, "e": events}
            self.dirty = True

    def save(self, keep=None):
        if not self.path:
            return
        with self.lock:
            if keep is not None and any(k not in keep for k in self.data["segs"]):
                self.dirty = True
        if not self.dirty:
            return
        with self.lock:
            if keep is not None:
                self.data["segs"] = dict((k, v) for k, v in self.data["segs"].items() if k in keep)
            try:
                from pg_arca.config import atomic_write_json
                atomic_write_json(self.path, self.data)
                self.dirty = False
            except OSError:
                pass


def _sig(path):
    st = os.stat(path)
    return "%d:%d" % (st.st_size, int(st.st_mtime))


def _plan(names, seg_size, per_chunk):
    """names (archived segments, any order) -> windows [(tli, [segment names], extra_following_name_or_None)] newest first. A window never crosses a gap or a timeline."""
    byt = {}
    for n in names:
        p = parse_wal_name(n, seg_size)
        if p:
            byt.setdefault(p[0], []).append((p[1], n))
    avail = set(names)
    out = []
    for tli, lst in byt.items():
        lst.sort()
        cur = []
        for segno, n in lst:
            if cur and (segno != cur[-1][0] + 1 or len(cur) >= per_chunk):
                out.append((tli, cur))
                cur = []
            cur.append((segno, n))
        if cur:
            out.append((tli, cur))
    plan = []
    for tli, cur in out:
        nxt = wal_name(tli, cur[-1][0] + 1, seg_size)
        plan.append((tli, [n for _, n in cur], nxt if nxt in avail else None))
    plan.sort(key=lambda w: (w[1][-1]), reverse=True)
    return plan


def _detect_seg_size(ctx, name, tmp_root):
    """WAL segment size really used by the cluster: the size of one decompressed segment (initdb --wal-segsize can change it; the agent configuration may not know)."""
    tmp = tempfile.mkdtemp(prefix="pgarca-seg-", dir=tmp_root)
    try:
        dest = os.path.join(tmp, name)
        if ctx.wal.retrieve_segment(name, dest, verify=False)[0] == 0:
            sz = os.path.getsize(dest)
            if sz >= 1 << 20 and (sz & (sz - 1)) == 0:
                return sz
    except OSError:
        pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return ctx.seg_size


def _scan_window(ctx, exe, multi, tli, names, extra, rmgrs, tmp_root, seg_size, cancel):
    """Decompress one window (+ the following segment, only so that a record straddling the boundary can be read), run pg_waldump, return {segment name: [events]}.
    Events are attributed to the segment where the RECORD STARTS; the extra segment's own records belong to the next window."""
    tmp = tempfile.mkdtemp(prefix="w-", dir=tmp_root)
    try:
        load = list(names) + ([extra] if extra else [])
        for n in load:
            if cancel and cancel():
                raise EngineError("PGA-OP-900", "analysis cancelled")
            code, msg = ctx.wal.retrieve_segment(n, os.path.join(tmp, n), verify=False)
            if code != 0:
                if n == extra:
                    load.remove(n)
                    extra = None
                    break
                raise EngineError("PGA-WAL-050", "cannot read archived segment %s: %s" % (n, msg))
        own = dict((parse_wal_name(n, seg_size)[1], n) for n in names)
        res = dict((n, []) for n in names)
        groups = [list(rmgrs)] if multi else [[r] for r in rmgrs]
        for g in groups:
            args = [exe, "-p", tmp, "-t", str(tli)]
            for r in g:
                args += ["-r", r]
            args += [load[0], load[-1]]
            with tempfile.TemporaryFile() as errf:
                p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errf, preexec_fn=_nice, env=_ENV)
                for line in p.stdout:
                    ev = parse_line(line)
                    if not ev:
                        continue
                    n = own.get(lsn_to_int(ev["lsn"]) // seg_size)
                    if n:
                        res[n].append(ev)
                    if cancel and cancel():
                        p.kill()
                        break
                p.stdout.close()
                p.wait()
                if p.returncode not in (0, None):
                    errf.seek(0)
                    err = errf.read().decode("utf-8", "replace")
                    # reaching the end of the written WAL is reported as an error by pg_waldump; anything else that looks like an incompatibility is real
                    if FATAL_RE.search(err) and not any(res.values()):
                        raise EngineError("PGA-WAL-060", "pg_waldump cannot read these segments: %s" % err.strip().splitlines()[-1][:300],
                                          "use the pg_waldump of the same PostgreSQL major version as the WAL (Nodi → Percorsi e rilevamento)")
        return res
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _commit_time(ctx, exe, multi, tli, start_name, xid, tmp_root, seg_size, cancel):
    """Timestamp of the COMMIT of transaction `xid` (DROP DATABASE records carry none): forward from its segment, at most 3 segments."""
    p0 = parse_wal_name(start_name, seg_size)
    if not p0:
        return None
    tmp = tempfile.mkdtemp(prefix="c-", dir=tmp_root)
    try:
        got = []
        for k in range(3):
            n = wal_name(tli, p0[1] + k, seg_size)
            if ctx.wal.retrieve_segment(n, os.path.join(tmp, n), verify=False)[0] != 0:
                break
            got.append(n)
        if not got:
            return None
        with tempfile.TemporaryFile() as errf:
            p = subprocess.Popen([exe, "-p", tmp, "-t", str(tli), "-x", str(xid), "-r", "Transaction", got[0], got[-1]], stdout=subprocess.PIPE, stderr=errf, preexec_fn=_nice, env=_ENV)
            out = p.stdout.read()
            p.stdout.close()
            p.wait()
        for line in out.splitlines():
            if b"COMMIT" in line:
                m = TS_RE.search(line.split(b"COMMIT", 1)[1])
                if m:
                    return m.group(1).decode()
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


_ISO_RE = re.compile(r"^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,6}))?)?)?\s*(Z|UTC|[+-]\d\d(?::?\d\d)?)?$")


def _parse_iso(s):
    """ISO 8601 / "YYYY-MM-DD hh:mm:ss[.ffffff] [UTC|Z|+hh[:mm]]" -> epoch seconds (no tz = UTC). datetime.fromisoformat does not exist before Python 3.7 (RHEL 8 runs 3.6)."""
    m = _ISO_RE.match((s or "").strip())
    if not m:
        return None
    y, mo, d, hh, mi, ss, frac, tz = m.groups()
    try:
        base = datetime(int(y), int(mo), int(d), int(hh or 0), int(mi or 0), int(ss or 0), int((frac or "0").ljust(6, "0")), tzinfo=timezone.utc)
    except ValueError:
        return None
    off = 0
    if tz and tz not in ("Z", "UTC"):
        sign = -1 if tz[0] == "-" else 1
        digits = tz[1:].replace(":", "")
        off = sign * (int(digits[:2]) * 3600 + int(digits[2:4] or 0) * 60)
    return base.timestamp() - off


def _seg_times(ctx, names):
    """name -> mtime of the archived object (≈ when the segment was completed)."""
    out = {}
    for n in names:
        p, _ = ctx.wal._find(n)
        if p:
            try:
                out[n] = (os.stat(p).st_mtime, _sig(p))
            except OSError:
                pass
    return out


def _catalog_names(ctx, sets=4):
    """(dboid, relfilenode) -> 'db.schema.name' and dboid -> dbname, from the latest backups (newest wins), plus the set of database names."""
    rel, dbs = {}, {}
    try:
        for s in reversed(ctx.repo.complete_sets()[-sets:]):
            try:
                cat = ctx.repo.load_catalog(s)
            except EngineError:
                continue
            for dbname, d in cat["databases"].items():
                dbs.setdefault(str(d["oid"]), dbname)
                for r in d["relations"]:
                    rel.setdefault((str(d["oid"]), str(r["relfilenode"])), ("%s.%s.%s" % (dbname, r["schema"], r["name"]), r.get("kind") or "?"))
    except EngineError:
        pass
    return rel, dbs


def _live_names(ctx, pairs, rel, dbs):
    """Names the backup catalogs do not know (relations created after the last backup, and the NEW files a TRUNCATE gave a table) from the running
    cluster itself: pg_relation_filenode() in each database concerned. Read-only, bounded; any failure just leaves the numbers."""
    want = {}
    for d, f in pairs:
        if (str(d), str(f)) not in rel:
            want.setdefault(str(d), set()).add(str(f))
    if not want or not getattr(ctx, "conn", None):
        return
    try:
        from pg_arca.engine.pgsession import PgSession
        s = PgSession(ctx.conn, read_only=True)
        try:
            names = dict((str(r[0]), r[1]) for r in s.query("SELECT oid, datname FROM pg_database WHERE datallowconn") if len(r) >= 2)
        finally:
            s.close()
        for d, files in list(want.items())[:50]:
            dn = names.get(d)
            if not dn:
                continue
            nums = ",".join(sorted(x for x in files if x.isdigit())[:500])
            if not nums:
                continue
            s = PgSession(ctx.conn.with_db(dn), read_only=True)
            try:
                for r in s.query("SELECT pg_relation_filenode(c.oid), n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                                 "WHERE pg_relation_filenode(c.oid) IN (%s)" % nums):
                    if len(r) >= 4 and r[0]:
                        rel[(d, str(r[0]))] = ("%s.%s.%s" % (dn, r[1], r[2]), r[3])
                dbs.setdefault(d, dn)
            finally:
                s.close()
    except Exception:
        pass


def window_start(ctx, hours=None, since_backup=False, since_iso=None):
    """Epoch seconds from which segments are considered. since_backup: the start of the latest complete backup (a database that exists in it and not today was dropped after it)."""
    t = _parse_iso(since_iso) if since_iso else None
    if t:
        return t - 900
    if since_backup:
        try:
            s = ctx.repo.resolve_set("latest")
            t = _parse_iso(s.get("start_time"))
            if t:
                return t - 900
        except EngineError:
            pass
    if hours:
        return time.time() - float(hours) * 3600
    return 0


def scan(ctx, mode="events", hours=24, since_backup=False, since_iso=None, since=None, until=None, limit=20, cache_dir=None, progress=None, cancel=None, budget_sec=900, workers=None, detail=False):
    """Returns {"events": [...ascending...], "segments_scanned", "segments_cached", "segments_total", "complete", "window": {...}, "elapsed_sec", ["suggestion"]}.
    mode "events": DROP / TRUNCATE / DROP DATABASE; mode "databases": only DROP DATABASE (the cheap one: no Transaction records are printed)."""
    if mode not in KINDS:
        raise EngineError("PGA-GEN-010", "unknown analysis mode '%s'" % mode)
    t0 = time.time()
    exe = ctx.conn.exe("pg_waldump")
    if os.path.sep in exe and not os.path.exists(exe):
        raise EngineError("PGA-WAL-061", "pg_waldump not found (%s)" % exe, "install the PostgreSQL server binaries or set the path in Nodi → Percorsi e rilevamento")
    allsegs = ctx.wal.list_segments()
    if not allsegs:
        raise EngineError("PGA-WAL-002", "the WAL archive is empty")
    if since:
        allsegs = [s for s in allsegs if s >= since]
    if until:
        allsegs = [s for s in allsegs if s <= until]
    times = _seg_times(ctx, allsegs)
    allsegs = [s for s in allsegs if s in times]
    cut = window_start(ctx, hours, since_backup, since_iso)
    segs = [s for s in allsegs if times[s][0] >= cut]
    if not segs:
        raise EngineError("PGA-WAL-002", "no archived WAL segment in the requested window", "widen the window")
    tmp_root = ctx.scratch_dir if ctx.scratch_dir and (os.path.isdir(ctx.scratch_dir) or _mk(ctx.scratch_dir)) else tempfile.gettempdir()
    tmp_root = tempfile.mkdtemp(prefix="pgarca-wal-", dir=tmp_root)
    try:
        seg_size = _detect_seg_size(ctx, segs[-1], tmp_root)
        major = _major_of(exe)
        multi = major >= 16
        rmgrs, code = KINDS[mode], CODE[mode]
        cache = Cache(os.path.join(cache_dir, "%s.json" % re.sub(r"[^A-Za-z0-9_.-]", "_", ctx.stanza)) if cache_dir else None, seg_size)
        # per-window size: bounded by the free space of the scratch directory (a segment is seg_size uncompressed)
        try:
            free = shutil.disk_usage(tmp_root).free
        except OSError:
            free = 1 << 33
        cpu = os.cpu_count() or 2
        nw = max(1, min(int(workers or ctx.process_max), cpu, 6))
        per = 8
        while per > 1 and free < nw * (per + 1) * seg_size * 2:
            per //= 2
        if free < 2 * (per + 1) * seg_size:
            raise EngineError("PGA-WAL-062", "not enough free space in %s for the analysis (%d MiB free)" % (tmp_root, free >> 20), "set a scratch directory on a bigger volume (Parametri avanzati)")
        todo, found, cached_n = [], {}, 0
        for n in segs:
            hit = cache.get(n, times[n][1], code)
            if hit is not None:
                found[n] = hit
                cached_n += 1
            else:
                todo.append(n)
        plan = _plan(todo, seg_size, per)
        done = [cached_n]
        state = {"oldest": None, "stop": False}
        lock = threading.Lock()

        def report(msg):
            if progress:
                progress({"phase": "scan", "segments": done[0], "segments_total": len(segs), "events": sum(len(v) for v in found.values()), "msg": msg})

        report("%d segmenti nella finestra, %d già in cache" % (len(segs), cached_n))

        def work(w):
            tli, names, extra = w
            if state["stop"] or (cancel and cancel()):
                return None
            res = _scan_window(ctx, exe, multi, tli, names, extra, rmgrs, tmp_root, seg_size, cancel)
            for n, evs in res.items():
                for e in evs:
                    e["tli"] = tli
                cache.put(n, times[n][1], code, evs)
            return res

        partial = False
        if plan:
            with ThreadPoolExecutor(max_workers=nw) as ex:
                futs = [ex.submit(work, w) for w in plan]
                try:
                    last_save = time.time()
                    for f in as_completed(futs):
                        if f.cancelled():
                            continue
                        res = f.result()
                        if res is None:
                            continue
                        with lock:
                            for n, evs in res.items():
                                found[n] = evs
                            done[0] += len(res)
                        report("scansione dei WAL in corso")
                        if cancel and cancel():
                            raise EngineError("PGA-OP-900", "analysis cancelled")
                        if budget_sec and time.time() - t0 > budget_sec:
                            state["stop"] = partial = True
                            for g in futs:
                                g.cancel()
                        if time.time() - last_save > 10:
                            cache.save()
                            last_save = time.time()
                except BaseException:
                    state["stop"] = True
                    for g in futs:
                        g.cancel()
                    cache.save()
                    raise
        cache.save(keep=set(ctx.wal.list_segments()))
        scanned = [n for n in segs if n in found]
        events = []
        for n in scanned:
            for e in found[n]:
                e = dict(e)
                e["seg"] = n
                events.append(e)
        if mode == "databases":
            events = [e for e in events if e["kind"] == "DROP DATABASE"]     # a cache entry from a full scan also holds table events
        events = fold_creates(events)
        events.sort(key=lambda e: lsn_to_int(e["lsn"]))
        events = events[-max(1, int(limit or 20)) * (3 if mode == "events" else 5):]      # head-room: names / filters below may drop some
        # names
        rel_names, db_names = _catalog_names(ctx)
        # only the files of TRUNCATE events exist now (a dropped file number found alive would be a reuse, i.e. a wrong name)
        _live_names(ctx, [tuple(r) for e in events if e["kind"] == "TRUNCATE" for r in e["rels"]], rel_names, db_names)
        # exact time of DROP DATABASE (and of events without one): approximated by the segment's archive time when the commit cannot be found
        report("risolvo date e nomi")
        out = []
        for e in events:
            if e["kind"] == "DROP DATABASE":
                dboids = [r[0] for r in e["rels"]]
                e["dboids"] = dboids
                e["names"] = [db_names.get(o, "database OID %s" % o) for o in dboids]
                e["detail"] = "DROP DATABASE " + ", ".join(e["names"])
                if not e.get("time") and e["xid"] != "?" and len([x for x in out if x["kind"] == "DROP DATABASE"]) < 25:
                    try:
                        e["time"] = _commit_time(ctx, exe, multi, e["tli"], e["seg"], e["xid"], tmp_root, seg_size, cancel)
                    except (EngineError, OSError):
                        e["time"] = None
                    if e.get("time"):                                    # persist it: the next scan will not look again
                        for c in cache.data["segs"].get(e["seg"], {}).get("e", []):
                            if c.get("lsn") == e["lsn"]:
                                c["time"] = e["time"]
                                cache.dirty = True
            else:
                got = [rel_names.get((str(a), str(b)), ("%s/%s" % (a, b), "?")) for a, b in e["rels"]]
                tabs = [n for n, k in got if k in ("r", "p", "m")]           # indexes, TOAST tables and sequences travel with their table: name the tables
                e["names"] = (tabs or [n for n, _ in got])[:6]
                e["ntables"] = len(tabs)
                if detail:
                    e["tables"] = tabs[:400]                              # every table of the event (the UI matches them against what exists now)
            if e.get("time"):
                e["time_exact"] = True
            else:
                e["time"] = datetime.fromtimestamp(times[e["seg"]][0], timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
                e["time_exact"] = False
            out.append(e)
        cache.save()
        out = out[-max(1, int(limit or 20)):]
        res = {"mode": mode, "events": out, "segments_scanned": len(scanned), "segments_cached": cached_n, "segments_total": len(allsegs), "complete": not partial,
               "window": {"from": datetime.fromtimestamp(min(times[n][0] for n in segs), timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"), "hours": hours or 0,
                          "since_backup": bool(since_backup), "segments": len(segs)},
               "workers": nw, "per_window": per, "pg_waldump_major": major, "elapsed_sec": round(time.time() - t0, 2)}
        if mode == "events" and out:
            last = out[-1]
            res["suggestion"] = {"target_lsn": last["lsn"], "inclusive": False, "note": "restoring with this LSN and inclusive=false stops just BEFORE the last event"}
        if mode == "databases":
            dropped = {}
            for e in out:
                for o, nm in zip(e.get("dboids", []), e.get("names", [])):
                    dropped[o] = {"oid": o, "name": None if nm.startswith("database OID") else nm, "time": e["time"], "time_exact": e["time_exact"], "xid": e["xid"], "lsn": e["lsn"]}
            res["dropped"] = list(dropped.values())
        return res
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def _mk(path):
    try:
        os.makedirs(path, exist_ok=True)
        return True
    except OSError:
        return False
