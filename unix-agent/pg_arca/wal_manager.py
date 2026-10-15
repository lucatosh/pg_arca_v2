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
BACKUP_LABEL_RE = re.compile(r"^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$")     # e.g. 000000010000000000000003.00000028.backup
EXIT_NOT_FOUND = 1
EXIT_CORRUPT = 126      # aborts PostgreSQL recovery (documented behaviour of restore_command)

try:
    import zstandard as _zstd
except Exception:  # pragma: no cover
    _zstd = None


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


class WalManager:
    def __init__(self, wal_dir="/var/lib/pgarca/wal", compression="zstd", level=3, segment_size=16 * 1024 * 1024, crypto=None, previous=None):
        self.crypto = crypto
        self.wal_dir = wal_dir
        # earlier locations of this archive (the destination was changed): READ only - restores and chain checks find old segments there;
        # archiving, duplicate detection and retention work on wal_dir alone
        self.previous = [d for d in (previous or []) if d and os.path.realpath(d) != os.path.realpath(wal_dir)]
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
        if cur is None:
            p = os.path.join(self.wal_dir, OWNER_FILE)
            tmp = "%s.%d.tmp" % (p, os.getpid())
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
        if cur and cur != sysid:
            raise WalArchiveError("PGA-WAL-032", "this WAL archive (%s) belongs to another database (system identifier %s; this one is %s): each PostgreSQL cluster "
                                  "needs its own WAL archive directory. Set a different wal_archive_dir for this cluster" % (self.wal_dir, cur, sysid))

    # ------------------------------------------------------------------ quarantine
    def conflicts(self):
        """Divergent copies waiting for a person: [{file, name, sha, at, size}] (conflicts/, not conflicts/reviewed/)."""
        qdir = os.path.join(self.wal_dir, "conflicts")
        out = []
        for f in (sorted(os.listdir(qdir)) if os.path.isdir(qdir) else []):
            p = os.path.join(qdir, f)
            if not os.path.isfile(p) or f.endswith(".dead-branch"):
                continue
            parts = f.split(".")
            name = ".".join(parts[:2]) if len(parts) > 1 and parts[1] in ("history", "partial") else parts[0]
            try:
                st = os.stat(p)
                out.append({"file": f, "name": name, "sha": parts[2] if name.endswith(".history") and len(parts) > 2 else (parts[1] if len(parts) > 1 else ""),
                            "at": st.st_mtime, "size": st.st_size, "timeline": int(name[:8], 16) if re.match(r"^[0-9A-F]{8}", name) else None})
            except OSError:
                pass
        return out

    def retire_branch(self, timeline, survivor_pgdata=None, dry_run=False):
        """Two servers used the SAME timeline number (split-brain, or a promotion without access to the archive): the archive holds the
        first writer's copies and refused the other's (conflicts/). When the operator says which server is the right one - the current
        primary, whose refused copies are in quarantine - every stored object of that timeline that has a divergent quarantined copy is
        the DEAD branch: it moves to conflicts/dead-branch-<tli>/ (nothing is deleted) and the quarantined copy takes its place, so the
        primary's archiver resumes at once. Objects of that timeline WITHOUT a quarantined copy are shared by both branches (before the
        fork) and stay. survivor_pgdata: when the primary's pg_wal still holds the file, the quarantined copy is promoted only if its
        content is byte-identical to it (proof it is the survivor's copy). Returns a report; dry_run only reports."""
        tli = int(timeline)
        prefix = "%08X" % tli
        qdir = os.path.join(self.wal_dir, "conflicts")
        ddir = os.path.join(qdir, "dead-branch-%s" % prefix)
        cands = {}
        for sub in ("", "reviewed"):
            d = os.path.join(qdir, sub)
            for f in (sorted(os.listdir(d)) if os.path.isdir(d) else []):
                if not f.startswith(prefix) or f.endswith(".dead-branch"):
                    continue
                parts = f.split(".")
                name = ".".join(parts[:2]) if len(parts) > 1 and parts[1] in ("history", "partial") else parts[0]
                p = os.path.join(d, f)
                if os.path.isfile(p):
                    cands.setdefault(name, []).append(p)           # newest quarantined copy last (sorted by name = by sha then time)
        report = {"timeline": tli, "retired": [], "promoted": [], "kept": [], "skipped": [], "dead_branch_dir": ddir, "dry_run": bool(dry_run)}
        for name in sorted(cands):
            stored, codec = self._find(name)
            if not stored:
                report["skipped"].append({"name": name, "why": "nothing stored under this name any more"})
                continue
            copies = sorted(cands[name], key=lambda x: os.stat(x).st_mtime)
            chosen = copies[-1]
            if survivor_pgdata:
                live = os.path.join(survivor_pgdata, "pg_wal", name)
                if os.path.isfile(live):
                    live_sha = _sha256_file(live)
                    same = [c for c in copies if _sha256_file(c) == live_sha]
                    if not same:
                        report["skipped"].append({"name": name, "why": "no quarantined copy matches the primary's own file in pg_wal: the archiver will archive the primary's file itself once the stored one is retired"})
                        chosen = None
                    else:
                        chosen = same[-1]
            if dry_run:
                report["retired"].append(name)
                if chosen:
                    report["promoted"].append(name)
                continue
            os.makedirs(ddir, mode=0o750, exist_ok=True)
            # 1) the dead copy (+ its meta) goes aside, atomically renamed inside the same filesystem
            os.rename(stored, os.path.join(ddir, os.path.basename(stored)))
            mp = os.path.join(self.wal_dir, name + ".meta")
            if os.path.exists(mp):
                os.rename(mp, os.path.join(ddir, name + ".meta"))
            report["retired"].append(name)
            # 2) the survivor's copy takes its place through the normal write-once path (compression, meta, fsync)
            if chosen:
                try:
                    self.archive_segment(chosen, name)
                    os.rename(chosen, chosen + ".dead-branch")       # consumed: it is in the archive now (kept as a trace, excluded from the alarm)
                    report["promoted"].append(name)
                except WalArchiveError as e:
                    report["skipped"].append({"name": name, "why": "quarantined copy not promoted: %s" % e})
            for c in copies:
                if c != chosen and os.path.exists(c) and not c.endswith(".dead-branch"):
                    os.rename(c, c + ".dead-branch")
        dfd = None
        try:
            dfd = os.open(self.wal_dir, os.O_RDONLY)
            os.fsync(dfd)
        except OSError:
            pass
        finally:
            if dfd is not None:
                os.close(dfd)
        return report

    def conflicts_reviewed(self, files=None):
        """A person looked at them: moved to conflicts/reviewed/ (kept), so they stop raising an alarm. files=None: all of them."""
        qdir = os.path.join(self.wal_dir, "conflicts")
        rdir = os.path.join(qdir, "reviewed")
        os.makedirs(rdir, mode=0o750, exist_ok=True)
        moved = []
        for c in self.conflicts():
            if files is None or c["file"] in files:
                os.rename(os.path.join(qdir, c["file"]), os.path.join(rdir, c["file"]))
                moved.append(c["file"])
        return moved

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

        sysid = segment_sysid(src_path) if not is_history else None
        if sysid:
            self._check_owner(sysid)
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
                try:
                    self._decompress(existing, tmp, codec)
                    stored = _sha256_file(tmp)
                finally:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
            if stored == raw_sha:
                return True, existing, raw_sha, "already archived (identical content)"
            qdir = os.path.join(self.wal_dir, "conflicts")
            # PostgreSQL retries the archive_command every minute: the same incoming content is quarantined ONCE, not once per retry
            prev = [x for x in (os.listdir(qdir) if os.path.isdir(qdir) else []) if x.startswith("%s.%s." % (name, raw_sha[:12]))]
            qname = prev[0] if prev else "%s.%s.%d" % (name, raw_sha[:12], int(time.time()))
            if not prev:
                os.makedirs(qdir, mode=0o750, exist_ok=True)
                shutil.copyfile(src_path, os.path.join(qdir, qname))
            if is_history:
                raise WalArchiveError("PGA-WAL-033", "timeline history %s already in the archive with DIFFERENT content (stored %s.. vs incoming %s..): two servers promoted "
                                      "themselves to the same timeline number (a split-brain between sites, or a server promoted without access to this archive). "
                                      "PostgreSQL stops archiving until this is solved; incoming copy quarantined as conflicts/%s"
                                      % (name, stored[:12], raw_sha[:12], qname))
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
            meta = {"sha256": raw_sha, "size": size, "codec": codec_used or "none", "archived_at": time.time()}
            if sysid:
                meta["sysid"] = sysid
            if self.crypto and not is_history:
                meta["enc"] = "aes-256-gcm"
                meta["key_id"] = self.crypto.key_id
            # the object is published first, write-once (link): of two writers only one wins, and only the winner writes the meta.
            # (Meta first would let the LOSER overwrite the winner's meta with its own sha: both would report success and the stored
            # segment would fail every later verification.) An object without meta is never trusted blindly: its content is hashed.
            try:
                os.link(tmp, final)                                          # write-once publish
            except FileExistsError:                                          # lost a race with another writer: re-evaluate (idempotent / conflict)
                os.unlink(tmp)
                return self.archive_segment(src_path, name)
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
                return EXIT_CORRUPT, "PGA-ENC-006 segment %s is not encrypted but an encryption key is configured" % name
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
        out = set()
        for d in [self.wal_dir] + self.previous:
            try:
                out |= set(n for n in os.listdir(d) if n.endswith(".history"))
            except OSError:
                continue
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
            json.dump({"segno": int(segno), "lsn": lsn_text, "at": time.time()}, f)
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

    def _history_forks(self, tli):
        """{ancestor timeline: LSN where it ended} from <tli>.history, or None when the file is missing/unreadable."""
        try:
            with open(os.path.join(self.wal_dir, "%08X.history" % tli), "r", encoding="utf-8", errors="replace") as f:
                lines = f.read().splitlines()
        except (IOError, OSError):
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

    def _compute_continuity(self):
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
            return {"continuous": True, "total_segments": 0, "gaps": [], "timelines": [], "status": "archive is empty", "histories": sorted(histories)}
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
                "conflicts": len(self.conflicts()), "conflicts_newest": max([c["at"] for c in self.conflicts()] or [0]) or None, "below_retention_floor": below,
                "status": "continuous" if not gaps else "%d gap(s) detected" % len(gaps)}
