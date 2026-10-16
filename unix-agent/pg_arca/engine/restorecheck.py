"""Pre-flight of a restore: everything that can be known BEFORE the (long) recovery starts and would make it fail or hurt.

Used by the plan (dry run: the console shows every finding and blocks the start on a blocker) and again, enforcing, when the restore really starts: a plan that was fine
an hour ago says nothing about the disk now.
  * the backup chain is complete: every chunk the extraction needs is in the repository (full check up to 300 000 chunks, a random sample beyond);
  * space: scratch (extraction + dump + WAL read-ahead) and, for a database / quarantine copy, the volume of the live data directory where it will be created;
  * a quarantine / destination database name that is already taken (otherwise found after the recovery, minutes later);
  * the ephemeral instance can run here (binaries of the right major, memory, port, readable repository) - engine/ephcfg.preflight.
Each finding: {id, level ok|warn|bad, text, fix}. Nothing here modifies anything."""
import os
import random

from pg_arca.engine import ephcfg
from pg_arca.engine.util import EngineError, human

FULL_CHECK_MAX = 300000


def _chunk_hashes(merged):
    for v in merged.values():
        for _off, (_ln, h) in v.get("chunks", {}).items():
            yield h


def missing_chunks(repo, merged, limit=10):
    """(checked, missing_total, [examples]). Every referenced chunk is stat'ed, or a random sample of FULL_CHECK_MAX when there are more."""
    hashes = list(dict.fromkeys(_chunk_hashes(merged)))
    if hasattr(repo, "reload_index"):
        repo.reload_index()                                    # packs deleted or added since this process loaded the index are seen
    sampled = len(hashes) > FULL_CHECK_MAX
    if sampled:
        hashes = random.sample(hashes, FULL_CHECK_MAX)
    miss = []
    n = 0
    for h in hashes:
        if not (repo.find_chunk(h) if hasattr(repo, "find_chunk") else os.path.exists(repo.cas_path(h))):
            n += 1
            if len(miss) < limit:
                miss.append(h[:16])
    return len(hashes), n, miss, sampled


def _existing(path):
    p = os.path.abspath(path)
    while p and not os.path.exists(p):
        np_ = os.path.dirname(p)
        if np_ == p:
            break
        p = np_
    return p or "/"


ROLE_LABEL = {"scratch": "scratch of the recovery instance (extraction, WAL read-ahead, dump)", "data": "data directory of the live cluster (restored database / quarantine copy)",
              "dest": "restore destination", "tablespace": "tablespace destination"}


