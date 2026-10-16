"""Pack files: thousands of chunks per file instead of one file per 64 KiB chunk.

Why. With one file per chunk a 100 GB database is 1.6 million files: every one costs a create, a rename and, on dedup, a stat. On local
disks that is a visible share of a full backup; on the network shares enterprises keep backups on (NFS, SMB) each of those is a round trip
of milliseconds, and the metadata alone takes longer than the copy. Every serious backup tool (restic, borg, pgBackRest's bundles) stores
chunks in large files for this reason. pg_arca does the same from repository format 2; the per-file layout stays readable forever.

Layout
  <repo>/cas/packs/<id>.pack        header (16 bytes) + records [32-byte hash][u32 length][blob]; blob = tag + compressed (+encrypted) chunk,
                                    exactly what the per-file layout stored in <repo>/cas/aa/bb/<hash>
  <repo>/cas/packs/<id>.idx         header (16 bytes) + records [32-byte hash][u64 offset][u32 length], sorted by hash
  <repo>/cas/packs/<id>.pack.open   a pack still being written (a crash leaves it: garbage-collected after the grace period)
A pack is sealed (fsync, renamed, its index written and fsynced) when it reaches PACK_MAX or when the backup commits (`Repo.flush`),
always BEFORE the manifest that references its chunks is written. Packs are immutable: garbage collection deletes a pack whose chunks are all
dead and re-packs the live chunks of a pack that is mostly dead (new pack written and sealed first, the old one deleted after).

Index in memory (`ChunkIndex`): the sorted list of hashes (bytes) with two arrays for locations, ~55 bytes per chunk (a 100 GB database
is ~90 MB), loaded once per process from the .idx files; lookups are a C-level bisect. Chunks written by this process go to a dictionary
first and are folded into the sorted lists every FOLD_AT entries.
"""

import array
import bisect
import os
import re
import socket
import struct
import threading
import time
import uuid

from pg_arca.engine.util import EngineError, fsync_dir

PACK_MAGIC = b"PGARCAPK"
IDX_MAGIC = b"PGARCAIX"
FORMAT = 2
HDR_LEN = 16                         # magic(8) + u32 format + u32 reserved
REC_HDR = struct.Struct("<32sI")     # hash, blob length
IDX_REC = struct.Struct("<32sQI")    # hash, offset, blob length
CACHE_LAYOUT = 3                     # index.cache = keys (32 B each) + locations (int64, pack number relative to the root) + lengths (uint32) + token (32 B, = .json)
PACK_MAX = int(os.environ.get("PG_ARCA_PACK_MAX_MB", "256")) * 1048576
FOLD_AT = 262144                     # recent entries folded into the sorted index (about 64 packs of 64 KiB chunks)
OFF_BITS = 40                        # pack number << 40 | offset (packs of up to 1 TiB)


def packs_dir(root):
    return os.path.join(root, "cas", "packs")


def _hdr(magic):
    return magic + struct.pack("<II", FORMAT, 0)


def read_idx(path):
    """[(hash bytes, offset, length)] of a sealed pack, in hash order."""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < HDR_LEN or data[:8] != IDX_MAGIC:
        raise EngineError("PGA-REPO-070", "pack index %s is not a pg_arca index" % path, "run a deep verify; the pack can be re-indexed from its content")
    n = struct.unpack_from("<I", data, 12)[0]
    if len(data) != HDR_LEN + n * IDX_REC.size:
        raise EngineError("PGA-REPO-070", "pack index %s is truncated" % path, "run a deep verify; the pack can be re-indexed from its content")
    return [IDX_REC.unpack_from(data, HDR_LEN + i * IDX_REC.size) for i in range(n)]


def idx_count(path):
    """Number of chunks a sealed pack holds (header only: no record read)."""
    with open(path, "rb") as f:
        hd = f.read(HDR_LEN)
    if len(hd) < HDR_LEN or hd[:8] != IDX_MAGIC:
        return 0
    return struct.unpack_from("<I", hd, 12)[0]


def write_idx(path, entries):
    """entries: iterable of (hash bytes, offset, length). tmp + fsync + rename."""
    entries = sorted(entries, key=lambda e: e[0])
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "wb") as f:
        f.write(IDX_MAGIC + struct.pack("<II", FORMAT, len(entries)))
        for hb, off, ln in entries:
            f.write(IDX_REC.pack(hb, off, ln))
        f.flush()
        os.fsync(f.fileno())
    os.rename(tmp, path)


