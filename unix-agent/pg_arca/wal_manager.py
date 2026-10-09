"""
pg_arca WAL archive: write-once, crash-safe, verified.

archive_command contract (PostgreSQL): return 0 ONLY when the segment is durably stored.
Guarantees implemented here
  * ATOMIC + WRITE-ONCE: data goes to a temp file, is fsync'ed, then published with link(2)
    which fails if the name exists. Two writers can never both win; nothing is ever overwritten.
  * IDEMPOTENT: archiving the same segment again (PostgreSQL retries after a crash / timeout)
    succeeds if the content hash matches the stored one.
  * SPLIT-BRAIN SAFE: same name but DIFFERENT content (two primaries on one timeline) is never
    accepted: the incoming copy is quarantined in conflicts/ and the command FAILS (PGA-WAL-031) so the
    operator is alerted by pg_stat_archiver.failed_count.
  * VERIFIED RESTORE: on retrieval the sha256 of the decompressed segment must match the one
    recorded at archive time. Corruption aborts recovery (exit 126) instead of being mistaken for
    "end of archive" (exit 1), which would silently stop recovery at the wrong point in time.
  * DURABLE: file fsync + directory fsync before success is returned.
Layout:   <wal_dir>/<segment>[.zst|.lz4]      + <segment>.meta (json: sha256 of RAW segment, size, codec)
          <wal_dir>/<tli>.history             timeline history files (write-once as well)
          <wal_dir>/conflicts/                quarantined divergent copies
"""

import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import time

logger = logging.getLogger("pg_arca.wal_manager")

SEG_RE = re.compile(r"^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})$")
BACKUP_LABEL_RE = re.compile(r"^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$")     # e.g. 000000010000000000000003.00000028.backup
EXIT_NOT_FOUND = 1
EXIT_CORRUPT = 126      # aborts PostgreSQL recovery (documented behaviour of restore_command)

try:
    import zstandard as _zstd
except Exception:  # pragma: no cover
    _zstd = None


class WalArchiveError(Exception):
    def __init__(self, code, message):
        super().__init__("%s: %s" % (code, message))
        self.code = code


def _fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _sha256_file(path, bufsize=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(bufsize), b""):
            h.update(chunk)
    return h.hexdigest()


