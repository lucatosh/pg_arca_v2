"""Move the content of a PREVIOUS backup location (repository + WAL archive left behind by a destination change) into the current one, in the background.

  plan(ctx)  what would move: sets and WAL of THIS stanza only (a repository root can hold several clusters), bytes and files, free space and inodes on
             the destination, an estimated duration from a measured write speed. Nothing is written.
  run(ctx)   copies, resumable at any point (an agent restart or a cancel just leaves less to do), with a bandwidth limit:
             - chunks of each set first, then the set's own files (manifest, catalog, meta, backup_label) into a temporary directory renamed at the end:
               a set appears in the new location only when everything it needs is there;
             - every file is written to a temporary name, fsynced, renamed, then READ BACK and compared with the source (sha256);
             - chunks get a fresh mtime: the garbage collector's grace period protects them until their set is in place;
             - WAL: .meta before the segment (the archive's own order), segments, timeline history, backup labels.
             When everything is there, the previous location is no longer needed for restores: the caller drops it from repo_previous / wal_previous.
             The source is NEVER deleted here (a separate, confirmed action).

Encrypted repositories: files are copied as they are (encrypted), the key never moves.
"""
import hashlib
import json
import os
import shutil
import time
import uuid

from pg_arca.engine.util import EngineError, read_json, write_json

STATE = ".migration.json"
WAL_SKIP_PREFIX = (".", "conflicts")


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _fsync_dir(d):
    try:
        fd = os.open(d, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass


class Throttle(object):
    def __init__(self, mb_s):
        self.rate = float(mb_s or 0) * 1024 * 1024
        self.t0 = time.time()
        self.n = 0

    def take(self, nbytes):
        self.n += nbytes
        if self.rate <= 0:
            return
        ahead = self.n / self.rate - (time.time() - self.t0)
        if ahead > 0:
            time.sleep(min(ahead, 5.0))


def _copy_verified(src, dst, throttle=None, fresh_mtime=True):
    """src -> dst via tmp + fsync + rename, then read back and compare. Returns bytes copied (0 when dst already holds the same content)."""
    with open(src, "rb") as f:
        data = f.read()
    want = _sha(data)
    try:
        with open(dst, "rb") as f:
            if _sha(f.read()) == want:
                return 0
    except OSError:
        pass
    d = os.path.dirname(dst)
    os.makedirs(d, mode=0o750, exist_ok=True)
    tmp = "%s.mig.%s" % (dst, uuid.uuid4().hex[:8])
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp, dst)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    with open(dst, "rb") as f:
        if _sha(f.read()) != want:
            raise EngineError("PGA-MIG-010", "verification failed after copying %s: the destination returned different bytes" % dst,
                              "check the destination storage (bit errors, a cache that lies); the migration can be resumed")
    if not fresh_mtime:
        st = os.stat(src)
        os.utime(dst, (st.st_atime, st.st_mtime))
    if throttle:
        throttle.take(len(data))
    return len(data)


def _sets_root(root, stanza):
    return os.path.join(root, "stanza", stanza, "backup")


def _wal_files(wal_dir):
    try:
        names = os.listdir(wal_dir)
    except OSError:
        return []
    out = []
    for n in names:
        if n.startswith(WAL_SKIP_PREFIX) or ".tmp" in n or ".mig." in n or n == "ARCHIVE_OWNER.json":
            continue
        if os.path.isfile(os.path.join(wal_dir, n)):
            out.append(n)
    # metas before their objects (the archive's own invariant: an object is trusted only with its meta)
    return sorted(out, key=lambda n: (0 if n.endswith(".meta") else 1, n))