def scan_pack(path):
    """Walk a pack's records from its content (no index): yields (hash bytes, offset, length). Used to re-index a pack whose index is missing
    or damaged; stops at the first record that does not fit in the file (a crash while writing)."""
    with open(path, "rb") as f:
        hd = f.read(HDR_LEN)
        if len(hd) < HDR_LEN or hd[:8] != PACK_MAGIC:
            return
        size = os.fstat(f.fileno()).st_size
        off = HDR_LEN
        while off + REC_HDR.size <= size:
            hb, ln = REC_HDR.unpack(f.read(REC_HDR.size))
            if ln == 0 or off + REC_HDR.size + ln > size:
                return
            yield hb, off + REC_HDR.size, ln
            off += REC_HDR.size + ln
            f.seek(off)


_seq = [0]
_seq_lock = threading.Lock()


def new_pack_id():
    with _seq_lock:
        _seq[0] += 1
        n = _seq[0]
    host = re.sub(r"[^A-Za-z0-9_]", "_", socket.gethostname().split(".")[0][:24]) or "host"
    # + a random part: two agents with the same short host name (db1.dc1 / db1.dc2, containers with a fixed host name and PID 1) starting in the
    # same second had the same id and overwrote each other's pack in a shared repository (independent engine review)
    return "%s-%s-%d-%d-%s" % (time.strftime("%Y%m%dT%H%M%S", time.gmtime()), host, os.getpid(), n, uuid.uuid4().hex[:8])


class PackWriter(object):
    """One pack being written by one thread. `append` returns the offset of the blob; `seal` makes it durable and indexed."""

    def __init__(self, root):
        d = packs_dir(root)
        os.makedirs(d, mode=0o750, exist_ok=True)
        self.id = new_pack_id()
        self.final = os.path.join(d, self.id + ".pack")
        self.idx = os.path.join(d, self.id + ".idx")
        self.open_path = self.final + ".open"
        self.f = open(self.open_path, "xb")                     # never truncate someone else's pack
        self.f.write(_hdr(PACK_MAGIC))
        self.size = HDR_LEN
        self.entries = []
        self.sealed = False
        self.broken = False

    def append(self, hb, blob):
        off = self.size + REC_HDR.size
        try:
            self.f.write(REC_HDR.pack(hb, len(blob)))
            self.f.write(blob)
        except BaseException:
            self.broken = True                                 # a partial record is in the file: nothing of this pack can be trusted
            raise
        self.size = off + len(blob)
        self.entries.append((hb, off, len(blob)))
        return off

    def seal(self):
        if self.sealed:
            return
        if self.broken:
            self.abort()
            return
        self.sealed = True
        self.f.flush()
        os.fsync(self.f.fileno())
        self.f.close()
        if not self.entries:                                   # nothing was written: no pack at all
            os.unlink(self.open_path)
            return
        os.rename(self.open_path, self.final)                  # the pack first, then its index: an index never points at a missing pack
        write_idx(self.idx, self.entries)
        fsync_dir(os.path.dirname(self.final))

    def abort(self):
        """Discard an open pack (nothing of it is referenced yet)."""
        if self.sealed:
            return
        self.sealed = True
        try:
            self.f.close()
        finally:
            try:
                os.unlink(self.open_path)
            except OSError:
                pass


class Table(object):
    """Sorted, compact table of (hash, location): one bytes blob of 32-byte hashes (binary search by slicing) + two arrays: 44 bytes per chunk
    (a Python list of bytes objects costs ~100). Immutable: a merge builds a new table."""
    __slots__ = ("keys", "locs", "lens", "n")

    def __init__(self, keys=b"", locs=None, lens=None):
        self.keys = bytes(keys)
        self.locs = locs if locs is not None else array.array("q")
        self.lens = lens if lens is not None else array.array("I")
        self.n = len(self.keys) // 32

    def find(self, hb):
        """index of hb or -1."""
        keys, lo, hi = self.keys, 0, self.n
        while lo < hi:
            mid = (lo + hi) >> 1
            k = keys[mid * 32:mid * 32 + 32]
            if k < hb:
                lo = mid + 1
            elif k > hb:
                hi = mid
            else:
                return mid
        return -1

    def records(self):
        """(hash, packed location, length) in hash order."""
        keys, locs, lens = self.keys, self.locs, self.lens
        for i in range(self.n):
            yield keys[i * 32:i * 32 + 32], locs[i], lens[i]

    @staticmethod
    def merge(streams):
        """A table from sorted streams of (hash, packed location, length): linear, no list of every hash in memory."""
        import heapq
        keys, locs, lens = bytearray(), array.array("q"), array.array("I")
        last = None
        for hb, loc, ln in heapq.merge(*streams):
            if hb == last:
                continue                                       # the same chunk stored twice (two writers, a repack): one entry is enough
            last = hb
            keys += hb
            locs.append(loc)
            lens.append(ln)
        return Table(bytes(keys), locs, lens)

    def without_pack(self, pn):
        return Table.merge([((hb, loc, ln) for hb, loc, ln in self.records() if (loc >> OFF_BITS) != pn)])


