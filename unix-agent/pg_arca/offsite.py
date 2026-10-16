"""Offsite copy of the repository and the WAL archive on S3-compatible object storage (AWS S3, MinIO, Ceph RGW, ...).

What it is: a MIRROR, kept by the agent in the background, of what the local repository and WAL archive hold - pack files, backup sets
(meta, manifest, catalog, label), repository/stanza descriptors, archived WAL segments with their .meta - so that a site that loses its
backup storage can get everything back (`rehydrate`) and so that the copy auditors ask for ("a copy outside the building") exists without
touching the hot path: backups and WAL archiving keep writing locally at local speed; the uploader follows.

Rules that keep the copy restorable at every moment: packs go up before the sets that reference them; sets come down before the packs
they reference; nothing is deleted remotely while the local side looks empty (an unmounted share must not wipe the offsite copy);
every object is checked by size (and uploaded again when it differs). The cycle is idempotent and resumable: a crash between two uploads
costs nothing but the upload.

Layout in the bucket, under the configured prefix:  repo/<path as in the repository>   and   wal/<segment files>
"""

import json
import os
import threading
import time

from pg_arca.s3 import S3Client, S3Error

INTERVAL_SEC = 60
FULL_LIST_EVERY = 10 * 60                  # a quiet repository is listed in the bucket at most this often
KEEP_DELETE_GRACE = 6 * 3600               # a remote object with no local counterpart is deleted only after this (local removal must be older than a cycle)
SET_FILES = ("meta.json", "manifest.json.z", "catalog.json.z", "backup_label")


def validate(cfg):
    """Cleaned offsite configuration (a dict) or OverrideError-like ValueError. None/empty = off."""
    if not cfg:
        return None
    if not isinstance(cfg, dict):
        raise ValueError("an object is required")
    out = {"type": "s3"}
    if (cfg.get("type") or "s3") != "s3":
        raise ValueError("only type 's3' is supported")
    ep = str(cfg.get("endpoint") or "").strip().rstrip("/")
    if not ep.startswith(("http://", "https://")) or "@" in ep or " " in ep:
        raise ValueError("endpoint: an http(s):// URL without credentials, e.g. https://s3.eu-central-1.amazonaws.com or https://minio.corp:9000")
    out["endpoint"] = ep
    b = str(cfg.get("bucket") or "").strip()
    if not b or len(b) > 63 or not all(c.isalnum() or c in ".-" for c in b):
        raise ValueError("bucket: 1-63 characters, letters, digits, '.' and '-'")
    out["bucket"] = b
    out["prefix"] = str(cfg.get("prefix") or "").strip().strip("/")
    out["region"] = str(cfg.get("region") or "us-east-1").strip()
    out["access_key"] = str(cfg.get("access_key") or "").strip()
    out["secret_key"] = str(cfg.get("secret_key") or "")
    if not out["access_key"] or not out["secret_key"]:
        raise ValueError("access key and secret key are required")
    out["path_style"] = bool(cfg.get("path_style", True))
    out["tls_verify"] = bool(cfg.get("tls_verify", True))
    ca = str(cfg.get("ca_file") or "").strip()
    if ca and not os.path.isfile(ca):
        raise ValueError("ca_file does not exist: %s" % ca)
    out["ca_file"] = ca or None
    out["enabled"] = bool(cfg.get("enabled", True))
    return out


def client_for(cfg):
    return S3Client(cfg["endpoint"], cfg["bucket"], cfg["access_key"], cfg["secret_key"], region=cfg.get("region") or "us-east-1", prefix=cfg.get("prefix") or "",
                    path_style=cfg.get("path_style", True), tls_verify=cfg.get("tls_verify", True), ca_file=cfg.get("ca_file"))


