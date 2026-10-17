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
import errno
import os
import stat as stat_mod
import re
import shutil
import subprocess
import threading
import time

logger = logging.getLogger("pg_arca.wal_manager")

SEG_RE = re.compile(r"^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})$")
HIST_LINE_RE = re.compile(r"^\s*(\d+)\s+([0-9A-Fa-f]+)/([0-9A-Fa-f]+)")


def _branch_not_on_our_history(src_path, name, pg_wal_dir=None, seg_size=None):
    """For a segment of an OLDER timeline than the one this server writes: '' when the server's own history may need it, else the reason
    it never will. PostgreSQL recovering along a timeline history reads timeline T only up to the point where the history left T, and the
    segment holding that switch point is read from the newer timeline. A copy of timeline T's segment that holds or follows that point is
    therefore never read on this server's history (it is the old primary's view of a branch this server left). Decided from this server's
    pg_wal only: the timeline of the newest segment there and its history file; any doubt answers '' (the divergence stays an error).
    The answer depends on the NAME and this server's history alone, not on a collision in the archive: with seg_size given (and src_path
    None) it also judges a copy the archive refused for another reason (a dead pusher's leftover in the spool, wal_archive drain)."""
    m = SEG_RE.match(name)
    if not m:
        return ""
    try:
        wal_dir = pg_wal_dir or os.path.dirname(os.path.abspath(src_path))     # the server's pg_wal (not the async spool the copy may come from)
        seg_size = int(seg_size) if seg_size else os.path.getsize(src_path)
        if seg_size < (1 << 20) or seg_size & (seg_size - 1):
            return ""
        names = os.listdir(wal_dir)
        cur = max((int(x[:8], 16) for x in names if SEG_RE.match(x)), default=0)      # the timeline this server writes now
        tli = int(m.group(1), 16)
        if cur <= tli or ("%08X.history" % cur) not in names:
            return ""
        switch = None
        with open(os.path.join(wal_dir, "%08X.history" % cur)) as f:
            for line in f:
                h = HIST_LINE_RE.match(line)
                if h and int(h.group(1)) == tli:
                    switch = (int(h.group(2), 16) << 32) | int(h.group(3), 16)
        if switch is None:
            return ""                                          # timeline T is not an ancestor of ours: not our branch, a human decides
        per_id = 0x100000000 // seg_size
        seg_start = (int(m.group(2), 16) * per_id + int(m.group(3), 16)) * seg_size
        if seg_start + seg_size > switch:
            return "timeline %d ended at %X/%X in this server's history; recovery reads timeline %d's copy of this segment" % (
                tli, switch >> 32, switch & 0xFFFFFFFF, _next_tli(wal_dir, cur, tli))
    except (OSError, ValueError, TypeError):
        return ""
    return ""


def branch_not_on_history(name, pg_wal_dir, seg_size):
    """Public form of _branch_not_on_our_history for a copy judged by its name alone (see there)."""
    if not pg_wal_dir:
        return ""
    return _branch_not_on_our_history(None, name, pg_wal_dir, seg_size)


def pgdata_sysid(pgdata):
    """System identifier of the cluster in `pgdata` (first 8 bytes of global/pg_control, host byte order), None when not readable.
    Same reading as discovery.read_system_identifier, kept here so archive_command does not import the agent."""
    import struct
    try:
        with open(os.path.join(pgdata, "global", "pg_control"), "rb") as f:
            raw = f.read(8)
        if len(raw) == 8:
            return str(struct.unpack("=Q", raw)[0])
    except (IOError, OSError):
        pass
    return None


def _next_tli(wal_dir, cur, tli):
    """The timeline that followed `tli` in this server's history (for the message only)."""
    try:
        nxt = cur
        with open(os.path.join(wal_dir, "%08X.history" % cur)) as f:
            parents = [int(h.group(1)) for h in (HIST_LINE_RE.match(l) for l in f) if h]
        chain = parents + [cur]
        i = chain.index(tli)
        nxt = chain[i + 1] if i + 1 < len(chain) else cur
        return nxt
    except (OSError, ValueError):
        return cur
BACKUP_LABEL_RE = re.compile(r"^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$")     # e.g. 000000010000000000000003.00000028.backup
EXIT_NOT_FOUND = 1
EXIT_CORRUPT = 126      # aborts PostgreSQL recovery (documented behaviour of restore_command)

try:
    import zstandard as _zstd
except Exception:  # pragma: no cover
    _zstd = None
_stdz = None
if _zstd is None:                                   # Python >= 3.14 has zstd in the standard library: the same codec the repository uses (engine/util.py)
    try:
        from compression import zstd as _stdz
    except ImportError:
        _stdz = None


KEY_FILE = "ARCHIVE_KEY.json"          # which encryption key the archive's segments use ("none": plain): one key per archive
OWNER_FILE = "ARCHIVE_OWNER.json"      # the database (system identifier) this archive belongs to: one database per WAL archive directory


def segment_sysid(path):
    """System identifier from the long page header at the start of a WAL segment (None if not readable / not a segment start).
    XLogLongPageHeaderData: magic(2) info(2) tli(4) pageaddr(8) rem_len(4) +pad(4) | sysid(8) seg_size(4) blcksz(4); XLP_LONG_HEADER = 0x0002."""
    import struct
    try:
        with open(path, "rb") as f:
            h = f.read(40)
    except (IOError, OSError):
        return None
    if len(h) < 40:
        return None
    for order in ("<", ">"):                                  # written by the server's own byte order
        info = struct.unpack(order + "H", h[2:4])[0]
        if info & 0x0002:
            sysid, seg = struct.unpack(order + "QI", h[24:36])
            if seg and seg & (seg - 1) == 0 and (1 << 20) <= seg <= (1 << 30):
                return str(sysid)
    return None


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


def known_archives_file(state_dir):
    """Archives this host has initialized ({realpath: system identifier}), next to the agent's state."""
    return os.path.join(state_dir or "/var/lib/pgarca/state", "wal_archives.json")