def _idx_stream(entries, pn):
    for hb, off, ln in entries:
        yield hb, (pn << OFF_BITS) | off, ln


CACHE_NAME = "index.cache"                   # merged table of every sealed pack of a root, rebuilt by whoever finds it stale


class ChunkIndex(object):
    """hash (32 bytes) -> (pack path, offset, length) over every sealed pack of the given roots, plus what this process wrote since."""

    def __init__(self, roots, readonly=False):
        self.roots = list(roots)
        self.readonly = readonly                               # never write the index cache (a previous location opened for reading)
        self.own_prefix = packs_dir(self.roots[0]) + os.sep
        self.packs = []                                        # pack number -> path
        self.tab = Table()                                     # swapped as a whole by a fold or a reload
        self.recent = {}                                       # hash -> (pack number, offset, length)
        self.lock = threading.Lock()
        self.problems = []                                     # indexes that could not be read (reported by verify)
        self.load()

    # ---- loading
    def _root_table(self, root, packs, writable):
        """Table of one root from its cache plus the .idx files the cache does not know; the cache is rewritten when it was incomplete.
        packs: list to extend with the pack paths (their position = pack number); entries carry pack numbers."""
        d = packs_dir(root)
        if not os.path.isdir(d):
            return None
        idx_names = sorted(n for n in os.listdir(d) if n.endswith(".idx") and os.path.exists(os.path.join(d, n[:-4] + ".pack")))
        base = len(packs)
        cached, cached_names = None, []
        cp = os.path.join(d, CACHE_NAME)
        try:
            with open(cp + ".json") as f:
                import json
                meta = json.load(f)
            names = list(meta.get("packs") or [])
            cnt = int(meta.get("count") or 0)
            tok = str(meta.get("token") or "").encode("ascii")
            if names and meta.get("layout") == CACHE_LAYOUT and len(tok) == 32 and all(n in idx_names for n in names):
                with open(cp, "rb") as f:
                    blob = f.read()
                # the blob ends with the token of the .json written with it: a blob and a .json of two different writers never pair up
                if len(blob) == cnt * 44 + 32 and blob[-32:] == tok:
                    cached_names = names
                    cached = (blob[:-32], cnt)
        except (IOError, OSError, ValueError):
            cached = None
        for n in cached_names:
            packs.append(os.path.join(d, n[:-4] + ".pack"))
        tab = None
        if cached is not None:                                 # the table's own layout: three slices, no per-record work
            blob, cnt = cached
            locs = array.array("q")
            locs.frombytes(blob[32 * cnt:40 * cnt])
            lens = array.array("I")
            lens.frombytes(blob[40 * cnt:44 * cnt])
            if base:
                shift = base << OFF_BITS
                locs = array.array("q", (v + shift for v in locs))
            tab = Table(blob[:32 * cnt], locs, lens)
        fresh = [n for n in idx_names if n not in cached_names]
        streams = [tab.records()] if tab is not None and fresh else []
        for n in fresh:
            try:
                entries = read_idx(os.path.join(d, n))
            except (EngineError, OSError) as e:
                self.problems.append("%s: %s" % (n, e))
                continue
            pn = len(packs)
            packs.append(os.path.join(d, n[:-4] + ".pack"))
            streams.append(_idx_stream(entries, pn))           # a function, not a generator expression: pn and entries are bound NOW
        if streams:
            tab = Table.merge(streams)
        elif tab is None:
            tab = Table()
        if writable and fresh and tab.n and len(fresh) + len(cached_names) >= 2:   # never written into a previous location (read-only)
            self._write_cache(d, tab, base, packs[base:])
        return tab

    def _write_cache(self, d, tab, base, pack_paths):
        """index.cache in the table's own layout (keys, locations with pack numbers RELATIVE to this root, lengths) + .json listing the packs; best effort."""
        import json
        token = uuid.uuid4().hex
        tmp = os.path.join(d, CACHE_NAME + ".tmp.%d.%s" % (os.getpid(), token[:8]))
        try:
            locs = tab.locs if not base else array.array("q", (v - (base << OFF_BITS) for v in tab.locs))
            with open(tmp, "wb") as f:
                f.write(tab.keys)
                f.write(locs.tobytes())
                f.write(tab.lens.tobytes())
                f.write(token.encode("ascii"))
            os.rename(tmp, os.path.join(d, CACHE_NAME))
            with open(tmp, "w") as f:
                json.dump({"layout": CACHE_LAYOUT, "packs": [os.path.basename(p)[:-5] + ".idx" for p in pack_paths], "count": tab.n, "token": token}, f)
            os.rename(tmp, os.path.join(d, CACHE_NAME + ".json"))
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    def load(self):
        packs, tabs = [], []
        for i, root in enumerate(self.roots):
            t = self._root_table(root, packs, writable=(i == 0 and not self.readonly))
            if t is not None and t.n:
                tabs.append(t)
        tab = tabs[0] if len(tabs) == 1 else (Table.merge([t.records() for t in tabs]) if tabs else Table())
        with self.lock:
            self.packs = packs
            self.tab = tab
            self.recent = {}

    def __len__(self):
        return self.tab.n + len(self.recent)

    # ---- lookups
    def find(self, hb, own_only=False):
        """(pack path, offset, length) or None. own_only: only packs of the first root (the writable location), not of previous locations."""
        r = self.recent.get(hb)
        if r is not None:
            return self.packs[r[0]], r[1], r[2]
        tab = self.tab                                         # swapped atomically by a fold or a reload
        i = tab.find(hb)
        if i >= 0:
            v = tab.locs[i]
            path = self.packs[v >> OFF_BITS]
            if own_only and not path.startswith(self.own_prefix):
                return None
            return path, v & ((1 << OFF_BITS) - 1), tab.lens[i]
        return None

    def pack_number(self, path):
        with self.lock:
            try:
                return self.packs.index(path)
            except ValueError:
                self.packs.append(path)
                return len(self.packs) - 1

    def add(self, hb, pack_path, off, ln):
        pn = self.pack_number(pack_path)
        with self.lock:
            self.recent[hb] = (pn, off, ln)
            fold = len(self.recent) >= FOLD_AT
        if fold:
            self.fold()

    def forget_pack(self, path):
        """Drop every entry of a pack that was aborted (its file is gone): a later dedup must not point at it."""
        with self.lock:
            if path not in self.packs:
                return
            pn = self.packs.index(path)
            self.recent = dict((k, v) for k, v in self.recent.items() if v[0] != pn)
            self.tab = self.tab.without_pack(pn)

    def fold(self):
        """Merge the recent dictionary into the sorted table (a new table is built and swapped, readers never see a half state)."""
        with self.lock:
            if not self.recent:
                return
            items = sorted((k, (v[0] << OFF_BITS) | v[1], v[2]) for k, v in self.recent.items())
            self.tab = Table.merge([self.tab.records(), iter(items)])
            self.recent = {}


