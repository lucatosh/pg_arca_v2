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
import socket
import struct
import threading
import time

from pg_arca.engine.util import EngineError, fsync_dir

PACK_MAGIC = b"PGARCAPK"
IDX_MAGIC = b"PGARCAIX"
FORMAT = 2
HDR_LEN = 16                         # magic(8) + u32 format + u32 reserved
REC_HDR = struct.Struct("<32sI")     # hash, blob length
IDX_REC = struct.Struct("<32sQI")    # hash, offset, blob length
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
    host = socket.gethostname().split(".")[0][:24] or "host"
    return "%s-%s-%d-%d" % (time.strftime("%Y%m%dT%H%M%S", time.gmtime()), host, os.getpid(), n)


class PackWriter(object):
    """One pack being written by one thread. `append` returns the offset of the blob; `seal` makes it durable and indexed."""

    def __init__(self, root):
        d = packs_dir(root)
        os.makedirs(d, mode=0o750, exist_ok=True)
        self.id = new_pack_id()
        self.final = os.path.join(d, self.id + ".pack")
        self.idx = os.path.join(d, self.id + ".idx")
        self.open_path = self.final + ".open"
        self.f = open(self.open_path, "wb")
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


class ChunkIndex(object):
    """hash (32 bytes) -> (pack path, offset, length) over every sealed pack of the given roots, plus what this process wrote since."""

    def __init__(self, roots):
        self.roots = list(roots)
        self.own_prefix = packs_dir(self.roots[0]) + os.sep
        self.packs = []                                        # pack number -> path
        self.tab = ([], array.array("q"), array.array("I"))    # sorted hashes, pack number << OFF_BITS | offset, lengths: swapped as ONE tuple
        self.recent = {}                                       # hash -> (pack number, offset, length)
        self.lock = threading.Lock()
        self.problems = []                                     # indexes that could not be read (reported by verify)
        self.load()

    # ---- loading
    def load(self):
        keys, locs, lens, packs = [], [], [], []
        for root in self.roots:
            d = packs_dir(root)
            if not os.path.isdir(d):
                continue
            for name in sorted(os.listdir(d)):
                if not name.endswith(".idx"):
                    continue
                pack = os.path.join(d, name[:-4] + ".pack")
                if not os.path.exists(pack):
                    continue                                   # index of a pack that was deleted (crash between the two unlinks): ignored
                try:
                    entries = read_idx(os.path.join(d, name))
                except (EngineError, OSError) as e:
                    self.problems.append("%s: %s" % (name, e))
                    continue
                pn = len(packs)
                packs.append(pack)
                for hb, off, ln in entries:
                    keys.append(hb)
                    locs.append((pn << OFF_BITS) | off)
                    lens.append(ln)
        order = sorted(range(len(keys)), key=keys.__getitem__)
        tab = ([keys[i] for i in order], array.array("q", (locs[i] for i in order)), array.array("I", (lens[i] for i in order)))
        with self.lock:
            self.packs = packs
            self.tab = tab
            self.recent = {}

    def __len__(self):
        return len(self.tab[0]) + len(self.recent)

    # ---- lookups
    def find(self, hb, own_only=False):
        """(pack path, offset, length) or None. own_only: only packs of the first root (the writable location), not of previous locations."""
        r = self.recent.get(hb)
        if r is not None:
            return self.packs[r[0]], r[1], r[2]
        keys, locs, lens = self.tab                            # one tuple, swapped atomically by a fold or a reload
        i = bisect.bisect_left(keys, hb)
        if i < len(keys) and keys[i] == hb:
            v = locs[i]
            path = self.packs[v >> OFF_BITS]
            if own_only and not path.startswith(self.own_prefix):
                return None
            return path, v & ((1 << OFF_BITS) - 1), lens[i]
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
            keys, locs, lens = self.tab
            keep = [i for i in range(len(keys)) if (locs[i] >> OFF_BITS) != pn]
            if len(keep) != len(keys):
                self.tab = ([keys[i] for i in keep], array.array("q", (locs[i] for i in keep)), array.array("I", (lens[i] for i in keep)))

    def fold(self):
        """Merge the recent dictionary into the sorted lists (the lists are rebuilt and swapped, readers never see a half state)."""
        with self.lock:
            if not self.recent:
                return
            items = sorted(self.recent.items())
            okeys, olocs, olens = self.tab
            keys = okeys + [k for k, _ in items]
            locs = list(olocs) + [(v[0] << OFF_BITS) | v[1] for _, v in items]
            lens = list(olens) + [v[2] for _, v in items]
            order = sorted(range(len(keys)), key=keys.__getitem__)
            self.tab = ([keys[i] for i in order], array.array("q", (locs[i] for i in order)), array.array("I", (lens[i] for i in order)))
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