class WalManager:
    def __init__(self, wal_dir="/var/lib/pgarca/wal", compression="zstd", level=3, segment_size=16 * 1024 * 1024):
        self.wal_dir = wal_dir
        self.compression = compression
        self.level = int(level)
        self.segment_size = segment_size
        os.makedirs(wal_dir, mode=0o750, exist_ok=True)
        os.makedirs(os.path.join(wal_dir, "conflicts"), mode=0o750, exist_ok=True)
        self._cont_cache = (0, None, None)   # (computed_at, dir_mtime, report)

    # ------------------------------------------------------------------ codecs
    def _compress(self, src, dst):
        """Returns codec name written to dst."""
        if self.compression == "zstd":
            if _zstd is not None:
                with open(src, "rb") as fi, open(dst, "wb") as fo:
                    _zstd.ZstdCompressor(level=self.level).copy_stream(fi, fo)
                return "zst"
            if shutil.which("zstd"):
                subprocess.run(["zstd", "-q", "-f", "-%d" % self.level, src, "-o", dst], check=True)
                return "zst"
        if self.compression == "lz4" and shutil.which("lz4"):
            subprocess.run(["lz4", "-q", "-f", src, dst], check=True)
            return "lz4"
        if self.compression != "none":            # stdlib fallback: never store 16 MB plain when a codec is requested
            with open(src, "rb") as fi, gzip.GzipFile(dst, "wb", compresslevel=min(max(self.level, 1), 6)) as fo:
                shutil.copyfileobj(fi, fo, 1 << 20)
            return "gz"
        shutil.copyfile(src, dst)
        return ""

    def _decompress(self, src, dst, codec):
        if codec == "":
            shutil.copyfile(src, dst)
        elif codec == "zst":
            if _zstd is not None:
                with open(src, "rb") as fi, open(dst, "wb") as fo:
                    _zstd.ZstdDecompressor().copy_stream(fi, fo)
            elif shutil.which("zstd"):
                subprocess.run(["zstd", "-d", "-q", "-f", src, "-o", dst], check=True)
            else:
                raise WalArchiveError("PGA-WAL-040", "segment is zstd-compressed but neither python-zstandard nor the zstd binary is available")
        elif codec == "gz":
            with gzip.open(src, "rb") as fi, open(dst, "wb") as fo:
                shutil.copyfileobj(fi, fo, 1 << 20)
        elif codec == "lz4":
            if not shutil.which("lz4"):
                raise WalArchiveError("PGA-WAL-040", "segment is lz4-compressed but the lz4 binary is missing")
            subprocess.run(["lz4", "-d", "-q", "-f", src, dst], check=True)
        else:
            raise WalArchiveError("PGA-WAL-041", "unknown codec %s" % codec)

    # ------------------------------------------------------------------ lookup
    def _find(self, name):
        """Returns (path, codec) of the stored object for `name` or (None, None)."""
        for codec in ("", ".zst", ".lz4", ".gz"):
            p = os.path.join(self.wal_dir, name + codec)
            if os.path.isfile(p):
                return p, codec.lstrip(".")
        return None, None

    def _read_meta(self, name):
        try:
            with open(os.path.join(self.wal_dir, name + ".meta"), "r", encoding="utf-8") as f:
                return json.load(f)
        except (IOError, OSError, ValueError):
            return None

    # ------------------------------------------------------------------ archive
    def archive_segment(self, src_path, name):
        """archive_command %p %f. Returns (ok, dest, sha256, message); raises WalArchiveError on refusal."""
        is_history = name.endswith(".history") or BACKUP_LABEL_RE.match(name) is not None      # tiny text files: stored readable
        if not (SEG_RE.match(name) or is_history or re.match(r"^[0-9A-F]{24}\.partial$", name)):
            raise WalArchiveError("PGA-WAL-010", "refusing unexpected file name %r" % name)
        if not os.path.isfile(src_path):
            raise WalArchiveError("PGA-WAL-011", "source %s does not exist" % src_path)
        size = os.path.getsize(src_path)
        if SEG_RE.match(name) and (size & (size - 1) != 0 or size < (1 << 20) or size > (1 << 30)):
            raise WalArchiveError("PGA-WAL-012", "segment size %d is not a valid WAL segment size (partial copy?)" % size)

        raw_sha = _sha256_file(src_path)
        existing, codec = self._find(name)
        if existing:
            meta = self._read_meta(name)
            stored = meta.get("sha256") if meta else None
            if stored is None:                                  # legacy object without meta: hash its decompressed content
                tmp = os.path.join(self.wal_dir, ".verify.%d" % os.getpid())
                try:
                    self._decompress(existing, tmp, codec)
                    stored = _sha256_file(tmp)
                finally:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
            if stored == raw_sha:
                return True, existing, raw_sha, "already archived (identical content)"
            qdir = os.path.join(self.wal_dir, "conflicts")
            qname = "%s.%s.%d" % (name, raw_sha[:12], int(time.time()))
            shutil.copyfile(src_path, os.path.join(qdir, qname))
            raise WalArchiveError("PGA-WAL-031", "DIVERGENT content for %s (stored %s.. vs incoming %s..): possible split-brain; incoming copy quarantined as conflicts/%s" % (name, stored[:12], raw_sha[:12], qname))

        tmp = os.path.join(self.wal_dir, ".%s.tmp.%d" % (name, os.getpid()))
        codec_used = ""
        try:
            codec_used = "" if is_history else self._compress(src_path, tmp)     # history files are tiny: keep readable
            if is_history:
                shutil.copyfile(src_path, tmp)
            with open(tmp, "rb") as f:
                os.fsync(f.fileno())
            final = os.path.join(self.wal_dir, name + ("." + codec_used if codec_used else ""))
            meta = {"sha256": raw_sha, "size": size, "codec": codec_used or "none", "archived_at": time.time()}
            mtmp = os.path.join(self.wal_dir, ".%s.meta.tmp.%d" % (name, os.getpid()))
            with open(mtmp, "w", encoding="utf-8") as f:
                json.dump(meta, f)
                f.flush()
                os.fsync(f.fileno())
            os.rename(mtmp, os.path.join(self.wal_dir, name + ".meta"))      # meta first: an object without meta is never trusted blindly
            try:
                os.link(tmp, final)                                          # write-once publish
            except FileExistsError:                                          # lost a race with another writer: re-evaluate (idempotent / conflict)
                os.unlink(tmp)
                return self.archive_segment(src_path, name)
            os.unlink(tmp)
            _fsync_dir(self.wal_dir)
            return True, final, raw_sha, "archived"
        finally:
            for p in (tmp,):
                if os.path.exists(p):
                    try:
                        os.unlink(p)
                    except OSError:
                        pass

    # ------------------------------------------------------------------ retrieve
    def retrieve_segment(self, name, dest_path):
        """restore_command %f %p. Returns (exit_code, message). 0=ok, 1=not found, 126=corrupt (abort recovery)."""
        path, codec = self._find(name)
        if not path:
            return EXIT_NOT_FOUND, "not in archive"
        d = os.path.dirname(os.path.abspath(dest_path)) or "."
        os.makedirs(d, exist_ok=True)
        tmp = "%s.arca.%d" % (dest_path, os.getpid())
        try:
            self._decompress(path, tmp, codec)
            meta = self._read_meta(name)
            if meta and _sha256_file(tmp) != meta.get("sha256"):
                os.unlink(tmp)
                return EXIT_CORRUPT, "PGA-WAL-050 checksum mismatch for %s: archive object is corrupt" % name
            with open(tmp, "rb") as f:
                os.fsync(f.fileno())
            os.rename(tmp, dest_path)
            return 0, "retrieved"
        except WalArchiveError as e:
            return EXIT_CORRUPT, str(e)
        except Exception as e:
            return EXIT_CORRUPT, "PGA-WAL-051 %s" % e
        finally:
            if os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    # ------------------------------------------------------------------ inventory (used by the backup engine)
    def has_segment(self, name):
        return self._find(name)[0] is not None

    def list_segments(self):
        """Sorted list of archived WAL segment base names (no .history/.backup/.partial/.meta)."""
        out = set()
        try:
            names = os.listdir(self.wal_dir)
        except OSError:
            return []
        for n in names:
            if n.startswith("."):
                continue
            base, _, ext = n.partition(".")
            if SEG_RE.match(base) and (ext == "" or ext in ("zst", "lz4", "gz")):
                out.add(base)
        return sorted(out)

    def list_histories(self):
        try:
            return sorted(n for n in os.listdir(self.wal_dir) if n.endswith(".history"))
        except OSError:
            return []

    def remove_segment(self, name):
        """Expire one segment (retention only). Meta goes LAST so a crash never leaves an untracked-but-valid object."""
        path, _ = self._find(name)
        if path:
            os.unlink(path)
        try:
            os.unlink(os.path.join(self.wal_dir, name + ".meta"))
        except OSError:
            pass
        _fsync_dir(self.wal_dir)

    def read_segment_to(self, name, dest_path):
        return self.retrieve_segment(name, dest_path)

    # ------------------------------------------------------------------ continuity
    def verify_continuity(self, max_age=30):
        """Timeline-aware gap detection. Cached (dir mtime + max_age) so heartbeats stay cheap on huge archives."""
        now = time.time()
        try:
            mt = os.stat(self.wal_dir).st_mtime
        except OSError:
            mt = None
        at, cmt, rep = self._cont_cache
        if rep is not None and cmt == mt and now - at < max_age:
            return rep
        rep = self._compute_continuity()
        self._cont_cache = (now, mt, rep)
        return rep

    def _compute_continuity(self):
        per_id = 0x100000000 // self.segment_size
        names, timelines, histories = [], {}, []
        for n in os.listdir(self.wal_dir):
            base = n.split(".")[0]
            if n.endswith(".history"):
                histories.append(n)
                continue
            if n.endswith((".meta", ".tmp")) or n.startswith(".") or n.count(".") > 1 and not n.endswith((".zst", ".lz4", ".gz")):
                continue                      # .backup / .partial / temp files are not segments
            m = SEG_RE.match(base)
            if m and (n == base or n.endswith((".zst", ".lz4", ".gz"))):
                tli, log, seg = (int(x, 16) for x in m.groups())
                timelines.setdefault(tli, []).append(log * per_id + seg)
                names.append(base)
        if not names:
            return {"continuous": True, "total_segments": 0, "gaps": [], "timelines": [], "status": "archive is empty", "histories": sorted(histories)}
        gaps = []
        for tli, nums in timelines.items():
            nums.sort()
            for a, b in zip(nums, nums[1:]):
                if b != a + 1:
                    gaps.append({"timeline": tli, "missing_from": "%08X%08X%08X" % (tli, (a + 1) // per_id, (a + 1) % per_id),
                                 "missing_to": "%08X%08X%08X" % (tli, (b - 1) // per_id, (b - 1) % per_id), "count": b - a - 1})
        names.sort()
        return {"continuous": not gaps, "total_segments": len(names), "gaps": gaps[:50], "gap_count": len(gaps),
                "timelines": sorted(timelines), "histories": sorted(histories), "first_segment": names[0], "last_segment": names[-1],
                "conflicts": len(os.listdir(os.path.join(self.wal_dir, "conflicts"))),
                "status": "continuous" if not gaps else "%d gap(s) detected" % len(gaps)}