def _inventory(ctx, src_repo, src_wal):
    """What belongs to THIS stanza in the previous location: sets (+ their chunks) not already in the current one, WAL files not already there."""
    from pg_arca.engine.repo import Repo
    out = {"sets": [], "chunks": {}, "set_bytes": 0, "wal": [], "wal_bytes": 0}
    if src_repo:
        old = Repo(src_repo, ctx.stanza, crypto=ctx.crypto)
        have = {m.get("id") for m in ctx.repo.own_sets()}
        for m in old.own_sets():
            if m.get("id") in have or m.get("status") != "COMPLETE":
                continue
            try:
                man = old.load_manifest(m)
            except Exception as e:
                raise EngineError("PGA-MIG-002", "manifest of set %s unreadable in %s: %s" % (m.get("id"), src_repo, e))
            hs = set(h for e in man["files"].values() for _, _, h in e["chunks"])
            out["sets"].append({"id": m["id"], "type": m.get("type"), "start_time": m.get("start_time"), "chunks": len(hs)})
            for h in hs:
                if h not in out["chunks"]:
                    p = os.path.join(src_repo, "cas", h[0:2], h[2:4], h)
                    try:
                        out["chunks"][h] = os.path.getsize(p)
                    except OSError:
                        raise EngineError("PGA-MIG-003", "chunk %s of set %s is missing in %s: that set is not restorable there either" % (h[:16], m["id"], src_repo),
                                          "run a deep verify of the previous location; the other sets can still be migrated after removing that one")
            sd = os.path.join(_sets_root(src_repo, ctx.stanza), m["id"])
            out["set_bytes"] += sum(os.path.getsize(os.path.join(sd, f)) for f in os.listdir(sd) if os.path.isfile(os.path.join(sd, f)))
        out["sets"].sort(key=lambda s: s.get("start_time") or "")
    if src_wal:
        for n in _wal_files(src_wal):
            if os.path.exists(os.path.join(ctx.wal_dir, n)):
                continue
            out["wal"].append(n)
            out["wal_bytes"] += os.path.getsize(os.path.join(src_wal, n))
    out["chunk_bytes"] = sum(out["chunks"].values())
    return out


def _space(path):
    p = path
    while p and not os.path.exists(p):
        p = os.path.dirname(p)
    st = os.statvfs(p or "/")
    return {"path": path, "free_bytes": st.f_bavail * st.f_frsize, "total_bytes": st.f_blocks * st.f_frsize, "free_inodes": st.f_favail if st.f_files else None}


def plan(ctx, src_repo=None, src_wal=None, bench=True):
    src_repo = src_repo if src_repo is not None else (ctx.repo.previous[0] if ctx.repo.previous else None)
    src_wal = src_wal if src_wal is not None else (ctx.wal.previous[0] if ctx.wal.previous else None)
    if not src_repo and not src_wal:
        raise EngineError("PGA-MIG-001", "nothing to migrate: no previous backup location is configured for this cluster")
    inv = _inventory(ctx, src_repo, src_wal)
    need_repo = inv["chunk_bytes"] + inv["set_bytes"]
    os.makedirs(ctx.repo.path, mode=0o750, exist_ok=True)
    os.makedirs(ctx.wal_dir, mode=0o750, exist_ok=True)
    sp_repo, sp_wal = _space(ctx.repo.path), _space(ctx.wal_dir)
    same_fs = os.stat(ctx.repo.path).st_dev == os.stat(ctx.wal_dir).st_dev
    files = len(inv["chunks"]) + sum(4 for _ in inv["sets"]) + len(inv["wal"])
    checks = []

    def add(cid, level, text, fix=None):
        checks.append(dict({"id": cid, "level": level, "text": text}, **({"fix": fix} if fix else {})))
    vols = [(sp_repo, need_repo + (inv["wal_bytes"] if same_fs else 0), "repository" + (" + WAL archive" if same_fs else ""))]
    if not same_fs:
        vols.append((sp_wal, inv["wal_bytes"], "WAL archive"))
    for sp, need, what in vols:
        after = sp["free_bytes"] - need
        if after < 0:
            add("space", "bad", "not enough space for the %s at %s: %.1f GiB free, %.1f GiB to copy" % (what, sp["path"], sp["free_bytes"] / 2.0 ** 30, need / 2.0 ** 30),
                "free space or enlarge the new destination; nothing has been copied")
        elif sp["total_bytes"] and after < sp["total_bytes"] * 0.10:
            add("space", "warn", "after the copy only %.1f GiB (%.0f%%) would stay free at %s" % (after / 2.0 ** 30, 100.0 * after / sp["total_bytes"], sp["path"]),
                "new backups need room too: consider a bigger volume")
        else:
            add("space", "ok", "%s: %.1f GiB to copy, %.1f GiB free (%.1f GiB after)" % (what, need / 2.0 ** 30, sp["free_bytes"] / 2.0 ** 30, after / 2.0 ** 30))
        if sp.get("free_inodes") is not None and sp["free_inodes"] < files + 10000:
            add("inodes", "bad", "%d free inodes at %s, about %d files to copy" % (sp["free_inodes"], sp["path"], files))
    speed = None
    if bench and (need_repo + inv["wal_bytes"]) > 0:
        from pg_arca.engine.destcheck import _bench
        b = _bench(ctx.repo.path, mb=16)
        speed = b.get("write_mb_s")
    total = need_repo + inv["wal_bytes"]
    res = {"source": {"repo": src_repo, "wal": src_wal}, "destination": {"repo": ctx.repo.path, "wal": ctx.wal_dir}, "stanza": ctx.stanza,
           "sets": inv["sets"], "chunks": len(inv["chunks"]), "chunk_bytes": inv["chunk_bytes"], "set_bytes": inv["set_bytes"],
           "wal_files": len(inv["wal"]), "wal_bytes": inv["wal_bytes"], "total_bytes": total, "files": files,
           "space": [sp_repo] + ([] if same_fs else [sp_wal]), "write_mb_s": speed,
           "estimated_seconds": int(total / (speed * 1024 * 1024)) + 1 if speed else None, "checks": checks,
           "ok": not any(c["level"] == "bad" for c in checks), "nothing_to_do": total == 0}
    try:
        res["source_usage_bytes"] = _du(src_repo) if src_repo else 0
        res["source_wal_usage_bytes"] = _du(src_wal) if src_wal else 0
    except OSError:
        pass
    return res