class WalManager:
    def __init__(self, wal_dir="/var/lib/pgarca/wal", compression="zstd", level=3, segment_size=16 * 1024 * 1024, crypto=None, previous=None,
                 create=True, known_file=None):
        self.crypto = crypto
        self.wal_dir = wal_dir
        # earlier locations of this archive (the destination was changed): READ only - restores and chain checks find old segments there;
        # archiving, duplicate detection and retention work on wal_dir alone
        self.previous = [d for d in (previous or []) if d and os.path.realpath(d) != os.path.realpath(wal_dir)]
        self.compression = compression
        self.level = int(level)
        self.segment_size = segment_size
        # known_file: archives this host has initialized (state dir). An initialized archive found EMPTY again is a share that is not mounted (or was
        # wiped): archiving into the bare mount point would hide every segment when the share comes back (independent review)
        self.known_file = known_file
        if create:
            os.makedirs(wal_dir, mode=0o750, exist_ok=True)
            os.makedirs(os.path.join(wal_dir, "conflicts"), mode=0o750, exist_ok=True)
        elif not os.path.isdir(wal_dir):
            raise WalArchiveError("PGA-WAL-096", "the WAL archive directory %s does not exist (share not mounted?)" % wal_dir)
        self._cont_cache = (0, None, None)   # (computed_at, dir_mtime, report)

    # ------------------------------------------------------------------ codecs
    def _compress(self, src, dst):
        """Returns codec name written to dst."""
        if self.compression == "zstd":
            if _zstd is not None:
                with open(src, "rb") as fi, open(dst, "wb") as fo:
                    _zstd.ZstdCompressor(level=self.level).copy_stream(fi, fo)
                return "zst"
            if _stdz is not None:
                with open(src, "rb") as fi, open(dst, "wb") as fo:
                    fo.write(_stdz.compress(fi.read(), level=self.level))
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
            elif _stdz is not None:
                with open(src, "rb") as fi, open(dst, "wb") as fo:
                    fo.write(_stdz.decompress(fi.read()))
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
    def _find(self, name, anywhere=False):
        """Returns (path, codec) of the stored object for `name` or (None, None). anywhere=True also looks in the previous locations (read paths)."""
        for i, d in enumerate([self.wal_dir] + (self.previous if anywhere else [])):
            for codec in ("", ".zst", ".lz4", ".gz"):
                p = os.path.join(d, name + codec)
                try:
                    st = os.stat(p)
                except OSError as e:
                    if e.errno in (errno.ENOENT, errno.ENOTDIR):
                        continue
                    if i > 0:
                        break                             # an old location that is gone or unreadable: never an error for the current archive
                    raise                                 # EACCES / EIO / ESTALE are errors, not "segment missing"
                if stat_mod.S_ISREG(st.st_mode):
                    return p, codec.lstrip(".")
        return None, None

    def _read_meta(self, name, directory=None):
        try:
            with open(os.path.join(directory or self.wal_dir, name + ".meta"), "r", encoding="utf-8") as f:
                return json.load(f)
        except (IOError, OSError, ValueError):
            return None

    # ------------------------------------------------------------------ ownership
    def owner(self):
        try:
            with open(os.path.join(self.wal_dir, OWNER_FILE), "r", encoding="utf-8") as f:
                return str(json.load(f).get("system_identifier") or "") or None
        except (IOError, OSError, ValueError):
            return None

    def _check_owner(self, sysid):
        """A WAL archive directory holds ONE database (segment names restart at 1 in every cluster): a second database writing here would collide with
        the first one's names and its retention would delete the other's WAL. The sites of a geo-redundant pair are the same database: they share it."""
        cur = self.owner()
        if cur is None and self._known(sysid):
            raise WalArchiveError("PGA-WAL-096", "the WAL archive %s held this database's WAL and is empty now: the share is not mounted, or the archive was "
                                  "removed. Nothing is written into it (the segments would be hidden by the share once mounted): mount it, or set a new "
                                  "archive from the console (Backup storage)" % self.wal_dir)
        if cur is None:
            p = os.path.join(self.wal_dir, OWNER_FILE)
            # unique per thread too: the spool pusher's workers archive in parallel into a fresh archive (one tmp name made them unlink each other's)
            tmp = "%s.%d.%d.%s.tmp" % (p, os.getpid(), threading.get_ident(), os.urandom(4).hex())
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"system_identifier": sysid, "since": time.time()}, f)
                f.flush()
                os.fsync(f.fileno())
            try:
                os.link(tmp, p)                                 # first writer wins; a concurrent different owner is caught just below
            except FileExistsError:
                pass
            finally:
                os.unlink(tmp)
            cur = self.owner()
        if cur == sysid:
            self._remember(sysid)
        if cur and cur != sysid:
            raise WalArchiveError("PGA-WAL-032", "this WAL archive (%s) belongs to another database (system identifier %s; this one is %s): each PostgreSQL cluster "
                                  "needs its own WAL archive directory. Set a different wal_archive_dir for this cluster" % (self.wal_dir, cur, sysid))

    def archive_key(self):
        """key_id recorded for this archive, "none" for a plain one, None when nothing is recorded yet."""
        try:
            with open(os.path.join(self.wal_dir, KEY_FILE), "r", encoding="utf-8") as f:
                return str(json.load(f).get("key_id") or "") or None
        except (IOError, OSError, ValueError):
            return None

    def _check_key(self):
        """One key per archive: a node without the key, or with another one, archiving into it (after a failover, a node configured differently)
        made segments that no single setting can read back - point-in-time recovery across that window was lost while archive_command said
        success (independent offsite/encryption review). The first writer records the key the archive already uses (from its segments' meta), else its own."""
        mine = self.crypto.key_id if self.crypto else "none"
        cur = self.archive_key()
        if cur is None:
            cur = self._infer_key() or mine
            p = os.path.join(self.wal_dir, KEY_FILE)
            tmp = "%s.%d.%d.%s.tmp" % (p, os.getpid(), threading.get_ident(), os.urandom(4).hex())
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump({"key_id": cur, "since": time.time()}, f)
                    f.flush()
                    os.fsync(f.fileno())
                try:
                    os.link(tmp, p)
                except FileExistsError:
                    pass
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            cur = self.archive_key() or cur
        if cur != mine:
            raise WalArchiveError("PGA-WAL-037", "this WAL archive (%s) is %s, and this node %s: its segments could not be read back with one setting. "
                                  "Configure the same encryption key file on every node that archives here"
                                  % (self.wal_dir, "encrypted with key %s" % cur if cur != "none" else "not encrypted",
                                     "has key %s" % mine if mine != "none" else "has no key"))

    def _infer_key(self):
        """The key the archive's newest segments were written with ("none" for plain ones), None when the archive holds no segment yet."""
        try:
            metas = sorted((n for n in os.listdir(self.wal_dir) if n.endswith(".meta") and SEG_RE.match(n[:-5])), reverse=True)[:5]
        except OSError:
            return None
        for n in metas:
            m = self._read_meta(n[:-5])
            if m is not None:
                return m.get("key_id") if m.get("enc") else "none"
        return None

    def _known(self, sysid):
        if not self.known_file:
            return False
        try:
            with open(self.known_file, "r", encoding="utf-8") as f:
                return json.load(f).get(os.path.realpath(self.wal_dir)) == sysid
        except (IOError, OSError, ValueError):
            return False

    def _remember(self, sysid):
        """Best effort (the state directory may not be writable by PostgreSQL's user): written once per archive."""
        if not self.known_file or self._known(sysid):
            return
        try:
            try:
                with open(self.known_file, "r", encoding="utf-8") as f:
                    d = json.load(f)
            except (IOError, OSError, ValueError):
                d = {}
            d[os.path.realpath(self.wal_dir)] = sysid
            tmp = "%s.%d.%d.tmp" % (self.known_file, os.getpid(), threading.get_ident())
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(d, f)
            os.rename(tmp, self.known_file)
        except (IOError, OSError):
            pass

    # ------------------------------------------------------------------ quarantine
    # A quarantined copy is conflicts/<name>.<sha12> (+ .dead-branch once a retirement consumed or rejected it) with a sidecar
    # <copy file>.json: {sha256, size (both of the RAW copy), enc/key_id/aad when the copy is sealed, writer, stored}. Copies quarantined
    # by older agents have no sidecar: they are plaintext and their own size and hash are the raw ones.
    SIDECAR = ".json"

    @staticmethod
    def _is_qcopy(f):
        """A quarantined copy (not a sidecar, not a temp file, not a consumed .dead-branch trace)."""
        return not f.startswith(".") and not f.endswith(WalManager.SIDECAR) and not f.endswith(".dead-branch")

    @staticmethod
    def _qname(f):
        parts = f.split(".")
        return ".".join(parts[:2]) if len(parts) > 1 and parts[1] in ("history", "partial") else parts[0]

    def _qinfo(self, path):
        """The sidecar of a quarantined copy, or what can be told without one (legacy: plaintext, its own size). sha256 is computed lazily
        by _qsha for legacy copies (hashing every copy at every heartbeat would be expensive)."""
        try:
            with open(path + self.SIDECAR, "r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                return d
        except (IOError, OSError, ValueError):
            pass
        return {}

    def _qsha(self, path, info=None):
        info = self._qinfo(path) if info is None else info
        return info.get("sha256") or _sha256_file(path)

    def _qplain(self, path, name, info, tmp):
        """Path of the RAW content of a quarantined copy: the copy itself when plaintext, else decrypted into `tmp` (raises when the key is not this one)."""
        if not info.get("enc"):
            return path
        if not self.crypto:
            raise WalArchiveError("PGA-ENC-005", "the quarantined copy %s is encrypted and no key is configured (encryption_key_file / PG_ARCA_KEY_FILE)" % os.path.basename(path))
        if info.get("key_id") and info.get("key_id") != self.crypto.key_id:
            raise WalArchiveError("PGA-ENC-007", "the quarantined copy %s was encrypted with another key (%s)" % (os.path.basename(path), info.get("key_id")))
        with open(path, "rb") as f:
            plain = self.crypto.open(f.read(), info.get("aad") or "walq:" + name)
        with open(tmp, "wb") as f:
            f.write(plain)
        return tmp

    def _qrename(self, src, dst):
        """Move a quarantined copy and its sidecar together (the sidecar first: a copy found without its sidecar would be taken for plaintext)."""
        if os.path.exists(src + self.SIDECAR):
            os.rename(src + self.SIDECAR, dst + self.SIDECAR)
        os.rename(src, dst)

    def conflicts(self):
        """Divergent copies waiting for a person: [{file, name, sha, at, size, writer, stored_writer}] (conflicts/, not conflicts/reviewed/).
        size is the RAW copy's (a sealed copy is larger on disk); writer: who sent the refused copy, stored_writer: who wrote the archive's."""
        qdir = os.path.join(self.wal_dir, "conflicts")
        out = []
        for f in (sorted(os.listdir(qdir)) if os.path.isdir(qdir) else []):
            p = os.path.join(qdir, f)
            if not self._is_qcopy(f) or not os.path.isfile(p):
                continue                                         # .<key>.tmp.*: a quarantine being published; *.json: sidecars
            parts = f.split(".")
            two = len(parts) > 1 and parts[1] in ("history", "partial")
            name = self._qname(f)
            try:
                st = os.stat(p)
                info = self._qinfo(p)
                c = {"file": f, "name": name, "sha": (parts[2] if len(parts) > 2 else "") if two else (parts[1] if len(parts) > 1 else ""),
                     "at": st.st_mtime, "size": int(info.get("size") or st.st_size), "timeline": int(name[:8], 16) if re.match(r"^[0-9A-F]{8}", name) else None}
                if info.get("writer"):
                    c["writer"] = info["writer"]
                if (info.get("stored") or {}).get("writer"):
                    c["stored_writer"] = info["stored"]["writer"]
                if info.get("enc"):
                    c["enc"] = info["enc"]
                out.append(c)
            except OSError:
                pass
        return out

    def classify_conflicts(self, current_timeline=None, items=None, local_wal_dir=None):
        """Each quarantined copy with a `kind`, decided against the timeline history of the server writing NOW (current_timeline):
          'off_history'  not read by recovery along the current timeline: a .partial (PostgreSQL never asks for those), a segment of an
                         ancestor timeline that holds or follows the point where the history left it AND whose successor timeline's copy
                         of that segment is in the archive (the old primary's tail after a failover), or a copy of a sibling timeline that is
                         not an ancestor at all. Kept; informational, not an alarm.
          'divergent'    on the shared history, or undecidable: a real split-brain signal.
        Never relieved (independent engine review, 16/10): copies of the current timeline or a newer one (the reporter may lag behind a
        promotion), a divergent HISTORY file of an ancestor (two promotions to the same number), any copy when the current timeline's history
        is missing, empty or itself contested, and a past-the-fork segment whose successor copy is not archived yet (PostgreSQL would fall
        back to the older timeline's file). The history is read from the server's own pg_wal when given (the archive's copy may be the other
        server's). The segment size is the quarantined raw copy's own size, not a configured default."""
        items = self.conflicts() if items is None else items
        try:
            cur = int(current_timeline) if current_timeline is not None else None
        except (TypeError, ValueError):
            cur = None
        forks = None
        if cur == 1:
            forks = {}
        elif cur and cur > 1:
            forks = (self._history_forks(cur, local_wal_dir) if local_wal_dir and os.path.exists(os.path.join(local_wal_dir, "%08X.history" % cur)) else None) \
                or self._history_forks(cur)
            if not forks or any((c.get("name") or "") == "%08X.history" % cur for c in items):
                forks = None                                          # empty / garbled / contested history: no relief at all
        lineage = sorted(list((forks or {}).keys()) + ([cur] if cur else []))
        for c in items:
            kind, why = "divergent", ""
            name, tli = c.get("name") or "", c.get("timeline")
            if cur is not None and forks is not None and tli is not None and tli < cur:
                m = SEG_RE.match(name.split(".")[0])
                if name.endswith(".partial"):
                    kind, why = "off_history", "partial segment of timeline %d: recovery never reads partial segments" % tli
                elif name.endswith(".history"):
                    if tli not in forks:
                        kind, why = "off_history", "history of timeline %d, which is not an ancestor of the current timeline %d" % (tli, cur)
                elif m:
                    size = int(c.get("size") or 0)
                    seg = size if 1048576 <= size <= 1073741824 and size & (size - 1) == 0 else self.segment_size
                    if tli not in forks:
                        kind, why = "off_history", "timeline %d is not in the history of the current timeline %d" % (tli, cur)
                    else:
                        start = (int(m.group(2), 16) * (0x100000000 // seg) + int(m.group(3), 16)) * seg
                        succ = next((t for t in lineage if t > tli), cur)
                        if start + seg > forks[tli] and self._find("%08X%s" % (succ, name[8:24]))[0]:
                            kind, why = "off_history", ("timeline %d ended at %X/%X in the current history: recovery reads timeline %d's copy, which is archived"
                                                        % (tli, forks[tli] >> 32, forks[tli] & 0xFFFFFFFF, succ))
            elif cur is not None and tli is not None and tli < cur and name.endswith(".partial"):
                kind, why = "off_history", "partial segment of timeline %d: recovery never reads partial segments" % tli
            c["kind"] = kind
            if why:
                c["why"] = why
        return items

    def retire_abandoned(self, timeline, current_timeline, dry_run=False):
        """A timeline NEWER than the primary's current one can only be a dead branch (a site that promoted itself while it was cut off and
        was then rebuilt from the primary): its history file in the archive makes every member that recovers from the archive with
        recovery_target_timeline=latest try to follow it ('requested timeline N is not a child of this server's history', a restart loop;
        seen on the lab right after a geo rejoin). Every stored object of that timeline (history, segments, partials, backup labels, metas)
        moves to conflicts/dead-branch-<tli>/; nothing is deleted. Refused for the current timeline or an older one."""
        tli, cur = int(timeline), int(current_timeline)
        if tli <= cur:
            raise WalArchiveError("PGA-WAL-035", "timeline %d is not newer than the primary's current timeline %d: it is part of the primary's history or "
                                  "its present, never an abandoned branch" % (tli, cur))
        prefix = "%08X" % tli
        ddir = os.path.join(self.wal_dir, "conflicts", "dead-branch-%s" % prefix)
        names = sorted(f for f in os.listdir(self.wal_dir) if f.startswith(prefix) and not f.startswith(".") and os.path.isfile(os.path.join(self.wal_dir, f)))
        report = {"timeline": tli, "current_timeline": cur, "abandoned": True, "retired": names, "dead_branch_dir": ddir, "dry_run": bool(dry_run)}
        if dry_run or not names:
            return report
        os.makedirs(ddir, mode=0o750, exist_ok=True)
        self._mark_retired(ddir, tli, "retire_abandoned")
        suf = self._free_suffix(ddir, names)
        for f in names:
            os.rename(os.path.join(self.wal_dir, f), os.path.join(ddir, f + suf))
        _fsync_dir(ddir)
        _fsync_dir(self.wal_dir)
        self._cont_cache = (0, None, None)
        return report

    def retire_tail(self, timeline, dry_run=False):
        """Set aside the segments of timeline `timeline` archived AFTER the point where a later timeline's history says it ended (the
        branch_tails of the continuity view: an old primary that went on writing after a promotion). They move, with their meta, to
        conflicts/branch-tail-<tli>/ and RETIRED.json records when; nothing is deleted. They were never on the current history: a restore along
        it does not change, and the archive stops reporting the two-primaries finding for them. A timeline with no tail: nothing to do."""
        tli = int(timeline)
        cont = self._compute_continuity()
        tail = next((t for t in (cont or {}).get("branch_tails") or [] if int(t.get("timeline") or 0) == tli), None)
        prefix = "%08X" % tli
        ddir = os.path.join(self.wal_dir, "conflicts", "branch-tail-%s" % prefix)
        report = {"timeline": tli, "tail": True, "retired": [], "dead_branch_dir": ddir, "dry_run": bool(dry_run)}
        if not tail:
            return report
        first, last = tail["first"], tail["last"]
        names = sorted(f for f in os.listdir(self.wal_dir)
                       if SEG_RE.match(f[:24]) and f.startswith(prefix) and first <= f[:24] <= last and os.path.isfile(os.path.join(self.wal_dir, f)))
        report.update(retired=names, successor=tail.get("successor"), fork_lsn=tail.get("fork_lsn"))
        if dry_run or not names:
            return report
        os.makedirs(ddir, mode=0o750, exist_ok=True)
        self._mark_retired(ddir, tli, "retire_tail")
        suf = self._free_suffix(ddir, names)
        for f in names:
            os.rename(os.path.join(self.wal_dir, f), os.path.join(ddir, f + suf))
        _fsync_dir(ddir)
        _fsync_dir(self.wal_dir)
        self._cont_cache = (0, None, None)
        return report

    RETIRED = "RETIRED.json"

    @staticmethod
    def _free_suffix(ddir, names):
        """'' when none of `names` exists in `ddir`, else the first '.prev-N' free for ALL of them: objects moved together (a segment and its meta,
        a branch) keep the same suffix, so they still pair up."""
        n, suf = 0, ""
        while any(os.path.lexists(os.path.join(ddir, f + suf)) for f in names):
            n += 1
            suf = ".prev-%d" % n
        return suf

    def _mark_retired(self, ddir, tli, by):
        """RETIRED.json {at, timeline, by} in a dead-branch directory: WHEN the branch was set aside. A backup that started after that
        moment cannot hold the dead branch's WAL (its WAL was archived after it, on the surviving branch), so the doubt check ignores
        the directory for it; a timeline number reused later otherwise made every backup of the new incarnation UNRECOVERABLE. Written
        BEFORE anything moves (a crash in between never leaves set-aside objects without a mark, which a retry with nothing left to move
        would not write any more) and refreshed by every later retirement into the same directory (the newest one counts: backups that
        started before it may hold what it moved)."""
        p = os.path.join(ddir, self.RETIRED)
        first = None
        try:
            with open(p, "r", encoding="utf-8") as f:
                first = json.load(f).get("first_at")
        except (IOError, OSError, ValueError, AttributeError):
            first = None
        now = time.time()
        import socket
        rec = {"at": now, "first_at": first or now, "timeline": int(tli), "by": "%s@%s" % (by, socket.gethostname())}
        tmp = "%s.%d.tmp" % (p, os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rec, f)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp, p)
        _fsync_dir(ddir)

    def retired_at(self, tli):
        """When the dead branch of timeline `tli` was last set aside (RETIRED.json "at"), None when it never was or the mark is unreadable."""
        try:
            with open(os.path.join(self.wal_dir, "conflicts", "dead-branch-%08X" % int(tli), self.RETIRED), "r", encoding="utf-8") as f:
                return float(json.load(f)["at"])
        except (IOError, OSError, ValueError, KeyError, TypeError):
            return None

    def retire_branch(self, timeline, survivor_pgdata=None, dry_run=False):
        """Two servers used the SAME timeline number (split-brain, or a promotion without access to the archive): the archive holds the
        first writer's copies and refused the other's (conflicts/). When the operator says which server is the right one - the current
        primary, whose refused copies are in quarantine - every stored object of that timeline that has a divergent quarantined copy is
        the DEAD branch: it moves to conflicts/dead-branch-<tli>/ (nothing is deleted) and the quarantined copy takes its place, so the
        primary's archiver resumes at once. Objects of that timeline WITHOUT a quarantined copy are shared by both branches (before the
        fork) and stay. survivor_pgdata: when the primary's pg_wal still holds the file, the quarantined copy is promoted only if its
        content is byte-identical to it (proof it is the survivor's copy). Returns a report; dry_run only reports.
        The report says per name how the promoted copy was chosen: `verified` (byte-identical to the survivor's own file in pg_wal) or
        `unverified` (the only quarantined content, nothing to compare it with). Several DISTINCT quarantined contents of one name and none
        proven by the survivor's pg_wal: that name is left as it is and reported in `skipped` (taking the newest by date put a third
        server's copy into the archive; architecture review S8)."""
        import socket
        tli = int(timeline)
        prefix = "%08X" % tli
        qdir = os.path.join(self.wal_dir, "conflicts")
        ddir = os.path.join(qdir, "dead-branch-%s" % prefix)
        cands = {}
        for sub in ("", "reviewed"):
            d = os.path.join(qdir, sub)
            for f in (sorted(os.listdir(d)) if os.path.isdir(d) else []):
                if not f.startswith(prefix) or not self._is_qcopy(f):
                    continue
                p = os.path.join(d, f)
                if os.path.isfile(p):
                    cands.setdefault(self._qname(f), []).append(p)
        report = {"timeline": tli, "retired": [], "promoted": [], "verified": [], "unverified": [], "kept": [], "skipped": [], "dead_branch_dir": ddir,
                  "dry_run": bool(dry_run)}
        marked = False
        for name in sorted(cands):
            stored, codec = self._find(name)
            if not stored:
                report["skipped"].append({"name": name, "why": "nothing stored under this name any more"})
                continue
            copies = sorted(cands[name], key=lambda x: os.stat(x).st_mtime)
            infos = dict((c, self._qinfo(c)) for c in copies)
            shas = dict((c, self._qsha(c, infos[c])) for c in copies)
            distinct = set(shas.values())
            chosen, verified = None, False
            live = os.path.join(survivor_pgdata, "pg_wal", name) if survivor_pgdata else None
            if live and os.path.isfile(live):
                live_sha = _sha256_file(live)
                same = [c for c in copies if shas[c] == live_sha]
                if not same:
                    report["skipped"].append({"name": name, "why": "no quarantined copy matches the primary's own file in pg_wal: the archiver will archive the primary's file itself once the stored one is retired"})
                else:
                    chosen, verified = same[-1], True
            elif len(distinct) > 1:
                # nothing tells which content is the survivor's: retiring the stored copy would leave the name absent (a hole nobody fills,
                # the survivor's pg_wal no longer has it) and promoting one of them is a guess
                report["skipped"].append({"name": name, "copies": len(distinct),
                                          "why": "%d distinct quarantined copies and none is proven by the primary's own pg_wal (the file is no longer there, or the "
                                                 "primary was not reachable): which one is the survivor's cannot be told, the stored copy is kept" % len(distinct)})
                continue
            else:
                chosen = copies[-1]
            if dry_run:
                report["retired"].append(name)
                if chosen:
                    report["promoted"].append(name)
                    report["verified" if verified else "unverified"].append(name)
                continue
            os.makedirs(ddir, mode=0o750, exist_ok=True)
            if not marked:
                self._mark_retired(ddir, tli, "retire_branch")
                marked = True
            # 1) the dead copy (+ its meta) goes aside, atomically renamed inside the same filesystem
            mp = os.path.join(self.wal_dir, name + ".meta")
            had_meta = os.path.exists(mp)
            suf = self._free_suffix(ddir, [os.path.basename(stored), name + ".meta"])
            aside = os.path.join(ddir, os.path.basename(stored) + suf)
            os.rename(stored, aside)
            meta_aside = os.path.join(ddir, name + ".meta" + suf)
            if had_meta:
                os.rename(mp, meta_aside)
            report["retired"].append(name)
            # 2) the survivor's copy takes its place through the normal write-once path (compression, encryption, meta, fsync); a sealed
            #    quarantined copy is opened first (this needs the archive's key: the executor builds the manager with it)
            if chosen:
                tmp = os.path.join(self.wal_dir, ".%s.promote.%d.%d" % (name, os.getpid(), threading.get_ident()))
                try:
                    info = infos[chosen]
                    w = dict(info.get("writer") or {})
                    w.update(via="retire", retired_by=socket.gethostname())
                    if verified and survivor_pgdata:
                        w["pgdata"] = survivor_pgdata
                    self.archive_segment(self._qplain(chosen, name, info, tmp), name, via="retire", writer=w)
                    self._qrename(chosen, chosen + ".dead-branch")       # consumed: it is in the archive now (kept as a trace, excluded from the alarm)
                    report["promoted"].append(name)
                    report["verified" if verified else "unverified"].append(name)
                except Exception as e:
                    # the name must not stay ABSENT (a recovery would read "end of archive" there): the set-aside copy goes back, the rest goes on
                    try:
                        if not self._find(name)[0]:
                            os.rename(aside, stored)
                            if had_meta:
                                os.rename(meta_aside, mp)
                            report["retired"].remove(name)
                    except OSError:
                        pass
                    report["skipped"].append({"name": name, "why": "quarantined copy not promoted (the stored copy is kept in place): %s" % e})
                finally:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
            for c in copies:
                if c != chosen and os.path.exists(c):
                    self._qrename(c, c + ".dead-branch")
        dfd = None
        try:
            dfd = os.open(self.wal_dir, os.O_RDONLY)
            os.fsync(dfd)
        except OSError:
            pass
        finally:
            if dfd is not None:
                os.close(dfd)
        self._cont_cache = (0, None, None)
        return report

    def _quarantine(self, src_path, name, raw_sha, size=None, is_history=False, writer=None, stored=None):
        """Keep the refused copy ONCE per (name, content), whoever archives it and however often PostgreSQL retries: the name is
        deterministic and published with link(2), which fails if it exists. A listdir() check was not enough on NFS (cached directory
        listings: the lab's shared archive held one history file quarantined dozens of times, seconds apart, each one an alarm).
        A copy already filed away as reviewed is not quarantined again.
        In an encrypted archive the copy is sealed with the archive's key (AAD "walq:<name>"): plaintext WAL never lands on a share whose
        segments are all encrypted (architecture review B5). Its sidecar <copy>.json keeps the raw sha256 and size (what readers compare
        and classify) and who wrote the refused copy and the stored one (G12)."""
        qdir = os.path.join(self.wal_dir, "conflicts")
        os.makedirs(qdir, mode=0o750, exist_ok=True)
        key = "%s.%s" % (name, raw_sha[:12])
        rdir = os.path.join(qdir, "reviewed")
        for d in (qdir, rdir):
            try:
                same = [x for x in os.listdir(d) if (x == key or x.startswith(key + ".")) and self._is_qcopy(x)]
            except OSError:
                same = []
            if same:
                return same[0]
        seal = bool(self.crypto) and not is_history                     # history files and labels are stored readable in the archive too
        side = {"name": name, "sha256": raw_sha, "size": int(size if size is not None else os.path.getsize(src_path)), "at": time.time()}
        if seal:
            side.update(enc="aes-256-gcm", key_id=self.crypto.key_id, aad="walq:" + name)
        if writer:
            side["writer"] = writer
        if stored:
            side["stored"] = stored
        final = os.path.join(qdir, key)
        tag = "%d.%d" % (os.getpid(), threading.get_ident())
        tmp = os.path.join(qdir, ".%s.tmp.%s" % (key, tag))
        stmp = os.path.join(qdir, ".%s.json.tmp.%s" % (key, tag))
        try:
            # the sidecar first: a sealed copy published without it would be taken for a plaintext one by every reader
            with open(stmp, "w", encoding="utf-8") as f:
                json.dump(side, f)
                f.flush()
                os.fsync(f.fileno())
            try:
                os.link(stmp, final + self.SIDECAR)
            except OSError as e:
                if e.errno != errno.EEXIST:
                    raise
            if seal:
                with open(src_path, "rb") as f:
                    data = f.read()
                with open(tmp, "wb") as f:
                    f.write(self.crypto.seal(data, "walq:" + name))
                    f.flush()
                    os.fsync(f.fileno())
            else:
                shutil.copyfile(src_path, tmp)
            try:
                os.link(tmp, final)
            except OSError as e:
                if e.errno != errno.EEXIST:
                    raise
        finally:
            for p in (tmp, stmp):
                try:
                    os.unlink(p)
                except OSError:
                    pass
        return key

    def conflicts_reviewed(self, files=None):
        """A person looked at them: moved to conflicts/reviewed/ (kept, with their sidecars), so they stop raising an alarm. files=None: all of them."""
        qdir = os.path.join(self.wal_dir, "conflicts")
        rdir = os.path.join(qdir, "reviewed")
        os.makedirs(rdir, mode=0o750, exist_ok=True)
        moved = []
        for c in self.conflicts():
            if files is None or c["file"] in files:
                self._qrename(os.path.join(qdir, c["file"]), os.path.join(rdir, c["file"]))
                moved.append(c["file"])
        return moved

    # ------------------------------------------------------------------ archive
    def _writer(self, via):
        """Who writes a copy (G12): this host, the data directory of the server it comes from and the path it took (archive_command,
        spool, rescue, retire). archive_command runs in the data directory (PostgreSQL's working directory); the agent's own paths know
        the server's pg_wal."""
        import socket
        pgdata = None
        if via == "archive_command":
            try:
                pgdata = os.getcwd()
            except OSError:
                pgdata = None
        elif getattr(self, "pg_wal_dir", None):
            pgdata = os.path.dirname(os.path.abspath(self.pg_wal_dir))
        return {"host": socket.gethostname(), "pgdata": pgdata, "via": via}

    def _text_writer_sysid(self, src_path, via):
        """The database that wrote a history file or a backup label (they carry no system identifier): PostgreSQL runs archive_command
        in its data directory, whose global/pg_control says it; otherwise a segment next to the file (pg_wal) does. None when neither
        tells (the file is accepted as before). Only for archive_command: the agent's own paths read from directories that are not the
        writer's pg_wal (the quarantine, a temporary file)."""
        if via != "archive_command":
            return None
        try:
            sysid = pgdata_sysid(os.getcwd())
        except OSError:
            sysid = None
        if sysid:
            return sysid
        d = os.path.dirname(os.path.abspath(src_path))
        try:
            names = sorted((n for n in os.listdir(d) if SEG_RE.match(n)), reverse=True)
        except OSError:
            return None
        for n in names[:8]:
            sysid = segment_sysid(os.path.join(d, n))
            if sysid:
                return sysid
        return None

    def archive_segment(self, src_path, name, via="archive_command", before_publish=None, writer=None):
        """archive_command %p %f. Returns (ok, dest, sha256, message); raises WalArchiveError on refusal.
        via: the path the copy took (archive_command, spool, rescue, retire), recorded in the meta with the host and data directory
        (writer overrides the whole record). before_publish: called right before a NEW object is published (never for an identical or
        refused copy); an exception from it abandons the publish (the spool pusher keeps a timeline's segments in order with it)."""
        is_history = name.endswith(".history") or BACKUP_LABEL_RE.match(name) is not None      # tiny text files: stored readable
        if not (SEG_RE.match(name) or is_history or re.match(r"^[0-9A-F]{24}\.partial$", name)):
            raise WalArchiveError("PGA-WAL-010", "refusing unexpected file name %r" % name)
        if not os.path.isfile(src_path):
            raise WalArchiveError("PGA-WAL-011", "source %s does not exist" % src_path)
        size = os.path.getsize(src_path)
        if SEG_RE.match(name) and (size & (size - 1) != 0 or size < (1 << 20) or size > (1 << 30)):
            raise WalArchiveError("PGA-WAL-012", "segment size %d is not a valid WAL segment size (partial copy?)" % size)

        sysid = segment_sysid(src_path) if not is_history else self._text_writer_sysid(src_path, via)
        if sysid:
            # history files and backup labels too (architecture review B7): another database's history accepted here made every
            # recovery with recovery_target_timeline=latest of THIS database try to follow it
            self._check_owner(sysid)
        elif is_history:
            logger.debug("%s: the database that wrote it cannot be told (not run from a data directory, no segment next to it): accepted", name)
        writer = writer or self._writer(via)
        if not is_history:
            self._check_key()
        raw_sha = _sha256_file(src_path)
        existing, codec = self._find(name)
        if existing:
            meta = self._read_meta(name)
            for _ in range(20):                                 # the winner of a publish race writes its meta right after the object: wait for it
                if meta is not None:
                    break
                time.sleep(0.1)
                meta = self._read_meta(name)
            stored = meta.get("sha256") if meta else None
            if stored is None:                                  # legacy object without meta: hash its decompressed content
                tmp = os.path.join(self.wal_dir, ".verify.%d.%d" % (os.getpid(), threading.get_ident()))
                sealed = False
                try:
                    src = existing
                    if self.crypto and not is_history:
                        # an encrypted object whose writer died between the publish and its meta (independent review): decrypt it first - hashing the
                        # ciphertext reported a split-brain, decompressing it failed forever, and the archiver stopped with pg_wal filling up
                        try:
                            with open(existing, "rb") as f:
                                plain = self.crypto.open(f.read(), "wal:" + name)
                            src = tmp + ".dec"
                            with open(src, "wb") as f:
                                f.write(plain)
                            sealed = True
                        except Exception:                       # the key says it is not ours (PGA-ENC-020/021)
                            src = existing                      # really not encrypted (an archive older than the key): as before
                    try:
                        self._decompress(src, tmp, codec)
                    finally:
                        if src != existing and os.path.exists(src):
                            os.unlink(src)
                    stored = _sha256_file(tmp)
                finally:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
                if stored == raw_sha:
                    # the same content: the missing meta is written now, so a restore reads the object as what it is
                    rep = {"sha256": raw_sha, "size": size, "codec": codec or "none", "archived_at": time.time(), "repaired": True, "writer": writer}
                    if sysid:
                        rep["sysid"] = sysid
                    if sealed:
                        rep["enc"] = "aes-256-gcm"
                        rep["key_id"] = self.crypto.key_id
                    self._write_meta_once(name, rep)
            if stored == raw_sha:
                # the writer that published it may have died before its fsyncs (PostgreSQL retried): durable before PostgreSQL recycles the segment
                for pth in (existing, os.path.join(self.wal_dir, name + ".meta")):
                    try:
                        fd = os.open(pth, os.O_RDONLY)
                        try:
                            os.fsync(fd)
                        finally:
                            os.close(fd)
                    except OSError:
                        pass
                _fsync_dir(self.wal_dir)
                return True, existing, raw_sha, "already archived (identical content)"
            qdir = os.path.join(self.wal_dir, "conflicts")
            qname = self._quarantine(src_path, name, raw_sha, size, is_history, writer,
                                     {"sha256": stored, "writer": (meta or {}).get("writer"), "archived_at": (meta or {}).get("archived_at")})
            if is_history:
                raise WalArchiveError("PGA-WAL-033", "timeline history %s already in the archive with DIFFERENT content (stored %s.. vs incoming %s..): two servers promoted "
                                      "themselves to the same timeline number (a split-brain between sites, or a server promoted without access to this archive). "
                                      "PostgreSQL stops archiving until this is solved; incoming copy quarantined as conflicts/%s"
                                      % (name, stored[:12], raw_sha[:12], qname))
            if name.endswith(".partial"):
                # PostgreSQL never restores a .partial (recovery reads the next timeline's copy of that segment): two promoted standbys each archive
                # their own; refusing the second blocked its archiver for good (independent review). Kept in quarantine, acknowledged.
                logger.warning("%s: a different .partial is in the archive (another promoted server's): never read by recovery, kept as conflicts/%s", name, qname)
                return True, existing, raw_sha, "a different .partial is already archived; recovery never reads it, this copy is kept as conflicts/%s" % qname
            why = _branch_not_on_our_history(src_path, name, getattr(self, "pg_wal_dir", None))
            if why:
                # the server's own timeline history never reads this copy (the segment holds or follows the point where this server left
                # that timeline: recovery takes the newer timeline's copy of it). Archiving it is pointless, and refusing it would block
                # PostgreSQL's archiver on it forever (seen on the lab: 15 h without archiving after a geo failover). Kept in quarantine.
                logger.warning("%s: a different copy is in the archive, but this server's history does not need it (%s): acknowledged, "
                               "incoming copy quarantined as conflicts/%s", name, why, qname)
                return True, existing, raw_sha, "not needed by this server's timeline history (%s); kept as conflicts/%s" % (why, qname)
            raise WalArchiveError("PGA-WAL-031", "DIVERGENT content for %s (stored %s.. vs incoming %s..): possible split-brain; incoming copy quarantined as conflicts/%s" % (name, stored[:12], raw_sha[:12], qname))

        tmp = os.path.join(self.wal_dir, ".%s.tmp.%d.%d" % (name, os.getpid(), threading.get_ident()))     # unique per writer, also per thread (spool pusher)
        codec_used = ""
        try:
            codec_used = "" if is_history else self._compress(src_path, tmp)     # history files are tiny: keep readable
            if is_history:
                shutil.copyfile(src_path, tmp)
            if self.crypto and not is_history:                                   # compress first, then encrypt; bound to the segment name
                with open(tmp, "rb") as f:
                    plain = f.read()
                with open(tmp, "wb") as f:
                    f.write(self.crypto.seal(plain, "wal:" + name))
            with open(tmp, "rb") as f:
                os.fsync(f.fileno())
            final = os.path.join(self.wal_dir, name + ("." + codec_used if codec_used else ""))
            meta = {"sha256": raw_sha, "size": size, "codec": codec_used or "none", "archived_at": time.time(), "writer": writer}
            if sysid:
                meta["sysid"] = sysid
            if self.crypto and not is_history:
                meta["enc"] = "aes-256-gcm"
                meta["key_id"] = self.crypto.key_id
            # the object is published first, write-once (link): of two writers only one wins, and only the winner writes the meta.
            # (Meta first would let the LOSER overwrite the winner's meta with its own sha: both would report success and the stored
            # segment would fail every later verification.) An object without meta is never trusted blindly: its content is hashed.
            if before_publish is not None:
                before_publish()                                             # may raise: nothing published, tmp removed below
            try:
                os.link(tmp, final)                                          # write-once publish
            except FileExistsError:                                          # lost a race with another writer: re-evaluate (idempotent / conflict)
                os.unlink(tmp)
                return self.archive_segment(src_path, name, via, before_publish, writer)
            os.unlink(tmp)
            mtmp = os.path.join(self.wal_dir, ".%s.meta.tmp.%d.%d" % (name, os.getpid(), threading.get_ident()))
            with open(mtmp, "w", encoding="utf-8") as f:
                json.dump(meta, f)
                f.flush()
                os.fsync(f.fileno())
            os.rename(mtmp, os.path.join(self.wal_dir, name + ".meta"))
            _fsync_dir(self.wal_dir)
            return True, final, raw_sha, "archived"
        finally:
            for p in (tmp,):
                if os.path.exists(p):
                    try:
                        os.unlink(p)
                    except OSError:
                        pass

    def _write_meta_once(self, name, meta):
        """Write <name>.meta when there is none (repair of an object published by a writer that died before its meta). Never overwrites one."""
        dst = os.path.join(self.wal_dir, name + ".meta")
        if os.path.exists(dst):
            return
        mtmp = os.path.join(self.wal_dir, ".%s.meta.tmp.%d.%d" % (name, os.getpid(), threading.get_ident()))
        try:
            with open(mtmp, "w", encoding="utf-8") as f:
                json.dump(meta, f)
                f.flush()
                os.fsync(f.fileno())
            try:
                os.link(mtmp, dst)                              # write-once: a concurrent writer's meta wins
            except FileExistsError:
                pass
            _fsync_dir(self.wal_dir)
        except OSError as e:
            logger.warning("%s: could not write the missing meta: %s", name, e)
        finally:
            if os.path.exists(mtmp):
                os.unlink(mtmp)

    # ------------------------------------------------------------------ database names seen (oid -> name)
    DBNAMES = ".pgarca-database-names"

    def note_databases(self, dbs):
        """Remember which oid carried which database name, as seen by the agent on the primary (the WAL records DROP DATABASE by oid only).
        A database created AFTER the last backup and dropped since is known to no backup catalog: this registry is how a restore tells it apart
        from other short-lived databases. Kept with the archive (shared by every node), written only when something new is seen, bounded."""
        seen = getattr(self, "_dbn_seen", None)
        if seen is None:
            own = self._read_database_names(self.wal_dir, strict=True)
            if own is None:
                return False                       # unreadable (another key, I/O error, torn file): never rewritten from an empty view
            seen = self._dbn_seen = dict(self.database_names())
        new = dict((str(d.get("oid")), str(d.get("name"))) for d in dbs or [] if d.get("oid") and d.get("name"))
        if all(seen.get(k) == v for k, v in new.items()):
            return False
        seen.update(new)
        return self._write_database_names(seen)

    def adopt_database_names(self, src_dir):
        """The archive moved (destination changed): the registry of the previous location joins this one, entries already here win.
        Returns how many names were adopted."""
        theirs = self._read_database_names(src_dir)
        seen = getattr(self, "_dbn_seen", None)
        if seen is None:
            own = self._read_database_names(self.wal_dir, strict=True)
            if own is None:
                return 0
            seen = self._dbn_seen = dict(own)
        add = dict((k, v) for k, v in theirs.items() if k not in seen)
        if not add:
            return 0
        seen.update(add)
        return len(add) if self._write_database_names(seen) else 0

    def _write_database_names(self, seen):
        mine, cur = (self.crypto.key_id if self.crypto else "none"), self.archive_key()
        if cur is not None and cur != mine:
            return False                           # never plaintext (or another key) into an archive that uses a different key
        if len(seen) > 5000:
            for k in sorted(seen, key=lambda x: int(x) if x.isdigit() else 0)[:len(seen) - 5000]:
                seen.pop(k, None)
        data = json.dumps({"v": 1, "names": seen}).encode("utf-8")
        if self.crypto:
            data = self.crypto.seal(data, "dbnames")
        tmp = os.path.join(self.wal_dir, "%s.tmp.%d.%d" % (self.DBNAMES, os.getpid(), threading.get_ident()))
        try:
            os.makedirs(self.wal_dir, exist_ok=True)
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.rename(tmp, os.path.join(self.wal_dir, self.DBNAMES))
            return True
        except OSError as e:
            logger.warning("database names not recorded: %s", e)
            return False
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def _read_database_names(self, d, strict=False):
        """{oid: name}; {} when there is no registry. Any other failure (another key, I/O, a torn file): {} - or None with strict, for a writer
        that must not overwrite what it could not read (independent review: a node without the key reduced the registry to nothing)."""
        try:
            with open(os.path.join(d, self.DBNAMES), "rb") as f:
                data = f.read()
        except (IOError, OSError) as e:
            return {} if getattr(e, "errno", None) == errno.ENOENT else (None if strict else {})
        try:
            if self.crypto:
                data = self.crypto.open(data, "dbnames")
            return dict(json.loads(data.decode("utf-8")).get("names") or {})
        except Exception:
            return None if strict else {}

    def database_names(self):
        """{oid (str): name} recorded by note_databases ({} when none or unreadable); the archive's previous locations are read too (this one wins)."""
        out = {}
        for d in list(reversed(self.previous)) + [self.wal_dir]:
            out.update(self._read_database_names(d))
        return out

    # ------------------------------------------------------------------ retrieve
    def retrieve_segment(self, name, dest_path, verify=True):
        """restore_command %f %p. Returns (exit_code, message). 0=ok, 1=not found, 126=corrupt (abort recovery).
        verify=False (read-only analysis such as pg_waldump scans): no sha256 check and no fsync, which are what a recovery needs and an analysis does not."""
        path, codec = self._find(name, anywhere=True)
        if not path:
            return EXIT_NOT_FOUND, "not in archive"
        d = os.path.dirname(os.path.abspath(dest_path)) or "."
        os.makedirs(d, exist_ok=True)
        tmp = "%s.arca.%d" % (dest_path, os.getpid())
        try:
            meta = self._read_meta(name, os.path.dirname(path))
            src = path
            if meta and meta.get("enc"):
                if not self.crypto:
                    return EXIT_CORRUPT, "PGA-ENC-005 segment %s is encrypted and no key is configured (encryption_key_file / PG_ARCA_KEY_FILE)" % name
                if meta.get("key_id") != self.crypto.key_id:
                    return EXIT_CORRUPT, "PGA-ENC-007 segment %s was encrypted with another key (%s)" % (name, meta.get("key_id"))
                src = tmp + ".dec"
                with open(path, "rb") as f:
                    plain = self.crypto.open(f.read(), "wal:" + name)
                with open(src, "wb") as f:
                    f.write(plain)
            elif self.crypto and not name.endswith(".history") and not BACKUP_LABEL_RE.match(name):
                # no meta (or a meta without "enc"): an encrypted object whose writer died before its meta is still ours - decrypt it; a really
                # plain object is refused - the meta is not authenticated, accepting plain WAL on its word would let anyone who can write to the
                # share inject WAL into a recovery (regression review)
                try:
                    with open(path, "rb") as f:
                        plain = self.crypto.open(f.read(), "wal:" + name)
                except Exception:
                    return EXIT_CORRUPT, "PGA-ENC-006 segment %s is not encrypted but an encryption key is configured" % name
                src = tmp + ".dec"
                with open(src, "wb") as f:
                    f.write(plain)
            try:
                self._decompress(src, tmp, codec)
            finally:
                if src != path and os.path.exists(src):
                    os.unlink(src)
            if verify:
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
    def has_segment(self, name, anywhere=True):
        return self._find(name, anywhere)[0] is not None

    def activity_since(self, ts):
        """True if anything was written to the archive directory (top level) at or after ts. Unknown (scan error) counts as activity,
        so a slow NFS never makes a caller fail fast for the wrong reason."""
        try:
            for e in os.scandir(self.wal_dir):
                try:
                    if e.is_file(follow_symlinks=False) and e.stat(follow_symlinks=False).st_mtime >= ts:
                        return True
                except OSError:
                    continue
        except OSError:
            return True
        return False

    def list_segments(self, anywhere=False):
        """Sorted list of archived WAL segment base names (no .history/.backup/.partial/.meta). anywhere=True: also the previous locations (read paths)."""
        out = set()
        names = []
        for i, d in enumerate([self.wal_dir] + (self.previous if anywhere else [])):
            try:
                names += os.listdir(d)
            except OSError:
                if i == 0:
                    return []
        for n in names:
            if n.startswith("."):
                continue
            base, _, ext = n.partition(".")
            if SEG_RE.match(base) and (ext == "" or ext in ("zst", "lz4", "gz")):
                out.add(base)
        return sorted(out)

    def list_histories(self):
        """History files of the archive and of its previous locations. A timeline set aside as a dead branch in the CURRENT archive
        (conflicts/dead-branch-<tli>/) is not brought back by a stale copy of its history left in a previous location."""
        out = set()
        for i, d in enumerate([self.wal_dir] + self.previous):
            try:
                names = set(n for n in os.listdir(d) if n.endswith(".history"))
            except OSError:
                continue
            if i:
                names = set(n for n in names if n in out or not os.path.isdir(os.path.join(self.wal_dir, "conflicts", "dead-branch-" + n[:8].upper())))
            out |= names
        return sorted(out)

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
    FLOOR_FILE = ".retention_floor.json"

    def set_retention_floor(self, segno, lsn_text=None):
        """Written by the retention (expire): segments below `segno` were removed ON PURPOSE. Gap detection ignores them and the WAL rescue never re-archives
        them (on the lab, standbys kept re-publishing old-timeline segments the retention had just removed, which then showed up as 'holes' in the archive)."""
        tmp = os.path.join(self.wal_dir, ".retention_floor.tmp.%d" % os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"segno": int(segno), "lsn": lsn_text, "at": time.time(), "seg_size": int(self.segment_size)}, f)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp, os.path.join(self.wal_dir, self.FLOOR_FILE))
        _fsync_dir(self.wal_dir)
        self._cont_cache = (0, None, None)

    def retention_floor(self):
        try:
            with open(os.path.join(self.wal_dir, self.FLOOR_FILE), "r", encoding="utf-8") as f:
                return int(json.load(f).get("segno") or 0)
        except (IOError, OSError, ValueError, TypeError):
            return 0

    def verify_continuity(self, max_age=30, current_timeline=None, local_wal_dir=None):
        """Timeline-aware gap detection. Cached (dir mtime + max_age) so heartbeats stay cheap on huge archives. current_timeline (the timeline
        the local PostgreSQL is on) classifies the quarantined copies: only the ones on the shared history count as `conflicts`."""
        now = time.time()
        try:
            mt = os.stat(self.wal_dir).st_mtime
        except OSError:
            mt = None
        at, cmt, rep = self._cont_cache
        if rep is not None and cmt == mt and now - at < max_age and rep.get("_tl") == current_timeline:
            return rep
        rep = self._compute_continuity(current_timeline, local_wal_dir)
        rep["_tl"] = current_timeline
        self._cont_cache = (now, mt, rep)
        return rep

    def _history_forks(self, tli, directory=None):
        """{ancestor timeline: LSN where it ended} from <tli>.history (in the archive - the current location first, then the previous ones a
        destination change left, which restore_command reads too - or in `directory`), or None when the file is missing/unreadable."""
        lines = None
        dirs = [directory] if directory else [self.wal_dir] + ([] if os.path.isdir(os.path.join(self.wal_dir, "conflicts", "dead-branch-%08X" % tli)) else list(self.previous or []))
        for d in dirs:
            try:
                with open(os.path.join(d, "%08X.history" % tli), "r", encoding="utf-8", errors="replace") as f:
                    lines = f.read().splitlines()
                break
            except (IOError, OSError):
                continue
        if lines is None:
            return None
        forks = {}
        for ln in lines:
            parts = ln.split("\t") if "\t" in ln else ln.split(None, 2)
            if len(parts) >= 2 and parts[0].strip().isdigit() and re.match(r"^[0-9A-Fa-f]+/[0-9A-Fa-f]+$", parts[1].strip()):
                hi, lo = parts[1].strip().split("/")
                forks[int(parts[0])] = (int(hi, 16) << 32) | int(lo, 16)
        return forks

    def _cross_timeline_gaps(self, timelines, per_id):
        """Gaps that no per-timeline check can see: WAL that a failover left in NEITHER timeline (e.g. the old primary died before archiving its last segments and the
        promoted standby never archives what it merely received). Recovery that crosses the fork needs every segment up to the fork on the OLD timeline and the rest on the NEW one."""
        if len(timelines) < 2:
            return []
        latest = max(timelines)
        forks = self._history_forks(latest)
        if not forks:
            return []
        seg = self.segment_size
        chain = sorted(forks)                                               # ancestors of `latest`, oldest first
        if any(t >= latest for t in chain):
            return []
        span = {}                                                           # tli -> (first segno, last segno) it may provide
        prev = None
        for t in chain + [latest]:
            first = (forks[prev] // seg) if prev is not None else 0
            last = (((forks[t] - 1) // seg) if forks[t] % seg == 0 else (forks[t] // seg)) if t in forks else (1 << 62)   # a fork exactly at a segment start needs nothing of that segment on the old timeline
            span[t] = (first, last)
            prev = t
        have = {t: set(timelines.get(t, [])) for t in span}
        lo = min((min(v) for v in have.values() if v), default=None)
        if lo is not None:
            lo = max(lo, self.retention_floor())
        hi = max(have[latest]) if have[latest] else None
        if lo is None or hi is None or hi < lo:
            return []
        nm = lambda t, n: "%08X%08X%08X" % (t, n // per_id, n % per_id)
        out, run = [], None
        for n in range(lo, hi + 1):
            if any(a <= n <= b and n in have[t] for t, (a, b) in span.items()):
                run = None
                continue
            owner = next((t for t, (a, b) in span.items() if a <= n <= b), latest)
            if run and run["_end"] == n - 1 and run["timeline"] == owner:
                run["_end"] = n
                run["count"] += 1
                run["missing_to"] = nm(owner, n)
            else:
                run = {"timeline": owner, "_end": n, "count": 1, "across_failover": True, "missing_from": nm(owner, n), "missing_to": nm(owner, n)}
                out.append(run)
        for r in out:
            r.pop("_end", None)
        return out

    def _branch_tails(self, timelines, histories, per_id):
        """Segments of a timeline T archived PAST the point where a later timeline's history says T ended (architecture review G1): after
        a promotion to N at F, the old primary went on writing timeline T (it never learned of the promotion), or had written WAL the
        promoted server never received. Those segments are another server's work, on no surviving history; nothing refuses them (their
        names are free), so this is how they are seen. The end of T is the LATEST fork point any archived history gives for it: a
        point-in-time branch from an earlier point of T (a restore) does not make T's later, pre-promotion segments a tail. The segment
        that holds the fork point is not counted (it legitimately holds WAL of both sides)."""
        ends = {}
        for h in sorted(histories):
            m = re.match(r"^([0-9A-F]{8})\.history$", h)
            if not m:
                continue
            n = int(m.group(1), 16)
            for t, f in (self._history_forks(n) or {}).items():
                if t < n and (t not in ends or f > ends[t][0]):
                    ends[t] = (f, n)
        seg = self.segment_size
        nm = lambda t, x: "%08X%08X%08X" % (t, x // per_id, x % per_id)
        out = []
        for t in sorted(ends):
            f, n = ends[t]
            tail = sorted(x for x in timelines.get(t, []) if x * seg > f)
            if tail:
                out.append({"timeline": t, "successor": n, "fork_lsn": "%X/%X" % (f >> 32, f & 0xFFFFFFFF), "count": len(tail),
                            "first": nm(t, tail[0]), "last": nm(t, tail[-1])})
        return out

    def _conflict_counts(self, current_timeline=None, local_wal_dir=None):
        cl = self.classify_conflicts(current_timeline, local_wal_dir=local_wal_dir)
        div = [c for c in cl if c.get("kind") == "divergent"]
        # one divergent CONTENT is one problem, however many times older agents quarantined it (they used a timestamp in the name)
        uniq = lambda xs: len(set((c["name"], c["sha"]) for c in xs))
        return {"conflicts": uniq(div), "conflicts_newest": max([c["at"] for c in div] or [0]) or None,
                "conflicts_off_history": uniq([c for c in cl if c.get("kind") != "divergent"]), "conflicts_classified": current_timeline is not None}

    def _compute_continuity(self, current_timeline=None, local_wal_dir=None):
        per_id = 0x100000000 // self.segment_size
        names, timelines, histories = [], {}, []
        floor, below = self.retention_floor(), 0
        for n in os.listdir(self.wal_dir):
            if n.startswith("."):
                continue                      # .pgarca-id (storage identity) and other hidden bookkeeping
            base = n.split(".")[0]
            if n.endswith(".history"):
                histories.append(n)
                continue
            if ".partial" in n or ".backup" in n:
                continue                      # promotion leaves <seg>.partial (and .partial.zst): not a segment, must not look like a duplicate
            if n.endswith((".meta", ".tmp")) or n.startswith(".") or n.count(".") > 1 and not n.endswith((".zst", ".lz4", ".gz")):
                continue                      # .backup / .partial / temp files are not segments
            m = SEG_RE.match(base)
            if m and (n == base or n.endswith((".zst", ".lz4", ".gz"))):
                tli, log, seg = (int(x, 16) for x in m.groups())
                if log * per_id + seg < floor:
                    below += 1                # left over below what the retention removed on purpose (re-archived by an old agent, copied by hand): not part of any chain
                    continue
                timelines.setdefault(tli, []).append(log * per_id + seg)
                names.append(base)
        if not names:
            return dict({"continuous": True, "total_segments": 0, "gaps": [], "timelines": [], "status": "archive is empty", "histories": sorted(histories),
                         "branch_tails": []},
                        **self._conflict_counts(current_timeline, local_wal_dir))
        gaps = []
        for tli, nums in timelines.items():
            nums.sort()
            for a, b in zip(nums, nums[1:]):
                if b != a + 1:
                    gaps.append({"timeline": tli, "missing_from": "%08X%08X%08X" % (tli, (a + 1) // per_id, (a + 1) % per_id),
                                 "missing_to": "%08X%08X%08X" % (tli, (b - 1) // per_id, (b - 1) % per_id), "count": b - a - 1})
        gaps += self._cross_timeline_gaps(timelines, per_id)
        names.sort()
        return {"continuous": not gaps, "total_segments": len(names), "gaps": gaps[:50], "gap_count": len(gaps),
                "timelines": sorted(timelines), "histories": sorted(histories), "first_segment": names[0], "last_segment": names[-1],
                **self._conflict_counts(current_timeline, local_wal_dir), "below_retention_floor": below,
                "branch_tails": self._branch_tails(timelines, histories, per_id),
                "status": "continuous" if not gaps else "%d gap(s) detected" % len(gaps)}


class LiveWal(object):
    """The agent's long-lived view of the WAL archive, rebuilt whenever the settings it depends on change (destination, encryption key,
    compression, previous locations). Built once at start, the agent's own manager missed the key (asynchronous archiving and the WAL rescue
    stored PLAINTEXT segments that restores then refused, PGA-ENC-006) and kept writing to the old directory after a destination change
    (independent review, 16/10)."""

    def __init__(self, config, seg_size=lambda: 16 * 1024 * 1024, pg_wal=lambda: None):
        self._config, self._seg, self._pgwal = config, seg_size, pg_wal
        self._key, self._obj = None, None
        self._lock = threading.Lock()

    def current(self):
        c = self._config
        kf = c.get("encryption_key_file") or os.environ.get("PG_ARCA_KEY_FILE") or None
        key = (c.get("wal_archive_dir"), kf, c.get("compression", "zstd"), int(c.get("compression_level", 3)), int(self._seg() or 16 * 1024 * 1024),
               tuple(c.get("wal_previous") or []))
        with self._lock:
            if key != self._key:
                crypto = None
                if kf:
                    from pg_arca.engine.crypt import from_settings
                    crypto = from_settings(kf)               # a key that cannot be read must stop archiving, never fall back to plaintext
                self._obj = WalManager(key[0], key[2], key[3], key[4], crypto=crypto, previous=list(key[5]) or None,
                                       known_file=known_archives_file(c.get("state_dir")))
                self._key = key
            try:
                self._obj.pg_wal_dir = self._pgwal()                 # the spool pusher's copies come from the spool: the history is in pg_wal
            except Exception:
                self._obj.pg_wal_dir = None
            return self._obj

    def __getattr__(self, name):
        return getattr(self.current(), name)