def volumes(needs):
    """needs: [(role, path, bytes)]. Groups them by FILESYSTEM: when the scratch and the live data directory share a volume (very common) their needs ADD UP,
    which two separate checks would miss. -> [{dev, mount_hint, paths, roles, need, free, total}]"""
    vols = {}
    for role, path, need in needs:
        if not path:
            continue
        p = _existing(path)
        try:
            st = os.statvfs(p); dev = os.stat(p).st_dev
        except OSError:
            continue
        free, total = st.f_bavail * st.f_frsize, st.f_blocks * st.f_frsize
        if dev not in vols:
            # different device numbers can still be ONE disk: an overlay / bind mount / container volume reports the statistics of the filesystem below it.
            # Same size and (almost) the same free space = treat as the same volume (summing needs is the safe side; two distinct filesystems of identical size
            # and free space are rare, and the price is only a stricter check)
            twin = next((k for k, x in vols.items() if x["total"] == total and abs(x["free"] - free) <= max(64 << 20, free // 200)), None)
            if twin is not None:
                dev = twin
        v = vols.setdefault(dev, {"paths": [], "roles": [], "need": 0, "free": free, "total": total})
        if path not in v["paths"]:
            v["paths"].append(path)
        if role not in v["roles"]:
            v["roles"].append(role)
        v["need"] += int(max(0, need or 0))
    return list(vols.values())


def _reserve(total, live):
    """Free space that must remain after a restore: 5 % of a live data volume (2 % of another), at least 1 GiB (256 MiB), at most 50 GiB (20 GiB) -
    on a 10 TB volume 5 % is 500 GB, and a restore that leaves 300 GB free was refused for nothing."""
    if live:
        return max(min(int(0.05 * total), 50 << 30), 1 << 30)
    return max(min(int(0.02 * total), 20 << 30), 256 << 20)


def space_checks(vols, add):
    """One finding per volume. The live cluster's volume is held to a stricter standard: PostgreSQL stops (PANIC on WAL write) when it fills up."""
    for v in vols:
        after = v["free"] - v["need"]
        live = "data" in v["roles"]
        keep = _reserve(v["total"], live)
        v["free_after"] = after
        what = " + ".join(ROLE_LABEL.get(r, r) for r in v["roles"])
        where = ", ".join(v["paths"])
        if v["need"] <= 0:
            continue
        if after < 0:
            add("space", "bad", "not enough space on the volume of %s (%s): %s free, about %s needed" % (where, what, human(v["free"]), human(v["need"])),
                "free space there, move the scratch directory to another volume (recovery instance settings), or restore fewer objects", volume=v)
        elif after < keep:
            add("space", "bad" if live else "warn", "the volume of %s (%s) would be left with %s free (%.1f%%)%s" % (where, what, human(after), 100.0 * after / max(v["total"], 1),
                ": a full data volume stops PostgreSQL" if live else ""), "free space first, or put the scratch directory on another volume", volume=v)
        elif live and after < 0.10 * v["total"]:
            add("space", "warn", "after the restore the live cluster's volume (%s) would have %s free (%.1f%%)" % (where, human(after), 100.0 * after / max(v["total"], 1)),
                "keep at least 10% free on the data volume", volume=v)
        else:
            add("space", "ok", "%s: %s free, about %s needed" % (where, human(v["free"]), human(v["need"])), volume=v)


def _free(path):
    p = os.path.abspath(path)
    while p and not os.path.exists(p):
        np_ = os.path.dirname(p)
        if np_ == p:
            break
        p = np_
    try:
        st = os.statvfs(p)
        return st.f_bavail * st.f_frsize
    except OSError:
        return None


def check(ctx, plan, merged_sel=None, target_set=None, need_dest=0, into=None, name_taken=None, scope="database"):
    """Findings for a restore plan (see the module docstring). `need_dest`: bytes the restored data will occupy on the live cluster's data volume (0 = nothing is created there);
    `name_taken`: a database name that must not exist yet (checked by the caller against the live cluster)."""
    out = []

    def add(cid, level, text, fix=None, **extra):
        d = {"id": cid, "level": level, "text": text}
        if fix:
            d["fix"] = fix
        d.update(extra)
        out.append(d)
    # ---- chain
    if merged_sel is not None:
        checked, miss, ex, sampled = missing_chunks(ctx.repo, merged_sel)
        if miss:
            add("chunks", "bad", "%d of the %d backup chunks this restore needs are missing from the repository (e.g. %s)" % (miss, checked, ", ".join(ex[:3])),
                ("the offsite copy is configured on this node: Status → Nodes → Offsite copy → 'Download what is missing here' brings them back; " if getattr(ctx, "has_offsite", False) else "")
                + "restore the repository from its copy, or choose an older backup set / point in time that does not depend on them; run a deep verify")
        else:
            add("chunks", "ok", "all %d backup chunks needed are present in the repository%s" % (checked, " (random sample)" if sampled else ""))
    # ---- scratch + ephemeral instance
    extract = int(plan.get("extract_bytes") or 0)
    sel = int(plan.get("size_in_backup") or plan.get("database_bytes") or extract)
    need_scratch = extract + int(sel * 0.5) + 10 * ctx.seg_size + (256 << 20)         # extracted files + the dump (zstd, about half or less) + read-ahead window + slack
    plan["need_scratch_bytes"] = need_scratch
    try:
        major = None
        if target_set is not None:
            from pg_arca.pgcompat import set_profile
            pr = set_profile(target_set)
            major = int(pr.major) if pr is not None else None
        pf = ephcfg.preflight(ctx, major, ctx.eph, need_bytes=None, with_plan=False)        # space is judged below, per volume
        for c in pf["checks"]:
            if c["id"] == "scratch" and c["level"] == "ok":
                continue
            if c["level"] != "ok" or c["id"] == "binaries":
                add("eph_" + c["id"], c["level"], c["text"], c.get("fix"))
    except Exception as e:                                                          # the pre-flight must never be the thing that breaks a restore
        add("eph", "warn", "could not check the recovery environment: %s" % e)
    # ---- space, per filesystem (scratch and the live data directory often share one)
    needs = [("scratch", ctx.scratch_dir, need_scratch)]
    if need_dest and not into and ctx.pgdata:
        needs.append(("data", ctx.pgdata, int(need_dest * 1.15)))                  # +15%: indexes rebuilt, temporary files
        plan["need_dest_bytes"] = int(need_dest * 1.15)
    vols = volumes(needs)
    space_checks(vols, add)
    plan["space"] = [{"paths": v["paths"], "roles": v["roles"], "need": v["need"], "free": v["free"], "total": v["total"], "free_after": v.get("free_after")} for v in vols]
    for v in vols:
        if "data" in v["roles"]:
            plan["dest_free_bytes"] = v["free"]
    if need_dest and into:
        disk = into.get("disk") if isinstance(into, dict) else None     # what the destination's own agent reports (sent by the console), when known
        need = int(need_dest * 1.15)
        if isinstance(disk, dict) and disk.get("free_bytes") is not None and disk.get("total_bytes"):
            free, total = int(disk["free_bytes"]), int(disk["total_bytes"])
            keep = _reserve(total, True)
            plan["dest_free_bytes"] = free
            if free - need < 0:
                add("dest_space", "bad", "not enough space on the data volume of the destination cluster: %s free, about %s needed" % (human(free), human(need)),
                    "free space there, or restore fewer objects")
            elif free - need < keep:
                add("dest_space", "bad", "the data volume of the destination cluster would be left with %s free: a full data volume stops PostgreSQL" % human(free - need), "free space there first")
            else:
                add("dest_space", "ok", "destination cluster data volume: %s free, about %s needed" % (human(free), human(need)))
        else:
            add("dest_space", "warn", "the destination is another cluster: its free disk space cannot be checked from here", "make sure it has about %s free" % human(need))
    if name_taken:
        add("name", "bad", "destination database '%s' already exists" % name_taken, "choose another name; existing databases are never overwritten", code="PGA-SEC-030")
    return out


def _total(path):
    try:
        st = os.statvfs(path)
        return st.f_blocks * st.f_frsize
    except OSError:
        return 1 << 40


def summarize(checks):
    worst = "bad" if any(c["level"] == "bad" for c in checks) else ("warn" if any(c["level"] == "warn" for c in checks) else "ok")
    return {"ok": worst != "bad", "level": worst, "checks": checks}


def access_check(path, role="restore destination"):
    """Can the agent's OS user create / write `path`? None when yes, else a blocker. Found before anything is extracted, with the exact command to fix it
    (a destination under /srv, /data, a mount point owned by root is the usual case)."""
    import getpass
    try:
        me = getpass.getuser()
    except Exception:
        me = str(os.getuid())
    p = os.path.abspath(path)
    if os.path.isdir(p):
        if os.access(p, os.W_OK | os.X_OK):
            return None
        return {"id": "dest_access", "level": "bad", "code": "PGA-RST-033", "text": "%s %s exists but the agent's user (%s) cannot write into it" % (role, p, me),
                "fix": "chown %s: %s (or choose another destination)" % (me, p)}
    anc = _existing(p)
    if os.access(anc, os.W_OK | os.X_OK):
        return None
    return {"id": "dest_access", "level": "bad", "code": "PGA-RST-033", "text": "the agent's user (%s) cannot create %s %s: %s is not writable for it" % (me, role, p, anc),
            "fix": "create it for the agent: mkdir -p %s && chown %s: %s (or choose a destination under a directory it owns)" % (p, me, p)}


def enforce(checks):
    """The restore is really starting: a blocker stops it NOW, before any extraction."""
    bad = [c for c in checks if c["level"] == "bad"]
    coded = [c for c in bad if c.get("code")]                                      # a blocker with its own stable code (name taken) keeps it
    if coded:
        raise EngineError(coded[0]["code"], coded[0]["text"], coded[0].get("fix"))
    if bad:
        raise EngineError("PGA-RST-031", "restore not started: %s" % "; ".join(c["text"] for c in bad[:3]), "; ".join(c["fix"] for c in bad if c.get("fix"))[:400] or None)