def _du(path):
    t = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                t += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return t


def run(ctx, src_repo=None, src_wal=None, throttle_mb_s=0, progress=None, cancel=None):
    from pg_arca.engine.backup import _check_cancel
    p = plan(ctx, src_repo, src_wal, bench=False)
    if not p["ok"]:
        raise EngineError("PGA-MIG-004", "migration not started: %s" % "; ".join(c["text"] for c in p["checks"] if c["level"] == "bad"))
    src_repo, src_wal = p["source"]["repo"], p["source"]["wal"]
    st_path = os.path.join(ctx.repo.path, STATE)
    state = {}
    try:
        state = read_json(st_path)
    except (OSError, ValueError):
        pass
    state.update(source=p["source"], started=state.get("started") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), resumed=bool(state.get("started")))
    write_json(st_path, state)
    th = Throttle(throttle_mb_s)
    done_b, total_b = 0, p["total_bytes"]
    copied = {"chunks": 0, "sets": 0, "wal": 0, "bytes": 0}
    t0 = time.time()

    def tick(phase, extra=None):
        if progress:
            el = max(time.time() - t0, 0.001)
            rate = done_b / el
            progress(dict({"phase": phase, "bytes": done_b, "bytes_total": total_b, "mb_s": round(rate / 1048576.0, 1),
                           "eta_seconds": int((total_b - done_b) / rate) if rate > 0 else None}, **(extra or {})))
    # ---- sets: their chunks, then the set directory (atomically)
    if src_repo:
        old_sets = _sets_root(src_repo, ctx.stanza)
        new_sets = _sets_root(ctx.repo.path, ctx.stanza)
        os.makedirs(new_sets, mode=0o750, exist_ok=True)
        sj_old, sj_new = os.path.join(src_repo, "stanza", ctx.stanza, "stanza.json"), os.path.join(ctx.repo.path, "stanza", ctx.stanza, "stanza.json")
        if os.path.exists(sj_old) and not os.path.exists(sj_new):
            shutil.copyfile(sj_old, sj_new)
        from pg_arca.engine.repo import Repo
        old = Repo(src_repo, ctx.stanza, crypto=ctx.crypto)
        for i, s in enumerate(p["sets"]):
            man = old.load_manifest({"id": s["id"]})
            for h in sorted(set(h for e in man["files"].values() for _, _, h in e["chunks"])):
                _check_cancel(cancel)
                n = _copy_verified(os.path.join(src_repo, "cas", h[0:2], h[2:4], h), os.path.join(ctx.repo.path, "cas", h[0:2], h[2:4], h), th)
                if n:
                    copied["chunks"] += 1
                    done_b += n
                    if copied["chunks"] % 200 == 0:
                        tick("chunks", {"set": s["id"], "sets_done": i, "sets_total": len(p["sets"])})
            _check_cancel(cancel)
            src_d, dst_d = os.path.join(old_sets, s["id"]), os.path.join(new_sets, s["id"])
            if not os.path.isdir(dst_d):
                tmp_d = os.path.join(new_sets, ".mig-" + s["id"])
                shutil.rmtree(tmp_d, ignore_errors=True)
                os.makedirs(tmp_d, mode=0o750)
                for f in sorted(os.listdir(src_d)):
                    if os.path.isfile(os.path.join(src_d, f)):
                        done_b += _copy_verified(os.path.join(src_d, f), os.path.join(tmp_d, f), th, fresh_mtime=False)
                _fsync_dir(tmp_d)
                os.rename(tmp_d, dst_d)
                _fsync_dir(new_sets)
                copied["sets"] += 1
            state.setdefault("sets_done", [])
            if s["id"] not in state["sets_done"]:
                state["sets_done"].append(s["id"])
                write_json(st_path, state)
            tick("sets", {"set": s["id"], "sets_done": i + 1, "sets_total": len(p["sets"])})
    # ---- WAL: metas first, then segments / histories / labels
    if src_wal:
        for n in _wal_files(src_wal):
            _check_cancel(cancel)
            if os.path.exists(os.path.join(ctx.wal_dir, n)):
                continue
            b = _copy_verified(os.path.join(src_wal, n), os.path.join(ctx.wal_dir, n), th, fresh_mtime=False)
            done_b += b
            copied["wal"] += 1
            if copied["wal"] % 100 == 0:
                tick("wal", {"wal_done": copied["wal"], "wal_total": p["wal_files"]})
        _fsync_dir(ctx.wal_dir)
    copied["bytes"] = done_b
    # ---- verify: nothing of this stanza is left only in the previous location
    rest = _inventory(ctx, src_repo, src_wal)
    complete = not rest["sets"] and not rest["wal"]
    state.update(finished=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), complete=complete, copied=copied)
    write_json(st_path, state)
    tick("done")
    return {"source": p["source"], "destination": p["destination"], "copied": copied, "complete": complete, "seconds": round(time.time() - t0, 1),
            "left": {"sets": [s["id"] for s in rest["sets"]], "wal_files": len(rest["wal"])},
            "note": "the previous location was not deleted: it is no longer needed for restores" if complete else "some content is still only in the previous location"}


