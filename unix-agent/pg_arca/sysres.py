"""CPU and memory the agent may REALLY use. In a container or under a systemd slice /proc/meminfo and os.cpu_count() describe the whole host, and every sizing decision
(tuning advice, the memory check before an ephemeral instance) would be wrong by the ratio. This reads the cgroup limits (v2 and v1) and the CPU affinity, and falls back to the
host numbers when there is no limit."""
import os

_UNLIMITED = 1 << 60                                         # cgroup v1 reports ~2^63 for "no limit"


def _read(path):
    try:
        with open(path, "r") as f:
            return f.read().strip()
    except (IOError, OSError):
        return None


def _cgroup_dirs(root="/sys/fs/cgroup", proc_cgroup="/proc/self/cgroup"):
    """Candidate cgroup directories of this process, deepest first (the limit may sit on a parent slice)."""
    dirs = []
    txt = _read(proc_cgroup) or ""
    for line in txt.splitlines():
        parts = line.split(":", 2)
        if len(parts) != 3:
            continue
        sub = parts[2].strip("/")
        ctrl = parts[1]
        base = root if parts[0] == "0" else os.path.join(root, ctrl.split(",")[0]) if ctrl else root
        if sub:
            p = os.path.join(base, sub)
            while len(p) > len(base):
                dirs.append(p)
                p = os.path.dirname(p)
        dirs.append(base)
    return list(dict.fromkeys(dirs)) or [root]


def memory_limit(root="/sys/fs/cgroup", proc_cgroup="/proc/self/cgroup"):
    """(limit_bytes, usage_bytes) of the tightest cgroup memory limit, or (None, None)."""
    best = None
    for d in _cgroup_dirs(root, proc_cgroup):
        for lim_f, use_f in (("memory.max", "memory.current"), ("memory.limit_in_bytes", "memory.usage_in_bytes")):
            v = _read(os.path.join(d, lim_f))
            if v and v.isdigit() and int(v) < _UNLIMITED:
                use = _read(os.path.join(d, use_f))
                cand = (int(v), int(use) if use and use.isdigit() else None)
                if best is None or cand[0] < best[0]:
                    best = cand
    return best if best else (None, None)


def cpu_count(root="/sys/fs/cgroup", proc_cgroup="/proc/self/cgroup"):
    """CPUs available: the affinity mask, reduced by a cgroup CPU quota (rounded up, at least 1)."""
    try:
        n = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        n = os.cpu_count() or 1
    for d in _cgroup_dirs(root, proc_cgroup):
        mx = _read(os.path.join(d, "cpu.max"))                       # v2: "max 100000" or "200000 100000"
        if mx:
            q = mx.split()
            if len(q) == 2 and q[0].isdigit() and q[1].isdigit() and int(q[1]) > 0:
                n = min(n, max(1, -(-int(q[0]) // int(q[1]))))
            continue
        qv, pv = _read(os.path.join(d, "cpu.cfs_quota_us")), _read(os.path.join(d, "cpu.cfs_period_us"))   # v1
        if qv and pv and qv.lstrip("-").isdigit() and pv.isdigit() and int(qv) > 0 and int(pv) > 0:
            n = min(n, max(1, -(-int(qv) // int(pv))))
    return max(1, n)


def memory(meminfo="/proc/meminfo", **kw):
    """{total, available} in bytes: host numbers, capped by the cgroup limit (available = limit - usage, never above the host's)."""
    host_total = host_avail = 0
    txt = _read(meminfo) or ""
    for line in txt.splitlines():
        k, _, v = line.partition(":")
        if k in ("MemTotal", "MemAvailable") and v.split():
            val = int(v.split()[0]) * 1024
            if k == "MemTotal":
                host_total = val
            else:
                host_avail = val
    lim, use = memory_limit(**kw)
    if lim is None or (host_total and lim >= host_total):
        return {"total": host_total, "available": host_avail, "limited": False}
    avail = max(0, lim - use) if use is not None else lim
    return {"total": lim, "available": min(avail, host_avail) if host_avail else avail, "limited": True}
