"""Repository: content-addressed chunk store + backup sets + stanza lock. WAL lives in the shared WAL archive.

  <repo>/repo.json
  <repo>/cas/packs/<id>.pack + .idx             format 2 (every repository written by this engine): thousands of chunks per file, see engine/packs.py
  <repo>/cas/<aa>/<bb>/<blake2b-256>            format 1: one file per chunk (1 tag byte + compressed chunk); still read, never written again
  <repo>/stanza/<name>/stanza.json
  <repo>/stanza/<name>/backup/<set>/{meta.json, manifest.json.z, catalog.json.z, backup_label}
  <repo>/stanza/<name>/locks/
Durability: chunks are written tmp+rename WITHOUT per-chunk fsync (speed); a backup set is committed
only after one global sync(), and chunks written by a crashed run are re-verified before being reused.
"""

import errno
import fcntl
import json
import os
import socket
import threading
import time
import uuid

from pg_arca.engine import ENGINE_VERSION
from pg_arca.engine import packs as _packs
from pg_arca.engine.util import (read_file, CHUNK_SIZE, HASH_NAME, EngineError, chunk_hash, compress, decompress, fsync_dir, iso, read_json,
                                 write_file_atomic, write_json)

DEDUP_TOUCH_AFTER = 3600          # refresh mtime of a reused chunk at most once per hour (GC grace relies on it)
READ_RUN_MAX = 8 * 1048576        # a restore reads adjacent chunks of a pack in one call, up to this many bytes
GC_GRACE = 48 * 3600


class Lock(object):
    def __init__(self, f, token, path):
        self.f, self.token, self.path = f, token, path

    def release(self):
        try:
            fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
        finally:
            self.f.close()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.release()