def drop_previous(ctx, src_repo=None, src_wal=None, abandon=False):
    """Delete THIS cluster's content from a previous location: its stanza (sets) and the chunks no other stanza there still uses (garbage collection
    with the usual grace), and its WAL files. Refused while a set or WAL file of this cluster exists ONLY there, unless abandon=True (the PITR
    history they carry is lost on purpose). Other clusters' content in the same root is never touched."""
    from pg_arca.engine.maintenance import _gc_cas
    from pg_arca.engine.repo import Repo
    left = _inventory(ctx, src_repo, src_wal)
    if (left["sets"] or left["wal"]) and not abandon:
        raise EngineError("PGA-MIG-020", "%d backup set(s) and %d WAL file(s) of this cluster exist only in the previous location: deleting it would lose them"
                          % (len(left["sets"]), len(left["wal"])), "migrate them first, or confirm that this history is no longer needed")
    out = {"sets_removed": 0, "chunks_removed": 0, "bytes_freed": 0, "wal_removed": 0, "abandoned": {"sets": [s["id"] for s in left["sets"]], "wal_files": len(left["wal"])} if abandon else None}
    if src_repo:
        sd = os.path.join(src_repo, "stanza", ctx.stanza)
        if os.path.isdir(sd):
            out["sets_removed"] = len([x for x in os.listdir(os.path.join(sd, "backup")) if not x.startswith(".")]) if os.path.isdir(os.path.join(sd, "backup")) else 0
            shutil.rmtree(sd)
        if os.path.isdir(os.path.join(src_repo, "cas")) and os.path.isdir(os.path.join(src_repo, "stanza")):
            freed, removed = _gc_cas(Repo(src_repo, ctx.stanza, crypto=ctx.crypto))
            out["chunks_removed"], out["bytes_freed"] = removed, freed
    if src_wal and os.path.isdir(src_wal):
        for n in os.listdir(src_wal):
            p = os.path.join(src_wal, n)
            if os.path.isfile(p) and n != "ARCHIVE_OWNER.json":
                out["bytes_freed"] += os.path.getsize(p)
                os.unlink(p)
                out["wal_removed"] += 1
    return out
