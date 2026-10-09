"""Repository: content-addressed chunk store + backup sets + stanza lock. WAL lives in the shared WAL archive.

  <repo>/repo.json
  <repo>/cas/<aa>/<bb>/<blake2b-256>            1 tag byte + compressed chunk, immutable, verified on every read
  <repo>/stanza/<name>/stanza.json
  <repo>/stanza/<name>/backup/<set>/{meta.json, manifest.json.z, catalog.json.z, backup_label}
  <repo>/stanza/<name>/locks/
Durability: chunks are written tmp+rename WITHOUT per-chunk fsync (speed); a backup set is committed
only after one global sync(), and chunks written by a crashed run are re-verified before being reused.
"""

import errno
import fcntl
import os
import socket
import time
import uuid

from pg_arca.engine import ENGINE_VERSION
from pg_arca.engine.util import (CHUNK_SIZE, HASH_NAME, EngineError, chunk_hash, compress, decompress, fsync_dir, iso, read_json,
                                 write_file_atomic, write_json)

DEDUP_TOUCH_AFTER = 3600          # refresh mtime of a reused chunk at most once per hour (GC grace relies on it)
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
    def __init__(self, path, stanza, wal=None, algo=None, level=3, crypto=None):
        self.path = os.path.realpath(path)
        self.stanza = stanza
        self.wal = wal                       # WalManager
        self.algo = algo
        self.level = level
        self.crypto = crypto                 # engine.crypt.Crypto or None
        self.suspect_since = None            # chunks newer than this are re-verified before dedup (crashed run before us)

    def p(self, *a):
        return os.path.join(self.path, *a)

    def sp(self, *a):
        return os.path.join(self.path, "stanza", self.stanza, *a)

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
        return self.p("cas", h[0:2], h[2:4], h)

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
            meta = {"format": 1, "created": iso(), "chunk_size": CHUNK_SIZE, "hash": HASH_NAME, "engine": ENGINE_VERSION}
            if self.crypto:
                meta["encryption"] = {"alg": "aes-256-gcm", "key_id": self.crypto.key_id, "hash": "keyed-blake2b-256"}
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
            tok = int(open(tokfile).read().strip())
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
            try:                                                   # written around a crash: do not trust it blindly
                if self.hash(decompress(self._unpack(open(dst, "rb").read(), h))) == h:
                    return h, 0, True
            except Exception:
                pass
        except OSError:
            pass
        os.makedirs(os.path.dirname(dst), mode=0o750, exist_ok=True)
        blob = self._pack(compress(data, self.algo, self.level), h)
        tmp = "%s.tmp.%s" % (dst, uuid.uuid4().hex[:8])
        with open(tmp, "wb") as f:
            f.write(blob)
        os.rename(tmp, dst)
        return h, len(blob), False

    def get_chunk(self, h):
        try:
            with open(self.cas_path(h), "rb") as f:
                blob = f.read()
        except (IOError, OSError):
            raise EngineError("PGA-REPO-014", "chunk missing from repository: %s" % h, "run verify --deep; if the chunk is lost the sets referencing it are unrecoverable")
        try:
            data = decompress(self._unpack(blob, h))
        except EngineError:
            raise
        except Exception as e:
            raise EngineError("PGA-VRF-001", "chunk %s is corrupt (%s)" % (h, e), "storage bit-rot: restore the repository from a copy")
        if self.hash(data) != h:
            raise EngineError("PGA-VRF-001", "chunk %s failed hash verification" % h, "storage bit-rot: restore the repository from a copy")
        return data

    # ------------------------------------------------------------------ sets
    def sets(self):
        d = self.sp("backup")
        out = []
        if not os.path.isdir(d):
            return out
        for s in sorted(os.listdir(d)):
            mj = os.path.join(d, s, "meta.json")
            try:
                out.append(read_json(mj))
            except (IOError, OSError, ValueError):
                continue
        out.sort(key=lambda m: m.get("start_time", ""))
        return out

    def complete_sets(self):
        return [s for s in self.sets() if s.get("status") == "COMPLETE"]

    def set_meta(self, set_id):
        try:
            return read_json(self.sp("backup", set_id, "meta.json"))
        except (IOError, OSError, ValueError):
            return None

    def write_meta(self, meta):
        write_json(self.sp("backup", meta["id"], "meta.json"), meta)

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
        os.sync()