class PackReader(object):
    """Open pack files of one thread, reused across reads (a restore reads millions of chunks)."""

    def __init__(self, max_open=32):
        self.fds = {}
        self.order = []
        self.max_open = max_open

    def read(self, path, off, ln):
        fd = self.fds.get(path)
        if fd is None:
            fd = os.open(path, os.O_RDONLY)
            self.fds[path] = fd
            self.order.append(path)
            while len(self.order) > self.max_open:
                old = self.order.pop(0)
                try:
                    os.close(self.fds.pop(old))
                except OSError:
                    pass
        data = os.pread(fd, ln, off)
        if len(data) != ln:
            raise EngineError("PGA-VRF-001", "pack %s is shorter than its index says (offset %d)" % (os.path.basename(path), off),
                              "storage damage: restore the repository from a copy")
        return data

    def close(self):
        for fd in self.fds.values():
            try:
                os.close(fd)
            except OSError:
                pass
        self.fds, self.order = {}, []

    def __del__(self):
        self.close()


def list_packs(root):
    """[(pack path, idx path or None, mtime, size)] of a root; open packs (`.pack.open`) are listed with idx None."""
    d = packs_dir(root)
    out = []
    if not os.path.isdir(d):
        return out
    for name in sorted(os.listdir(d)):
        if name.endswith(".pack") or name.endswith(".pack.open"):
            p = os.path.join(d, name)
            try:
                st = os.stat(p)
            except OSError:
                continue
            idx = os.path.join(d, name[:-5] + ".idx") if name.endswith(".pack") else None
            out.append((p, idx if idx and os.path.exists(idx) else None, st.st_mtime, st.st_size))
    return out


def repack(root, pack_path, keep):
    """Write the records of `pack_path` whose hash is in `keep` into a new sealed pack; returns (new pack path or None, bytes kept)."""
    entries = read_idx(pack_path[:-5] + ".idx")
    live = [e for e in entries if e[0] in keep]
    if not live:
        return None, 0
    w = PackWriter(root)
    kept = 0
    try:
        with open(pack_path, "rb") as f:
            for hb, off, ln in sorted(live, key=lambda e: e[1]):
                f.seek(off)
                blob = f.read(ln)
                if len(blob) != ln:
                    raise EngineError("PGA-VRF-001", "pack %s is shorter than its index says" % os.path.basename(pack_path))
                w.append(hb, blob)
                kept += ln
        w.seal()
    except BaseException:
        w.abort()
        raise
    return w.final, kept