class Repo(object):
    def __init__(self, path, stanza, wal=None, algo=None, level=3, crypto=None, previous=None, readonly=False):
        self.path = os.path.realpath(path)
        self.readonly = readonly             # a location opened only for reading (migration source): nothing is written there, not even the index cache
        # earlier locations of this repository (the destination was changed and the old content is not migrated yet): READ only. Their sets are
        # listed and restorable; new backups never deduplicate against them, never use them as parent and retention never touches them.
        self.previous = [os.path.realpath(x) for x in (previous or []) if x and os.path.realpath(x) != self.path]
        self.stanza = stanza
        self.wal = wal                       # WalManager
        self.algo = algo
        self.level = level
        self.crypto = crypto                 # engine.crypt.Crypto or None
        self.suspect_since = None            # chunks newer than this are re-verified before dedup (crashed run before us)
        self._index = None                   # packs.ChunkIndex, loaded on first use
        self._index_lock = threading.Lock()
        self._writers = []                   # open PackWriters of this process (one per writing thread)
        self._tl = threading.local()         # .writer, .reader
        self._legacy = None                  # does cas/ hold per-file chunks (format 1)? decided once per process
        self._touched = {}                   # pack path -> last mtime refresh (dedup against a pack keeps it out of the GC grace)

    def p(self, *a):
        return os.path.join(self.path, *a)

    def sp(self, *a):
        p = os.path.join(self.path, "stanza", self.stanza, *a)
        if self.previous and len(a) >= 2 and a[0] == "backup" and not os.path.isdir(os.path.join(self.path, "stanza", self.stanza, "backup", a[1])):
            for root in self.previous:                          # a set that lives in a previous location only
                q = os.path.join(root, "stanza", self.stanza, "backup", a[1])
                if os.path.isdir(q):
                    return os.path.join(root, "stanza", self.stanza, *a)
        return p

    def location_of(self, set_id):
        """The root that holds `set_id` (this repository or a previous location)."""
        for root in [self.path] + self.previous:
            if os.path.isdir(os.path.join(root, "stanza", self.stanza, "backup", set_id)):
                return root
        return None

    def hash(self, data):
        return self.crypto.chunk_id(data) if self.crypto else chunk_hash(data)

    def _pack(self, data, aad):
        return self.crypto.seal(data, aad) if self.crypto else data

    def _unpack(self, blob, aad):
        if blob[:1] == b"E":
            if not self.crypto:
                raise EngineError("PGA-ENC-005", "this repository is encrypted and no key is configured", "set encryption_key_file in agent.conf")
            return self.crypto.open(blob, aad)
        if self.crypto:
            raise EngineError("PGA-ENC-006", "found an unencrypted object in an encrypted repository: %s" % aad, "the repository was tampered with or mixed")
        return blob

    def write_zjson(self, path, obj, name):
        """compressed (+encrypted) json: manifests and catalogs carry file names, so they are protected like the data."""
        import json
        data = compress(json.dumps(obj, sort_keys=True).encode("utf-8"), "zlib", 6)
        write_file_atomic(path, self._pack(data, "json:" + name), 0o640)

    def read_zjson(self, path, name):
        import json
        with open(path, "rb") as f:
            blob = f.read()
        return json.loads(decompress(self._unpack(blob, "json:" + name)).decode("utf-8"))

    def cas_path(self, h):
        """Format-1 path of chunk `h` (where an old repository keeps it; new chunks go to packs)."""
        return self.p("cas", h[0:2], h[2:4], h)

    # ------------------------------------------------------------------ chunk index (packs)
    def index(self):
        if self._index is None:
            with self._index_lock:
                if self._index is None:
                    self._index = _packs.ChunkIndex([self.path] + self.previous, readonly=self.readonly)
        return self._index

    def reload_index(self):
        """After garbage collection (packs deleted or rewritten) or when another process changed the repository."""
        with self._index_lock:
            self._index = None
        self._touched = {}

    def has_legacy_chunks(self):
        """True when cas/ holds format-1 chunk files (a repository older than format 2): then a miss in the pack index is also looked up as a file."""
        if self._legacy is None:
            found = False
            for root in [self.path] + self.previous:
                try:
                    if any(len(n) == 2 for n in os.listdir(os.path.join(root, "cas"))):
                        found = True
                        break
                except OSError:
                    continue
            self._legacy = found
        return self._legacy

    def locate(self, h):
        """(path, offset, length) of chunk `h`: in a pack, or a format-1 file (offset 0); None when absent everywhere."""
        hb = bytes.fromhex(h)
        r = self.index().find(hb)
        if r is not None:
            return r
        if self.has_legacy_chunks():
            for root in [self.path] + self.previous:
                q = os.path.join(root, "cas", h[0:2], h[2:4], h)
                try:
                    return q, 0, os.path.getsize(q)
                except OSError:
                    continue
        return None

    def find_chunk(self, h):
        """Path holding chunk `h` (its pack, or its format-1 file) here or in a previous location, else None."""
        r = self.locate(h)
        return r[0] if r else None

    def flush(self):
        """Seal every open pack of this process: their chunks are durable and indexed. Called before a manifest that references them is written,
        and when a backup ends either way (chunks of a failed attempt are reused by the next one)."""
        with self._index_lock:
            ws, self._writers = self._writers, []
        for w in ws:
            w.seal()
            if w.broken and self._index is not None:
                self._index.forget_pack(w.final)

    def close(self):
        self.flush()
        r = getattr(self._tl, "reader", None)
        if r is not None:
            r.close()

    def _reader(self):
        r = getattr(self._tl, "reader", None)
        if r is None:
            r = self._tl.reader = _packs.PackReader()
        return r

    def _own_open_pack(self, path):
        """True when `path` is the final name of a pack this process is still writing (it exists only as .pack.open until sealed)."""
        with self._index_lock:
            return any(w.final == path and not w.sealed for w in self._writers)

    def _touch_pack(self, path):
        """A pack we deduplicated against is in use by a backup that has no manifest yet: refresh its mtime so that the GC grace covers it.
        Returns False when the pack is gone (deleted or rewritten by a garbage collection since the index was loaded): the caller must not
        deduplicate against it. The check is cached for an hour per pack (a pack touched less than an hour ago is inside the 48 h grace);
        when the mtime cannot be refreshed (another owner on a shared mount) it is cached for a minute only."""
        now = time.time()
        if now - self._touched.get(path, 0) < DEDUP_TOUCH_AFTER:
            return True
        try:
            st = os.stat(path)
        except OSError as e:
            if e.errno in (errno.ENOENT, errno.ESTALE):
                self._touched.pop(path, None)
                return False
            self._touched[path] = now - DEDUP_TOUCH_AFTER + 60
            return True
        self._touched[path] = now
        if now - st.st_mtime > DEDUP_TOUCH_AFTER:
            try:
                os.utime(path, None)
            except OSError:
                self._touched[path] = now - DEDUP_TOUCH_AFTER + 60
        return True

    # ------------------------------------------------------------------ repository-wide lock between writers and the garbage collector
    def gc_lock(self, shared):
        """cas/gc.lock: backups and migrations hold it SHARED for their whole run, the garbage collector takes it EXCLUSIVE (non-blocking).
        Chunks are deduplicated against an index loaded at the start of a run: a pack the collector deletes meanwhile would leave a COMPLETE
        set pointing at nothing. Stanza locks cannot give this guarantee (every stanza of a shared repository has its own). Returns a Lock,
        or None when the exclusive lock is busy (the collector then skips its pass)."""
        os.makedirs(self.p("cas"), mode=0o750, exist_ok=True)
        lp = self.p("cas", "gc.lock")
        f = open(lp, "a+")
        try:
            fcntl.flock(f.fileno(), (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        except (IOError, OSError) as e:
            f.close()
            if e.errno not in (errno.EAGAIN, errno.EACCES):
                raise
            if shared:                                             # a collector is inside its (short) pass: wait for it rather than fail the backup
                f = open(lp, "a+")
                fcntl.flock(f.fileno(), fcntl.LOCK_SH)
            else:
                return None
        return Lock(f, 0, lp)

    def cas_stats(self):
        """{"chunks", "stored_bytes", "packs", "files"}: packs counted from their index headers, format-1 files walked (none in a new repository)."""
        n = total = npacks = nfiles = 0
        for root in [self.path] + self.previous:
            for pack, idx, _, size in _packs.list_packs(root):
                if idx is None:
                    continue
                total += size
                npacks += 1
                try:
                    n += _packs.idx_count(idx)
                except OSError:
                    pass
            if not self.has_legacy_chunks():
                continue
            cas = os.path.join(root, "cas")
            for sub in os.listdir(cas) if os.path.isdir(cas) else []:
                if len(sub) != 2:
                    continue
                for dp, _, files in os.walk(os.path.join(cas, sub)):
                    for f in files:
                        if ".tmp." in f:
                            continue
                        try:
                            total += os.path.getsize(os.path.join(dp, f))
                            n += 1
                            nfiles += 1
                        except OSError:
                            pass
        return {"chunks": n, "stored_bytes": total, "packs": npacks, "files": nfiles}

    # ------------------------------------------------------------------ lifecycle
    def init(self):
        for d in ("cas", "stanza"):
            os.makedirs(self.p(d), mode=0o750, exist_ok=True)
        rj = self.p("repo.json")
        if os.path.exists(rj):
            meta = read_json(rj)
            if meta.get("chunk_size") != CHUNK_SIZE or meta.get("hash") != HASH_NAME:
                raise EngineError("PGA-REPO-002", "repository uses chunk=%s hash=%s, this engine uses chunk=%d hash=%s"
                                  % (meta.get("chunk_size"), meta.get("hash"), CHUNK_SIZE, HASH_NAME), "never mix chunking parameters in one repository")
            enc = meta.get("encryption")
            if enc and not self.crypto:
                raise EngineError("PGA-ENC-005", "this repository is encrypted (key %s) and no key is configured" % enc.get("key_id"), "set encryption_key_file in agent.conf")
            if enc and enc.get("key_id") != self.crypto.key_id:
                raise EngineError("PGA-ENC-007", "wrong key: the repository was created with key %s, the configured one is %s" % (enc.get("key_id"), self.crypto.key_id))
            if self.crypto and not enc:
                raise EngineError("PGA-ENC-008", "this repository is NOT encrypted and cannot be switched to encryption in place",
                                  "create a new repository with the key configured and take a new full backup; the old one stays readable only without the key")
        else:
            meta = {"format": _packs.FORMAT, "created": iso(), "chunk_size": CHUNK_SIZE, "hash": HASH_NAME, "engine": ENGINE_VERSION}
            if self.crypto:
                meta["encryption"] = {"alg": "aes-256-gcm", "key_id": self.crypto.key_id, "hash": "keyed-blake2b-256"}
            write_json(rj, meta)
        if int(meta.get("format") or 1) < _packs.FORMAT:
            # a format-1 repository: its files stay where they are and are read as before; from now on chunks go to packs. Recorded so that an
            # engine older than format 2 (which cannot read packs) is not pointed at this repository by mistake.
            meta["format"] = _packs.FORMAT
            meta["format_upgraded"] = iso()
            write_json(rj, meta)
        for d in ("backup", "locks"):
            os.makedirs(self.sp(d), mode=0o750, exist_ok=True)

    def check_writable(self):
        if not os.path.isdir(self.path):
            raise EngineError("PGA-REPO-001", "repository does not exist: %s" % self.path)
        if not os.access(self.path, os.W_OK):
            raise EngineError("PGA-REPO-003", "repository is not writable: %s" % self.path, "check ownership (must be writable by the agent user)")

    # ------------------------------------------------------------------ lock with fencing token
    def lock(self, name="stanza", owner=""):
        os.makedirs(self.sp("locks"), mode=0o750, exist_ok=True)
        lp = self.sp("locks", name + ".lock")
        f = open(lp, "a+")
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (IOError, OSError) as e:
            if e.errno not in (errno.EAGAIN, errno.EACCES):
                raise
            f.seek(0)
            info = f.read().strip()
            f.close()
            raise EngineError("PGA-LOCK-001", "another operation holds the %s lock on stanza '%s' (%s)" % (name, self.stanza, info or "unknown"),
                              "wait for it to finish; locks are released automatically if the process dies")
        tokfile = self.sp("locks", name + ".token")
        try:
            tok = int(read_file(tokfile).strip())
        except (IOError, OSError, ValueError):
            tok = 0
        tok += 1
        with open(tokfile, "w") as tf:
            tf.write(str(tok))
            tf.flush()
            os.fsync(tf.fileno())
        f.seek(0)
        f.truncate()
        f.write("host=%s pid=%d token=%d owner=%s since=%s\n" % (socket.gethostname(), os.getpid(), tok, owner, iso()))
        f.flush()
        return Lock(f, tok, lp)

    # ------------------------------------------------------------------ CAS
    def put_chunk(self, data):
        """Returns (hash, bytes_written, was_deduplicated)."""
        h = self.hash(data)
        hb = bytes.fromhex(h)
        r = self.index().find(hb, own_only=True)                   # never against a previous location (read-only, migrated or dropped later)
        if r is not None:                                          # in a sealed pack (durable and indexed: nothing to re-verify) or written by this process
            if self._own_open_pack(r[0]) or self._touch_pack(r[0]):
                return h, 0, True
            self.index().forget_pack(r[0])                         # the pack vanished under a garbage collection: store the chunk again
        if self.has_legacy_chunks():
            dst = self.cas_path(h)
            try:
                st = os.stat(dst)
                if self.suspect_since is None or st.st_mtime < self.suspect_since:
                    if time.time() - st.st_mtime > DEDUP_TOUCH_AFTER:
                        try:
                            os.utime(dst, None)
                        except OSError:
                            pass
                    return h, 0, True
                try:                                               # a format-1 file written around a crash: do not trust it blindly
                    if self.hash(decompress(self._unpack(read_file(dst, binary=True), h))) == h:
                        return h, 0, True
                except Exception:
                    pass
            except OSError:
                pass
        return h, self.put_blob(h, self._pack(compress(data, self.algo, self.level), h)), False

    def put_blob(self, h, blob):
        """Store an already packed blob (tag + compressed [+ encrypted]) under hash `h` in this process's pack. Returns the bytes written."""
        hb = bytes.fromhex(h)
        w = self._writer()
        off = w.append(hb, blob)
        self.index().add(hb, w.final, off, len(blob))
        if w.size >= _packs.PACK_MAX:
            w.seal()
            with self._index_lock:
                if w in self._writers:
                    self._writers.remove(w)
        return len(blob)

    def _writer(self):
        w = getattr(self._tl, "writer", None)
        if w is None or w.sealed or w.broken:
            w = _packs.PackWriter(self.path)
            self._tl.writer = w
            with self._index_lock:
                self._writers.append(w)
        return w

    def get_blob(self, h):
        """The stored blob of chunk `h` (tag + compressed [+ encrypted]), from a pack or a format-1 file; PGA-REPO-014 when absent."""
        r = self.locate(h)
        if r is None:
            raise EngineError("PGA-REPO-014", "chunk missing from repository: %s" % h, "run verify --deep; if the chunk is lost the sets referencing it are unrecoverable")
        path, off, ln = r
        try:
            if path.endswith(".pack"):
                return self._reader().read(path, off, ln)
            return read_file(path, binary=True)
        except (IOError, OSError) as e:
            if e.errno in (errno.ENOENT, errno.ESTALE):
                if e.errno == errno.ESTALE:                       # NFS: the pack was rewritten by a garbage collection on another host: drop the handles
                    self._reader().close()
                with self._index_lock:                             # a pack this process is still writing: read it through the writer's file
                    w = next((x for x in self._writers if x.final == path), None)
                if w is not None and not w.sealed:
                    w.f.flush()
                    with open(w.open_path, "rb") as f:
                        f.seek(off)
                        return f.read(ln)
                # else the pack was deleted or rewritten by a garbage collection since the index was loaded
                self.reload_index()
                r = self.locate(h)
                if r is not None:
                    path, off, ln = r
                    return self._reader().read(path, off, ln) if path.endswith(".pack") else read_file(path, binary=True)
                raise EngineError("PGA-REPO-014", "chunk missing from repository: %s" % h, "run verify --deep; if the chunk is lost the sets referencing it are unrecoverable")
            raise

    def _decode(self, blob, h):
        try:
            data = decompress(self._unpack(blob, h))
        except EngineError:
            raise
        except Exception as e:
            raise EngineError("PGA-VRF-001", "chunk %s is corrupt (%s)" % (h, e), "storage bit-rot: restore the repository from a copy")
        if self.hash(data) != h:
            raise EngineError("PGA-VRF-001", "chunk %s failed hash verification" % h, "storage bit-rot: restore the repository from a copy")
        return data

    def get_chunk(self, h):
        return self._decode(self.get_blob(h), h)

    def get_chunks(self, hashes):
        """{hash: data} for several chunks with as few reads as possible: chunks that sit next to each other in the same pack (a file backed
        up by one thread is stored in order) come with ONE read of the whole run instead of one per 64 KiB. Each chunk is verified as usual."""
        locs = [(h, self.locate(h)) for h in hashes]
        out = {}
        i = 0
        while i < len(locs):
            h, r = locs[i]
            if r is None or not r[0].endswith(".pack"):
                out[h] = self.get_chunk(h)
                i += 1
                continue
            path, off, ln = r
            end = off + ln
            j = i
            while j + 1 < len(locs):
                h2, r2 = locs[j + 1]
                if r2 is None or r2[0] != path or r2[1] != end + _packs.REC_HDR.size or r2[1] + r2[2] - off > READ_RUN_MAX:
                    break
                end = r2[1] + r2[2]
                j += 1
            if j == i:
                out[h] = self.get_chunk(h)
            else:
                try:
                    buf = self._reader().read(path, off, end - off)
                except (IOError, OSError):
                    buf = None                                         # pack gone or short: the per-chunk path reloads the index and says what is wrong
                for k in range(i, j + 1):
                    hk, (_, ok, lk) = locs[k]
                    out[hk] = self._decode(buf[ok - off:ok - off + lk], hk) if buf is not None else self.get_chunk(hk)
            i = j + 1
        return out

    # ------------------------------------------------------------------ sets
    def _sets_in(self, root):
        d = os.path.join(root, "stanza", self.stanza, "backup")
        out = []
        if not os.path.isdir(d):
            return out
        for s in sorted(os.listdir(d)):
            if s.startswith("."):
                continue                                        # work directories (an interrupted migration's .mig-<id>) are never sets
            mj = os.path.join(d, s, "meta.json")
            try:
                out.append(read_json(mj))
            except (IOError, OSError, ValueError):
                continue
        return out

    def claim_set_dir(self, set_id, owner=""):
        """Create the directory of a NEW set and make sure it is ours. True when claimed, False when another writer has it.
        mkdir alone cannot tell: on NFS a MKDIR whose reply was lost is retransmitted and answers EEXIST although it was ours (found on
        the lab: every second scheduled backup of a site on NFSv4 failed with 'File exists' on a directory it had just created, leaving
        an empty directory behind). An exclusive create of a marker inside is exactly-once on NFS (verifier) and on local filesystems,
        so the marker decides; a directory that already holds a set (meta.json) is never claimed."""
        d = self.own_path("backup", set_id)
        os.makedirs(os.path.dirname(d), mode=0o750, exist_ok=True)
        try:
            os.mkdir(d, 0o750)
        except FileExistsError:
            pass                                                   # ours (a retransmitted MKDIR) or someone else's: the marker decides
        try:
            fd = os.open(os.path.join(d, ".claim"), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
        except FileExistsError:
            return False
        try:
            os.write(fd, ("%s %d %s\n" % (owner or "backup", os.getpid(), socket.gethostname())).encode())
        finally:
            os.close(fd)
        if any(n not in (".claim",) for n in os.listdir(d)):     # an older set with this id (cannot happen with fresh ids, never overwrite one)
            try:
                os.unlink(os.path.join(d, ".claim"))
            except OSError:
                pass
            return False
        return True

    # ------------------------------------------------------------------ pins: what running restores read
    def pin(self, name, sets, wal_from_lsn, ttl=1800):
        """A running restore (extraction, a recovery instance, a restored copy still recovering) declares the sets it reads and the oldest WAL it
        may still fetch: retention keeps them while the pin is alive (independent review: an expire at night removed the base set and raised
        the WAL floor under a restore that had been running for hours). A pin that is not refreshed dies by itself after `ttl` seconds."""
        d = self.own_path("pins")
        os.makedirs(d, exist_ok=True)
        tmp = os.path.join(d, ".%s.tmp.%d" % (name, os.getpid()))
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"sets": list(sets), "wal_from": wal_from_lsn, "until": time.time() + ttl, "host": socket.gethostname(), "pid": os.getpid()}, f)
        os.rename(tmp, os.path.join(d, name + ".json"))

    def unpin(self, name):
        try:
            os.unlink(self.own_path("pins", name + ".json"))
        except OSError:
            pass

    def pins(self):
        """Live pins: [{sets, wal_from, until, ...}]; expired ones are removed."""
        out = []
        d = self.own_path("pins")
        for n in (os.listdir(d) if os.path.isdir(d) else []):
            if not n.endswith(".json") or n.startswith("."):
                continue
            try:
                with open(os.path.join(d, n), "r", encoding="utf-8") as f:
                    j = json.load(f)
            except (IOError, OSError, ValueError):
                continue
            if float(j.get("until") or 0) > time.time():
                out.append(j)
            else:
                try:
                    os.unlink(os.path.join(d, n))
                except OSError:
                    pass
        return out

    def pinned(self, sets, wal_from_lsn, ttl=1800, name=None):
        """Context manager: pin while the block runs, refreshed every ttl/3 by a thread."""
        repo = self
        name = name or "restore-%s" % uuid.uuid4().hex[:12]

        class _P(object):
            def __enter__(self_):
                self_.stop = threading.Event()
                try:
                    repo.pin(name, sets, wal_from_lsn, ttl)
                except OSError:
                    return self_                           # a read-only repository (a restore from a mounted copy): nothing to protect it from

                def keep():
                    while not self_.stop.wait(ttl / 3.0):
                        try:
                            repo.pin(name, sets, wal_from_lsn, ttl)
                        except OSError:
                            pass
                self_.t = threading.Thread(target=keep, daemon=True)
                self_.t.start()
                return self_

            def __exit__(self_, *exc):
                self_.stop.set()
                repo.unpin(name)
                return False
        return _P()

    RETIRED = "retired.json"
    RETIRED_MAX = 20000

    def retire(self, sets=(), packs=()):
        """Journal of what retention and garbage collection removed ON PURPOSE (set ids per stanza, pack names). Read by the offsite
        rehydrate so that 'download what is missing' does not bring back what was deleted deliberately. Kept inside the repository and never
        mirrored: when the storage itself is lost the journal goes with it and everything is downloaded again, as it should be."""
        sets, packs = list(sets), list(packs)
        if not sets and not packs:
            return
        p = os.path.join(self.path, self.RETIRED)
        try:
            with open(p, "r", encoding="utf-8") as f:
                j = json.load(f)
        except (IOError, OSError, ValueError):
            j = {}
        ss = j.setdefault("sets", {}).setdefault(self.stanza, [])
        ss.extend(x for x in sets if x not in ss)
        j["sets"][self.stanza] = ss[-self.RETIRED_MAX:]
        pk = j.setdefault("packs", [])
        pk.extend(x for x in packs if x not in pk)
        j["packs"] = pk[-self.RETIRED_MAX:]
        tmp = p + ".tmp.%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(j, f)
        os.rename(tmp, p)

    def stale_set_dirs(self, older_than=86400):
        """Set directories without meta.json older than `older_than` seconds: a start that failed before writing its meta (or an empty
        claim). Not sets, never listed; removed by expire."""
        d = os.path.join(self.path, "stanza", self.stanza, "backup")
        out = []
        if not os.path.isdir(d):
            return out
        now = time.time()
        for n in os.listdir(d):
            p = os.path.join(d, n)
            if n.startswith(".") or not os.path.isdir(p) or os.path.exists(os.path.join(p, "meta.json")):
                continue
            try:
                if now - os.stat(p).st_mtime > older_than and all(x in (".claim",) or x.endswith(".tmp") for x in os.listdir(p)):
                    out.append(n)
            except OSError:
                continue
        return out

    def own_sets(self):
        """Sets of THIS location only: what backups (parent choice, crash cleanup) and retention work on."""
        out = self._sets_in(self.path)
        out.sort(key=lambda m: m.get("start_time", ""))
        return out

    def sets(self):
        """Every set, including those still in a previous location (marked `location`): what listings and restores see."""
        out = self._sets_in(self.path)
        seen = {m.get("id") for m in out}
        for root in self.previous:
            for m in self._sets_in(root):
                if m.get("id") not in seen:                       # migrated already: the copy here wins
                    m["location"] = root
                    out.append(m)
                    seen.add(m.get("id"))
        out.sort(key=lambda m: m.get("start_time", ""))
        return out

    def complete_sets(self):
        return [s for s in self.sets() if s.get("status") == "COMPLETE"]

    def own_complete_sets(self):
        return [s for s in self.own_sets() if s.get("status") == "COMPLETE"]

    def set_meta(self, set_id):
        try:
            return read_json(self.sp("backup", set_id, "meta.json"))
        except (IOError, OSError, ValueError):
            return None

    def write_meta(self, meta):
        write_json(self.own_path("backup", meta["id"], "meta.json"), meta)      # never into a previous location

    def own_path(self, *a):
        """A path in THIS location only (writes, deletions): never resolved to a previous location."""
        return os.path.join(self.path, "stanza", self.stanza, *a)

    def load_manifest(self, s):
        return self.read_zjson(self.sp("backup", s["id"], "manifest.json.z"), s["id"] + "/manifest")

    def load_catalog(self, s):
        return self.read_zjson(self.sp("backup", s["id"], "catalog.json.z"), s["id"] + "/catalog")

    def resolve_set(self, spec=None):
        sets = self.complete_sets()
        if not sets:
            raise EngineError("PGA-REPO-020", "no complete backup in stanza '%s'" % self.stanza, "run a full backup first")
        if spec in (None, "", "latest"):
            return sets[-1]
        for s in sets:
            if s["id"] == spec:
                return s
        raise EngineError("PGA-REPO-021", "backup set not found or not complete: %s" % spec)

    def sync(self):
        """Flush the repository's filesystem only (syncfs), and report its write-back errors: os.sync() flushed every filesystem of the database
        host, the data volume included, in the middle of production, and said nothing when the flush failed (independent engine review)."""
        try:
            import ctypes
            import ctypes.util
            libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
            fn = libc.syncfs
        except (OSError, AttributeError, ImportError):
            fn = None
        if fn is None:
            os.sync()                                         # no syncfs (not Linux): the global one
            return
        fd = os.open(self.path, os.O_RDONLY)
        try:
            if fn(fd) != 0:
                e = ctypes.get_errno()
                raise OSError(e, "syncfs of the backup repository failed: %s" % os.strerror(e))
        finally:
            os.close(fd)
