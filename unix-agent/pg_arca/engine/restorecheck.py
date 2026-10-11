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
    sampled = len(hashes) > FULL_CHECK_MAX
    if sampled:
        hashes = random.sample(hashes, FULL_CHECK_MAX)
    miss = []
    n = 0
    for h in hashes:
        if not os.path.exists(repo.cas_path(h)):
            n += 1
            if len(miss) < limit:
                miss.append(h[:16])
    return len(hashes), n, miss, sampled


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
                "restore the repository from its copy, or choose an older backup set / point in time that does not depend on them; run a deep verify")
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
        pf = ephcfg.preflight(ctx, major, ctx.eph, need_bytes=need_scratch, with_plan=False)
        for c in pf["checks"]:
            if c["level"] != "ok" or c["id"] in ("binaries", "scratch"):
                add("eph_" + c["id"], c["level"], c["text"], c.get("fix"))
    except Exception as e:                                                          # the pre-flight must never be the thing that breaks a restore
        add("eph", "warn", "could not check the recovery environment: %s" % e)
    # ---- destination volume (the live cluster's data directory)
    if need_dest and not into and ctx.pgdata:
        free = _free(ctx.pgdata)
        plan["need_dest_bytes"] = int(need_dest * 1.15)
        if free is not None:
            plan["dest_free_bytes"] = free
            if free < need_dest * 1.15:
                add("dest_space", "bad", "the data volume of the live cluster has %s free; the restored data needs about %s (+15%% for indexes and temporary files)" % (human(free), human(int(need_dest * 1.15))),
                    "free space on the data volume, or restore into another cluster / pick fewer objects")
            elif free - need_dest * 1.15 < 0.10 * _total(ctx.pgdata):
                add("dest_space", "warn", "after the restore the data volume would be left with less than 10%% free (%s free now, about %s needed)" % (human(free), human(int(need_dest * 1.15))),
                    "a full data volume stops PostgreSQL: free some space first")
            else:
                add("dest_space", "ok", "data volume: %s free, the restore needs about %s" % (human(free), human(int(need_dest * 1.15))))
    elif need_dest and into:
        add("dest_space", "warn", "the destination is another cluster: its free disk space cannot be checked from here", "make sure it has about %s free" % human(int(need_dest * 1.15)))
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


def enforce(checks):
    """The restore is really starting: a blocker stops it NOW, before any extraction."""
    bad = [c for c in checks if c["level"] == "bad"]
    coded = [c for c in bad if c.get("code")]                                      # a blocker with its own stable code (name taken) keeps it
    if coded:
        raise EngineError(coded[0]["code"], coded[0]["text"], coded[0].get("fix"))
    if bad:
        raise EngineError("PGA-RST-031", "restore not started: %s" % "; ".join(c["text"] for c in bad[:3]), "; ".join(c["fix"] for c in bad if c.get("fix"))[:400] or None)