def _local_repo_files(repo_path):
    """{relative path: size} of what the repository must have offsite: sealed packs + indexes, descriptors, COMPLETE sets."""
    out = {}
    rj = os.path.join(repo_path, "repo.json")
    if not os.path.isfile(rj):
        return out
    out["repo.json"] = os.path.getsize(rj)
    # sets FIRST, packs after: a backup that seals its packs and becomes COMPLETE between the two listings is then seen with all its packs
    # (listed the other way round, a set could go offsite without its pack while the cycle said ok - independent offsite review)
    sroot = os.path.join(repo_path, "stanza")
    if os.path.isdir(sroot):
        for st in os.listdir(sroot):
            sj = os.path.join(sroot, st, "stanza.json")
            if os.path.isfile(sj):
                out["stanza/%s/stanza.json" % st] = os.path.getsize(sj)
            bd = os.path.join(sroot, st, "backup")
            if not os.path.isdir(bd):
                continue
            for sid in os.listdir(bd):
                mp = os.path.join(bd, sid, "meta.json")
                try:
                    with open(mp, "r", encoding="utf-8") as f:
                        if json.load(f).get("status") != "COMPLETE":
                            continue
                except (IOError, OSError, ValueError):
                    continue
                for fn in SET_FILES:
                    p = os.path.join(bd, sid, fn)
                    if os.path.isfile(p):
                        out["stanza/%s/backup/%s/%s" % (st, sid, fn)] = os.path.getsize(p)
    pd = os.path.join(repo_path, "cas", "packs")
    if os.path.isdir(pd):
        for n in os.listdir(pd):
            if n.endswith(".pack") and os.path.exists(os.path.join(pd, n[:-5] + ".idx")):
                for f in (n, n[:-5] + ".idx"):
                    try:
                        out["cas/packs/" + f] = os.path.getsize(os.path.join(pd, f))
                    except OSError:
                        pass
    # a repository upgraded from format 1 keeps its per-file chunks (cas/aa/bb/<hash>) and new sets deduplicate against them: they are part of
    # what a restore needs (independent review: mirrored only as packs, every such set failed with PGA-REPO-014 after a rehydrate)
    cas = os.path.join(repo_path, "cas")
    if os.path.isdir(cas):
        for a in os.listdir(cas):
            if len(a) != 2 or not os.path.isdir(os.path.join(cas, a)):
                continue
            for dp, _dn, fns in os.walk(os.path.join(cas, a)):
                for f in fns:
                    if f.startswith(".") or f.endswith(".tmp") or ".tmp." in f:
                        continue
                    fp = os.path.join(dp, f)
                    try:
                        out[os.path.relpath(fp, repo_path).replace(os.sep, "/")] = os.path.getsize(fp)
                    except OSError:
                        pass
    return out


def _local_wal_files(wal_dir):
    """{file name: size} of the archive: segments, .meta, .history, the retention floor and the database-name registry (a restore from the
    offsite copy alone needs it to recognise a database dropped after the last backup); not the quarantine, not temporary files."""
    out = {}
    if not wal_dir or not os.path.isdir(wal_dir):
        return out
    for n in os.listdir(wal_dir):
        if n.startswith(".") and n not in (".retention_floor.json", ".pgarca-database-names"):
            continue
        if n.endswith((".tmp", ".part")) or ".tmp." in n or ".mig." in n or ".arca." in n or n == "conflicts":
            continue
        p = os.path.join(wal_dir, n)
        if os.path.isfile(p):
            try:
                out[n] = os.path.getsize(p)
            except OSError:
                pass
    return out


def _sig(local):
    import hashlib
    return hashlib.sha1(repr(sorted(local.items())).encode("utf-8")).hexdigest()


def _order(key):
    """Upload order: packs and descriptors first, then set files (meta.json last of all), then WAL. Deletion uses the reverse."""
    if key.startswith("repo/cas/"):                 # packs + indexes, and format-1 chunk files
        return 0
    if key in ("repo/repo.json",) or key.endswith("/stanza.json"):
        return 1
    if key.startswith("repo/stanza/"):
        return 3 if key.endswith("/meta.json") else 2
    return 4


def immutable(key):
    """Objects written once and never changed: packs, indexes, chunk files, a set's manifest/catalog/label, WAL segments and history files.
    A local copy of another size is damage (truncated download, fsck) - never uploaded over the good remote copy."""
    if key.startswith("repo/cas/"):
        return True
    parts = key.split("/")
    if len(parts) == 6 and parts[0] == "repo" and parts[1] == "stanza" and parts[3] == "backup":
        return parts[5] != "meta.json"
    if key.startswith("wal/"):
        n = key[4:]
        return not n.startswith(".") and n not in ("ARCHIVE_OWNER.json", "ARCHIVE_KEY.json")
    return False


def plan(local, remote):
    """local/remote: {key: size}. Returns (to_upload, to_delete) in a safe order. An immutable object already in the bucket with another size
    is not uploaded (see conflicts())."""
    up = sorted((k for k, sz in local.items() if remote.get(k) != sz and not (k in remote and immutable(k))), key=lambda k: (_order(k), k))
    down = sorted((k for k in remote if k not in local), key=lambda k: (-_order(k), k))
    return up, down


class Mirror(object):
    """One sync cycle = list remote once, upload what is missing or different, delete what is gone locally (after the grace)."""

    def __init__(self, config, state_dir, log=None):
        self.config = config
        self.state_dir = state_dir
        self.log = log or (lambda lv, m: None)
        self.status_path = os.path.join(state_dir, "offsite", "status.json")
        self.gone_path = os.path.join(state_dir, "offsite", "gone.json")     # remote key -> first time it was seen without a local file

    def cfg(self):
        try:
            return validate(self.config.get("offsite"))
        except ValueError:
            return None

    def status(self):
        try:
            with open(self.status_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (IOError, OSError, ValueError):
            return None

    def _write(self, path, obj):
        d = os.path.dirname(path)
        os.makedirs(d, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f)
        os.rename(tmp, path)

    def dir_signature(self):
        """mtimes of the directories whose content the mirror follows: unchanged = the local inventory of last time is still right (no
        thousands of stat calls per minute on a share for a quiet archive)."""
        out = []
        repo, wal = self.config.get("repo_path"), self.config.get("wal_archive_dir")
        for d in [wal, os.path.join(repo or "", "cas", "packs"), os.path.join(repo or "", "stanza")]:
            try:
                out.append(os.stat(d).st_mtime)
            except OSError:
                out.append(None)
        sroot = os.path.join(repo or "", "stanza")
        try:
            for st in sorted(os.listdir(sroot)):
                bd = os.path.join(sroot, st, "backup")
                try:
                    out.append(os.stat(bd).st_mtime)
                    for sid in sorted(os.listdir(bd)):
                        try:
                            out.append(os.stat(os.path.join(bd, sid)).st_mtime)
                        except OSError:
                            out.append(None)
                except OSError:
                    out.append(None)
        except OSError:
            pass
        return tuple(out)

    def local_inventory(self):
        repo, wal = self.config.get("repo_path"), self.config.get("wal_archive_dir")
        local = {}
        for k, sz in _local_repo_files(repo).items():
            local["repo/" + k] = sz
        for k, sz in _local_wal_files(wal).items():
            local["wal/" + k] = sz
        return local

    def sync(self, cancel=None, progress=None, dry_run=False, force=False):
        cfg = self.cfg()
        if not cfg or not cfg.get("enabled", True):
            return {"enabled": False}
        t0 = time.time()
        st = {"enabled": True, "started": t0, "endpoint": cfg["endpoint"], "bucket": cfg["bucket"], "prefix": cfg.get("prefix") or ""}
        lock = self._lock(block=False)
        if lock is None:                                         # a rehydrate is writing the repository: no mirror cycle meanwhile
            return dict(self.status() or {}, skipped=True, busy="rehydrate")
        try:
            return self._sync(cfg, st, t0, cancel, progress, dry_run, force)
        finally:
            self._unlock(lock)

    def _sync(self, cfg, st, t0, cancel, progress, dry_run, force):
        dsig = None
        try:
            prev = self.status() or {}
            dsig = self.dir_signature()
            if not force and not dry_run and prev.get("ok") and getattr(self, "_last_dsig", None) == dsig and time.time() - (prev.get("finished") or 0) < FULL_LIST_EVERY:
                return dict(prev, skipped=True)                 # directories untouched since the last clean cycle: not even a local walk
            local = self.local_inventory()
            # nothing changed locally since the last clean cycle and the bucket was listed recently: no request at all (a quiet cluster must not
            # cost thousands of LIST calls a day); a change, an error or FULL_LIST_EVERY elapsed -> the real cycle
            sig = _sig(local)
            if not force and not dry_run and prev.get("ok") and prev.get("local_sig") == sig and time.time() - (prev.get("finished") or 0) < FULL_LIST_EVERY:
                self._last_dsig = dsig
                return dict(prev, skipped=True)
            c = client_for(cfg)
            remote = c.list("")
            self._check_bucket_owner(c, remote)
            up, down = plan(local, remote)
            conflicts = [k for k in local if k in remote and remote[k] != local[k] and immutable(k)]
            if conflicts:
                st["conflicts"] = len(conflicts)
                st["conflicts_sample"] = conflicts[:5]
                self.log("warn", "offsite: %d object(s) differ from the bucket's copy and are never uploaded over it (local damage?), e.g. %s" % (len(conflicts), conflicts[0]))
            # deletions: only what has been gone locally for a while, and never when the local side looks empty (share not mounted?)
            try:
                with open(self.gone_path, "r", encoding="utf-8") as f:
                    gone = json.load(f)
            except (IOError, OSError, ValueError):
                gone = {}
            now = time.time()
            gone = dict((k, v) for k, v in gone.items() if k in down)
            for k in down:
                gone.setdefault(k, now)
            local_empty = not any(k.startswith("repo/") for k in local) or (self.config.get("wal_archive_dir") and not any(k.startswith("wal/") for k in local))
            # the bucket only forgets what THIS node removed on purpose (retention, garbage collection, the WAL floor - the same journal the
            # rehydrate reads). Anything else missing here is kept offsite: a lost or remounted share, an archive recreated empty by the next
            # archive_command, a previous location after a destination change (independent review: 'local not empty' was the only guard, and
            # 6 hours after losing the storage the copy that exists for that disaster was deleted)
            on_purpose = self.retained_on_purpose()
            deletable = [] if local_empty else [k for k in down if now - gone[k] >= KEEP_DELETE_GRACE and on_purpose(k)]
            only_remote = [k for k in down if not on_purpose(k)]
            st.update(to_upload=len(up), bytes_to_upload=sum(local[k] for k in up), to_delete=len(deletable), waiting_delete=len(down) - len(deletable) - len(only_remote),
                      only_offsite=len(only_remote), only_offsite_sample=only_remote[:5], local_empty=local_empty, remote_objects=len(remote))
            if dry_run:
                st["dry_run"] = True
                return st
            if not dry_run:
                self._write(self.gone_path, gone)
            done_b = 0
            uploaded = deleted = failed = 0
            first_err = None
            pack_failed = False
            for i, k in enumerate(up):
                if cancel and cancel():
                    raise S3Error(0, "Cancelled", "cancelled")
                if pack_failed and k.startswith("repo/stanza/") and "/backup/" in k:
                    continue                                   # never a set offsite whose chunks are not all there (a failed pack): next cycle
                path = self._local_path(k)
                try:
                    c.put(k, path)
                except (IOError, OSError) as e:
                    self.log("warn", "offsite: %s vanished while uploading (%s)" % (k, e))
                    continue
                except S3Error as e:                                   # one object failing must not stop the others; the next cycle retries it
                    failed += 1
                    first_err = first_err or str(e)
                    pack_failed = pack_failed or k.startswith("repo/cas/")
                    if e.status in (401, 403) or failed >= 20:
                        raise
                    continue
                uploaded += 1
                done_b += local[k]
                if progress and (i % 20 == 0 or i == len(up) - 1):
                    progress({"phase": "offsite", "uploaded": uploaded, "to_upload": len(up), "bytes": done_b, "bytes_total": st["bytes_to_upload"]})
            for k in (deletable if not failed else []):        # a cycle with failed uploads deletes nothing (a repacked pack's old copy stays)
                c.delete(k)
                deleted += 1
                gone.pop(k, None)
            self._write(self.gone_path, gone)
            st["local_sig"] = sig                       # what was inventoried BEFORE the upload: a change during the cycle is seen by the next one
            st.update(ok=failed == 0, uploaded=uploaded, uploaded_bytes=done_b, deleted=deleted, failed=failed, seconds=round(time.time() - t0, 1), finished=time.time(),
                      last_error=("%d upload(s) failed, first: %s" % (failed, first_err)) if failed else None)
            if uploaded or deleted or failed:
                self.log("warn" if failed else "info", "offsite: %d objects uploaded (%d MB), %d deleted%s in %.0fs" % (uploaded, done_b // 1048576, deleted, (", %d FAILED" % failed) if failed else "", time.time() - t0))
        except S3Error as e:
            st.update(ok=False, last_error=str(e), finished=time.time(), seconds=round(time.time() - t0, 1))
            self.log("warn", "offsite sync failed: %s" % e)
        except (IOError, OSError) as e:
            st.update(ok=False, last_error="local storage: %s" % e, finished=time.time())
            self.log("warn", "offsite sync skipped: %s" % e)
        except Exception as e:                                  # whatever happens, the status says it (it used to keep the previous "ok")
            st.update(ok=False, last_error="%s: %s" % (type(e).__name__, e), finished=time.time())
            self.log("warn", "offsite sync failed: %s" % e)
        prev = self.status() or {}
        if st.get("ok"):
            st["last_ok"] = st["finished"]
            self._last_dsig = dsig
        else:
            st["last_ok"] = prev.get("last_ok")
        self._write(self.status_path, st)
        return st

    def _lock(self, block):
        """The mirror and a rehydrate never run at the same time: a half-downloaded repository is not mirrored (independent review: the
        mirror uploaded a truncated pack over the good copy while a rehydrate ran)."""
        import fcntl
        d = os.path.join(self.state_dir, "offsite")
        os.makedirs(d, exist_ok=True)
        f = open(os.path.join(d, ".lock"), "a")
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | (0 if block else fcntl.LOCK_NB))
            return f
        except OSError:
            f.close()
            return None

    @staticmethod
    def _unlock(f):
        try:
            f.close()
        except Exception:
            pass

    def _check_bucket_owner(self, c, remote):
        """One database per bucket prefix: two clusters sharing it overwrote each other's wal/<segment> and deleted each other's WAL below their
        own floors. The archive's owner file in the bucket must be this archive's."""
        if "wal/ARCHIVE_OWNER.json" not in remote:
            return
        try:
            with open(os.path.join(self.config.get("wal_archive_dir") or "", "ARCHIVE_OWNER.json"), "r", encoding="utf-8") as f:
                mine = str(json.load(f).get("system_identifier") or "")
        except (IOError, OSError, ValueError):
            return
        try:
            theirs = str(json.loads(c.get("wal/ARCHIVE_OWNER.json").decode("utf-8")).get("system_identifier") or "")
        except (S3Error, ValueError, AttributeError):
            return
        if mine and theirs and mine != theirs:
            raise S3Error(0, "PrefixInUse", "the bucket prefix holds the WAL of another database (system identifier %s; this one is %s): "
                          "give each cluster its own prefix" % (theirs, mine))

    def _local_path(self, key):
        """Where an object key lands locally, or None when the key must not be written: the bucket is not trusted (anyone with its keys, or a
        tampered endpoint, chooses the object names), so only `repo/...` and `wal/...` with a plain relative remainder are accepted, and
        the resolved path must stay inside the repository / archive directory (no `..`, no absolute part, no symlinked escape)."""
        if key.startswith("repo/"):
            base, rel = self.config["repo_path"], key[5:]
        elif key.startswith("wal/"):
            base, rel = self.config["wal_archive_dir"], key[4:]
        else:
            return None
        if not rel or rel.startswith("/") or "\x00" in rel or any(p in ("..", "", ".") for p in rel.split("/")):
            return None
        path = os.path.join(base, rel)
        root = os.path.realpath(base)
        if os.path.realpath(os.path.dirname(path)) != root and not os.path.realpath(os.path.dirname(path)).startswith(root + os.sep):
            return None
        return path

    def retained_on_purpose(self):
        """What this node removed ON PURPOSE and the bucket still keeps for its grace period: WAL below the archive's retention floor,
        sets expired by retention, packs dropped by garbage collection. A predicate on object keys. Read from the LOCAL repository and
        archive only: when they are lost, so is this knowledge, and everything counts as missing."""
        floor, seg = 0, int(self.config.get("wal_segment_size") or 16 * 1024 * 1024)
        wal = self.config.get("wal_archive_dir")
        try:
            with open(os.path.join(wal, ".retention_floor.json"), "r", encoding="utf-8") as f:
                fj = json.load(f)
            floor, seg = int(fj.get("segno") or 0), int(fj.get("seg_size") or seg)
        except (IOError, OSError, ValueError, TypeError):
            pass
        sets, packs = {}, set()
        try:
            with open(os.path.join(self.config.get("repo_path") or "", "retired.json"), "r", encoding="utf-8") as f:
                rj = json.load(f)
            sets = dict((st, set(ids)) for st, ids in (rj.get("sets") or {}).items())
            packs = set(rj.get("packs") or [])
        except (IOError, OSError, ValueError, TypeError, AttributeError):
            pass
        per_id = 0x100000000 // seg if seg else 0

        def retained(k):
            if k.startswith("wal/") and floor and per_id:
                n = k[4:]
                if len(n) >= 24 and all(ch in "0123456789ABCDEF" for ch in n[:24]) and not n.endswith(".history"):
                    return int(n[8:16], 16) * per_id + int(n[16:24], 16) < floor
                return False
            parts = k.split("/")
            if len(parts) >= 5 and parts[0] == "repo" and parts[1] == "stanza" and parts[3] == "backup":
                return parts[4] in sets.get(parts[2], ())
            if len(parts) == 4 and parts[:3] == ["repo", "cas", "packs"]:
                return parts[3].rsplit(".", 1)[0] in packs
            return False
        return retained

    def rehydrate(self, what="all", progress=None, cancel=None, include_retained=False):
        """Download from the offsite copy what the local repository / archive lacks (what: all | repo | wal). Local files are never overwritten:
        a differing local file is reported, not replaced. What this node removed on purpose (retention, garbage collection) and the bucket
        still keeps for its grace period is not brought back unless include_retained (found on the lab: 8 GB of WAL that retention had just
        removed came back with a 'download what is missing')."""
        cfg = self.cfg()
        if not cfg:
            raise S3Error(0, "NotConfigured", "no offsite copy is configured on this node")
        lock = self._lock(block=True)
        try:
            return self._rehydrate(cfg, what, progress, cancel, include_retained)
        finally:
            self._unlock(lock)

    def _rehydrate(self, cfg, what, progress, cancel, include_retained):
        c = client_for(cfg)
        remote = c.list("")
        local = self.local_inventory()
        retained = (lambda k: False) if include_retained else self.retained_on_purpose()
        missing = [k for k in remote if k not in local and (what == "all" or k.startswith(what + "/"))]
        skipped = [k for k in missing if retained(k)]

        def order(k):
            # the archive's identity files first, then the WAL (archive_command refuses a known archive found empty: hours of rehydrate
            # would fill pg_wal on a running primary), then the repository in its safe order
            if k.startswith("wal/"):
                return (0, k) if k[4:] in ("ARCHIVE_OWNER.json", "ARCHIVE_KEY.json", ".retention_floor.json", ".pgarca-database-names") else (1, k)
            return (2 + _order(k), k)
        keys = sorted((k for k in missing if not retained(k)), key=order)
        differ = [k for k in remote if k in local and local[k] != remote[k]]
        total = sum(remote[k] for k in keys)
        done = 0
        got = 0
        refused = []
        failed = []
        for i, k in enumerate(keys):
            if cancel and cancel():
                raise S3Error(0, "Cancelled", "cancelled")
            path = self._local_path(k)
            if path is None or os.path.lexists(path):              # unsafe name, or something is already there: never write over it
                refused.append(k)
                done += remote[k]
                continue
            os.makedirs(os.path.dirname(path), mode=0o750, exist_ok=True)
            try:
                c.get_to_file(k, path, expect_size=remote[k])        # size checked: a connection cut early never leaves a short file in place
            except S3Error as e:
                if e.status in (401, 403):
                    raise
                failed.append("%s (%s)" % (k, e))
                continue
            got += 1
            done += remote[k]
            if progress and (i % 10 == 0 or i == len(keys) - 1):
                progress({"phase": "rehydrate", "downloaded": got, "to_download": len(keys), "bytes": done, "bytes_total": total})
        if refused:
            self.log("warn", "offsite rehydrate: %d object(s) refused (name outside the repository/archive or a local file in the way), e.g. %s" % (len(refused), refused[0]))
        if failed:
            self.log("warn", "offsite rehydrate: %d object(s) could not be downloaded completely, e.g. %s: run it again" % (len(failed), failed[0]))
        return {"downloaded": got, "failed": failed[:20], "failed_count": len(failed), "bytes": done, "already_local": len(remote) - len(missing) - len(differ), "differ": differ[:20], "differ_count": len(differ),
                "refused": refused[:20], "refused_count": len(refused), "retained_skipped": len(skipped), "retained_bytes": sum(remote[k] for k in skipped)}

    # ---- background thread
    def start(self, interval=INTERVAL_SEC):
        self._stop = threading.Event()

        def loop():
            time.sleep(15)                                     # let the agent settle first
            while not self._stop.is_set():
                try:
                    if self.cfg():
                        self.sync()
                except Exception as e:                         # never let the mirror thread die
                    self.log("warn", "offsite mirror: %s" % e)
                self._stop.wait(interval)
        t = threading.Thread(target=loop, name="offsite-mirror", daemon=True)
        t.start()
        return t

    def stop(self):
        if getattr(self, "_stop", None):
            self._stop.set()
