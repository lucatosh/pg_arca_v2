"""Where and how the ephemeral recovery instance runs: settings, PostgreSQL binaries per major version, preflight and installation of missing binaries.

A granular restore (one database / table / schema) starts a short-lived PostgreSQL on a scratch directory. It needs
  - server binaries of the SAME major version as the backup (a data directory only opens with its own major),
  - a writable scratch directory with room for the extracted files,
  - a free TCP port, enough memory, and a non-root OS user.
Everything here is detection and configuration: `preflight()` reports what is missing and why, `install_plan()` says what installing PostgreSQL N would do
(and what permissions it needs), `install()` does it only when told to. Nothing in this module touches a running cluster.
"""
import glob
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile

from pg_arca.engine.util import EngineError

TOOLS = ("postgres", "pg_ctl", "psql", "pg_dump", "pg_restore", "pg_waldump", "pg_controldata")
KEYS = ("placement", "central_node", "scratch_dir", "bin_dir", "port_min", "port_max", "shared_buffers_mb", "keep_on_failure", "install_dir", "install_mode")
PRIVATE_ROOT = "/var/lib/pgarca/pg"
SYSTEM_GLOBS = ("/usr/lib/postgresql/*/bin", "/usr/pgsql-*/bin", "/usr/local/pgsql*/bin", "/opt/postgresql*/bin", "/opt/pgsql*/bin", "/opt/edb/as*/bin", "/usr/local/pg*/bin")


# ============================================================================================================== settings
def normalize(d):
    """Validate the settings that reach the agent (from the console or agent.conf). Unknown keys are dropped; wrong values raise EngineError PGA-CFG-040."""
    from pg_arca import overrides
    out = {}
    d = d or {}

    def bad(k, msg):
        raise EngineError("PGA-CFG-040", "ephemeral setting %s: %s" % (k, msg))
    if d.get("placement") not in (None, "", "node", "central"):
        bad("placement", "must be node or central")
    if d.get("placement"):
        out["placement"] = d["placement"]
    if d.get("central_node"):
        out["central_node"] = str(d["central_node"])[:80]
    for k, cfg_key in (("scratch_dir", "scratch_dir"), ("bin_dir", "pg_bin_dir")):
        v = d.get(k)
        if v in (None, ""):
            continue
        try:
            out[k] = overrides.validate(cfg_key, v)
        except overrides.OverrideError as e:
            bad(k, str(e))
    if d.get("install_dir") not in (None, ""):
        try:
            out["install_dir"] = overrides.validate("scratch_dir", d["install_dir"])
        except overrides.OverrideError as e:
            bad("install_dir", str(e))
    for k, lo, hi in (("port_min", 1024, 65535), ("port_max", 1024, 65535), ("shared_buffers_mb", 16, 262144)):
        if d.get(k) in (None, ""):
            continue
        try:
            n = int(d[k])
        except (TypeError, ValueError):
            bad(k, "must be a number")
        if not lo <= n <= hi:
            bad(k, "must be %d..%d" % (lo, hi))
        out[k] = n
    if ("port_min" in out) != ("port_max" in out):
        bad("port_min", "set both port_min and port_max, or neither")
    if "port_min" in out and out["port_min"] > out["port_max"]:
        bad("port_min", "port_min must not exceed port_max")
    if d.get("keep_on_failure") not in (None, ""):
        out["keep_on_failure"] = bool(d["keep_on_failure"])
    if d.get("install_mode") not in (None, "", "private", "system"):
        bad("install_mode", "must be private or system")
    if d.get("install_mode"):
        out["install_mode"] = d["install_mode"]
    return out


def free_port(eph=None):
    """A free TCP port: inside the configured range when there is one (firewalled hosts), otherwise whatever the OS gives."""
    eph = eph or {}
    if eph.get("port_min"):
        import random
        ports = list(range(eph["port_min"], eph["port_max"] + 1))
        random.shuffle(ports)
        for p in ports:
            s = socket.socket()
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
            finally:
                s.close()
        raise EngineError("PGA-CFG-041", "no free port in the configured range %d-%d" % (eph["port_min"], eph["port_max"]), "widen the range or stop what is using it")
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ============================================================================================================== binaries
def _version_of(bindir):
    """(major_int, '16.4') of the postgres binary in `bindir`, or (None, None)."""
    exe = os.path.join(bindir, "postgres")
    if not os.access(exe, os.X_OK):
        exe = os.path.join(bindir, "pg_ctl")
        if not os.access(exe, os.X_OK):
            return None, None
    try:
        out = subprocess.run([exe, "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None, None
    m = re.search(r"\(PostgreSQL\)\s*(\d+)(?:\.(\d+))?", out)
    if not m:
        return None, None
    major = int(m.group(1))
    if major < 10 and m.group(2):                                  # 9.6 -> 906 style is not supported by the engine anyway: report the two-part major as 9
        major = int(m.group(1))
    return major, out.strip().split("(PostgreSQL)")[-1].strip().split(" ")[0]


def _inst(bindir, source):
    major, ver = _version_of(bindir)
    missing = [t for t in TOOLS if not os.access(os.path.join(bindir, t), os.X_OK)]
    return {"bindir": bindir, "major": major, "version": ver, "missing_tools": missing, "complete": major is not None and not missing, "source": source}


def scan_installations(eph=None, extra=(), private_root=None):
    """Every PostgreSQL bin directory that can be found: standard package locations, the private install root of pg_arca, configured directories."""
    eph = eph or {}
    seen, out = set(), []
    cand = []
    root = private_root or eph.get("install_dir") or PRIVATE_ROOT
    for pat in glob.glob(os.path.join(root, "*", "usr", "lib", "postgresql", "*", "bin")) + glob.glob(os.path.join(root, "*", "usr", "pgsql-*", "bin")) + glob.glob(os.path.join(root, "*", "bin")):
        cand.append((pat, "private"))
    for pat in SYSTEM_GLOBS:
        for d in glob.glob(pat):
            cand.append((d, "system"))
    for d in [eph.get("bin_dir")] + list(extra):
        if d:
            cand.append((d, "configured"))
    for d, src in cand:
        real = os.path.realpath(d)
        if real in seen or not os.path.isdir(real):
            continue
        seen.add(real)
        i = _inst(d, src)
        if i["major"] is not None:
            out.append(i)
    out.sort(key=lambda i: (-(i["major"] or 0), i["source"] != "configured", i["source"] != "system"))
    return out


def pick_bindir(major, eph=None, default_bindir="", private_root=None):
    """The bin directory to run an ephemeral instance of `major` with: explicitly configured, else the node's own when it matches, else any complete installation of that major,
    else the node's own (the caller then explains the version mismatch). Returns (bindir, source)."""
    eph = eph or {}
    order = []
    if eph.get("bin_dir"):
        order.append((eph["bin_dir"], "configured"))
    if default_bindir:
        order.append((default_bindir, "node"))
    for d, src in order:
        i = _inst(d, src)
        if i["major"] == major and i["complete"]:
            return d, src
    for i in scan_installations(eph, private_root=private_root):
        if i["major"] == major and i["complete"]:
            return i["bindir"], i["source"]
    for i in scan_installations(eph, private_root=private_root):
        if i["major"] == major:
            return i["bindir"], i["source"]
    return default_bindir, "node"


# ============================================================================================================== host facts
def _read(path):
    try:
        with open(path, "r") as f:
            return f.read()
    except (IOError, OSError):
        return ""


def host_facts():
    osr = {}
    for line in _read("/etc/os-release").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            osr[k] = v.strip().strip('"')
    fam = "unknown"
    ids = (osr.get("ID", "") + " " + osr.get("ID_LIKE", "")).lower()
    if any(x in ids for x in ("debian", "ubuntu")):
        fam = "debian"
    elif any(x in ids for x in ("rhel", "fedora", "centos", "rocky", "almalinux", "ol", "amzn")):
        fam = "rhel"
    elif any(x in ids for x in ("suse", "sles")):
        fam = "suse"
    mem = {}
    for line in _read("/proc/meminfo").splitlines():
        m = re.match(r"(\w+):\s+(\d+) kB", line)
        if m:
            mem[m.group(1)] = int(m.group(2)) * 1024
    sudo = False
    if os.geteuid() != 0 and shutil.which("sudo"):
        try:
            sudo = subprocess.run(["sudo", "-n", "true"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10).returncode == 0
        except (OSError, subprocess.SubprocessError):
            sudo = False
    return {"os": osr.get("PRETTY_NAME") or osr.get("NAME") or "unknown", "family": fam, "euid": os.geteuid(), "root": os.geteuid() == 0, "sudo_nopasswd": sudo,
            "arch": os.uname().machine, "mem_total": mem.get("MemTotal"), "mem_available": mem.get("MemAvailable"), "cpus": os.cpu_count(),
            "apt": bool(shutil.which("apt-get")), "dnf": bool(shutil.which("dnf") or shutil.which("yum")), "dpkg_deb": bool(shutil.which("dpkg-deb")),
            "rpm2cpio": bool(shutil.which("rpm2cpio")), "cpio": bool(shutil.which("cpio"))}


# ============================================================================================================== install
def _pkgs(family, major):
    if family == "debian":
        return ["postgresql-%d" % major, "postgresql-client-%d" % major]
    if family == "rhel":
        return ["postgresql%d-server" % major, "postgresql%d" % major]
    return []


def _available(family, major, run=None):
    """Does the package manager know the package? (False/True/None for 'cannot tell')."""
    run = run or _run
    try:
        if family == "debian":
            rc, out = run(["apt-cache", "policy", "postgresql-%d" % major])
            return rc == 0 and bool(re.search(r"Candidate:\s*(?!\(none\))\S+", out))
        if family == "rhel":
            tool = shutil.which("dnf") or shutil.which("yum")
            if not tool:
                return None
            rc, out = run([tool, "-q", "list", "--available", "postgresql%d-server" % major])
            return rc == 0 and "postgresql%d-server" % major in out
    except (OSError, subprocess.SubprocessError):
        return None
    return None


def _run(cmd, cwd=None, timeout=900, env=None):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, cwd=cwd, timeout=timeout, env=env)
    return p.returncode, p.stdout


def install_plan(major, eph=None, facts=None, available=None):
    """What it would take to get PostgreSQL `major` server binaries on this host, in two ways. Nothing is executed.
      private  no root: the packages are downloaded and unpacked under a pg_arca directory. No service, no system file is touched, nothing is registered with the package manager.
      system   the normal package install: needs root (or passwordless sudo), pulls dependencies, and on Debian/Ubuntu the package normally creates and starts a NEW cluster."""
    eph = eph or {}
    f = facts or host_facts()
    fam = f["family"]
    root = eph.get("install_dir") or PRIVATE_ROOT
    plan = {"major": major, "host": {k: f[k] for k in ("os", "family", "root", "sudo_nopasswd", "arch")}, "modes": {}, "recommended": None}
    pk = _pkgs(fam, major)
    avail = _available(fam, major) if available is None else available
    common = []
    if fam not in ("debian", "rhel"):
        plan["blocked"] = "automatic installation is supported on Debian/Ubuntu and RHEL-like systems; on this host (%s) install the PostgreSQL %d server package by hand and set the binaries directory" % (f["os"], major)
        return plan
    if avail is False:
        common.append("the package manager does not know %s: add the PostgreSQL (PGDG) repository for this distribution first (https://www.postgresql.org/download/linux/)" % ", ".join(pk))
    # ---- private
    need, blockers = [], []
    if fam == "debian":
        if not f["apt"]:
            blockers.append("apt-get not found")
        if not f["dpkg_deb"]:
            blockers.append("dpkg-deb not found")
        cmds = ["apt-get download %s  (as the agent user, in a temporary directory; needs the package lists to be up to date and network access to the repository)" % " ".join(pk),
                "dpkg-deb -x <each .deb> %s/%d  (unpacks files only: no scripts run, no service, no cluster)" % (root, major)]
        bindir = "%s/%d/usr/lib/postgresql/%d/bin" % (root, major, major)
    else:
        if not f["dnf"]:
            blockers.append("dnf/yum not found")
        if not f["rpm2cpio"] or not f["cpio"]:
            blockers.append("rpm2cpio and cpio are needed to unpack the packages without root")
        cmds = ["dnf download --resolve=no %s  (needs dnf-plugins-core; as the agent user)" % " ".join(pk),
                "rpm2cpio <each .rpm> | cpio -idmu  in %s/%d  (unpacks files only: no scripts run)" % (root, major)]
        bindir = "%s/%d/usr/pgsql-%d/bin" % (root, major, major)
    if not os.path.isdir(root):
        parent = os.path.dirname(root.rstrip("/"))
        if not os.access(parent if os.path.isdir(parent) else "/", os.W_OK):
            blockers.append("the agent user cannot create %s: create it (owned by the agent user) or set install_dir to a writable path" % root)
    elif not os.access(root, os.W_OK):
        blockers.append("the agent user cannot write to %s" % root)
    plan["modes"]["private"] = {"possible": not blockers and avail is not False, "needs": ["network access to the package repository", "about 150-300 MB of disk under %s" % root], "commands": cmds,
                                "result_bindir": bindir, "blockers": blockers + common,
                                "warnings": ["libraries the packages depend on (libpq, libicu, openssl...) are taken from the system: if one is missing the check after unpacking says which",
                                             "the unpacked server is used ONLY for ephemeral recovery instances; it is not a database service"]}
    # ---- system
    sblock = []
    if not (f["root"] or f["sudo_nopasswd"]):
        sblock.append("needs root or passwordless sudo for the agent user: ask an administrator to run the commands below once")
    if fam == "debian":
        scmds = ["write 'create_main_cluster = false' to /etc/postgresql-common/createcluster.conf (only if the setting is absent), so the package does not create a cluster",
                 "DEBIAN_FRONTEND=noninteractive apt-get install -y %s" % " ".join(pk)]
        swarn = ["installs a PostgreSQL server package system-wide with its dependencies and a systemd unit template; changes the package database",
                 "the package may start a default service: pg_arca disables automatic cluster creation first, but check `pg_lsclusters` afterwards",
                 "uses the host's package repositories: a repository must provide PostgreSQL %d" % major]
    else:
        scmds = ["dnf install -y %s" % " ".join(pk)]
        swarn = ["installs a PostgreSQL server package system-wide with its dependencies", "the RPM does not initialise or start a cluster by itself; do not run `postgresql-%d-setup initdb`" % major]
    plan["modes"]["system"] = {"possible": not sblock and avail is not False, "needs": ["root or passwordless sudo", "network access to the package repository"], "commands": scmds,
                               "result_bindir": ("/usr/lib/postgresql/%d/bin" % major) if fam == "debian" else ("/usr/pgsql-%d/bin" % major), "blockers": sblock + common, "warnings": swarn}
    plan["recommended"] = "private" if plan["modes"]["private"]["possible"] else ("system" if plan["modes"]["system"]["possible"] else None)
    return plan


def install(major, mode, eph=None, facts=None, progress=None, run=None, available=None):
    """Execute install_plan()'s `mode`. Returns {installed_bindir, ...}. Raises EngineError with the exact reason (and what to do) when it cannot."""
    eph = eph or {}
    run = run or _run
    f = facts or host_facts()
    plan = install_plan(major, eph, f, available=available)
    m = (plan.get("modes") or {}).get(mode)
    if not m:
        raise EngineError("PGA-INS-001", plan.get("blocked") or "unknown install mode %r" % mode)
    if not m["possible"]:
        raise EngineError("PGA-INS-002", "cannot install PostgreSQL %d (%s): %s" % (major, mode, "; ".join(m["blockers"]) or "not possible"))
    fam = f["family"]
    pk = _pkgs(fam, major)
    if mode == "system":
        pre = [] if f["root"] else ["sudo", "-n"]
        if progress:
            progress({"phase": "install", "mode": "system"})
        if fam == "debian":
            conf = "/etc/postgresql-common/createcluster.conf"
            have = _read(conf)
            if not re.search(r"^\s*create_main_cluster\s*=", have, re.M):
                rc, out = run(pre + ["sh", "-c", "mkdir -p /etc/postgresql-common && echo 'create_main_cluster = false' >> %s" % conf])
                if rc != 0:
                    raise EngineError("PGA-INS-003", "cannot write %s: %s" % (conf, out.strip()[:300]))
            rc, out = run(pre + ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-o", "Dpkg::Options::=--force-confold"] + pk, timeout=1800)
        else:
            rc, out = run(pre + [shutil.which("dnf") or "yum", "install", "-y"] + pk, timeout=1800)
        if rc != 0:
            raise EngineError("PGA-INS-004", "package installation failed: %s" % out.strip()[-600:])
        found = [i for i in scan_installations(eph) if i["major"] == major and i["complete"]]
        if not found:
            raise EngineError("PGA-INS-005", "the packages installed but no complete PostgreSQL %d bin directory was found" % major, "check `%s`" % m["result_bindir"])
        return {"mode": "system", "bindir": found[0]["bindir"], "version": found[0]["version"]}
    # ---- private
    root = eph.get("install_dir") or PRIVATE_ROOT
    prefix = os.path.join(root, str(major))
    try:
        os.makedirs(root, mode=0o755, exist_ok=True)
    except OSError as e:
        raise EngineError("PGA-INS-006", "cannot create %s: %s" % (root, e))
    work = tempfile.mkdtemp(prefix=".dl-", dir=root)
    try:
        if progress:
            progress({"phase": "download", "mode": "private"})
        if fam == "debian":
            rc, out = run(["apt-get", "download"] + pk, cwd=work, timeout=1800)
        else:
            rc, out = run([shutil.which("dnf") or "yum", "download", "--destdir", work] + pk, cwd=work, timeout=1800)
        if rc != 0:
            raise EngineError("PGA-INS-007", "download failed: %s" % out.strip()[-600:], "the agent user needs network access to the repository and up-to-date package lists (apt update by an administrator)")
        pkgs = sorted(glob.glob(os.path.join(work, "*.deb" if fam == "debian" else "*.rpm")))
        if not pkgs:
            raise EngineError("PGA-INS-008", "nothing was downloaded")
        if progress:
            progress({"phase": "unpack", "mode": "private"})
        tmp_prefix = prefix + ".new"
        shutil.rmtree(tmp_prefix, ignore_errors=True)
        os.makedirs(tmp_prefix, mode=0o755)
        for pkg in pkgs:
            if fam == "debian":
                rc, out = run(["dpkg-deb", "-x", pkg, tmp_prefix])
            else:
                rc, out = run(["sh", "-c", "rpm2cpio %s | cpio -idmu --quiet" % _shq(pkg)], cwd=tmp_prefix)
            if rc != 0:
                shutil.rmtree(tmp_prefix, ignore_errors=True)
                raise EngineError("PGA-INS-009", "unpacking %s failed: %s" % (os.path.basename(pkg), out.strip()[-400:]))
        shutil.rmtree(prefix, ignore_errors=True)
        os.rename(tmp_prefix, prefix)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    found = [i for i in scan_installations(eph, private_root=root) if i["major"] == major and i["source"] == "private"]
    if not found:
        raise EngineError("PGA-INS-010", "the packages were unpacked but no PostgreSQL %d binaries work from %s" % (major, prefix),
                          "run `ldd` on %s/**/bin/postgres to see which system library is missing" % prefix)
    i = found[0]
    if not i["complete"]:
        raise EngineError("PGA-INS-011", "unpacked, but these tools are missing: %s" % ", ".join(i["missing_tools"]))
    return {"mode": "private", "bindir": i["bindir"], "version": i["version"]}


def _shq(s):
    return "'" + str(s).replace("'", "'\\''") + "'"


# ============================================================================================================== preflight
def _free(path):
    p = path
    while p and not os.path.exists(p):
        p = os.path.dirname(p)
    st = os.statvfs(p or "/")
    return st.f_bavail * st.f_frsize


def _dev(path):
    p = path
    while p and not os.path.exists(p):
        p = os.path.dirname(p)
    try:
        return os.stat(p or "/").st_dev
    except OSError:
        return None


def preflight(ctx, major=None, eph=None, need_bytes=None, facts=None, with_plan=True):
    """Can this host run an ephemeral instance for a backup of PostgreSQL `major`? Every finding carries what to do about it.
    `ctx` supplies the scratch directory, the repository and the data directory (for the 'same disk' warning); `need_bytes` is the extraction size from a restore plan."""
    eph = eph or getattr(ctx, "eph", None) or {}
    f = facts or host_facts()
    checks = []

    def add(cid, level, text, fix=None, **extra):
        d = {"id": cid, "level": level, "text": text}
        if fix:
            d["fix"] = fix
        d.update(extra)
        checks.append(d)
    scratch = eph.get("scratch_dir") or ctx.scratch_dir
    # ---- who runs it
    if f["root"]:
        add("user", "bad", "the agent runs as root: PostgreSQL refuses to start as root", "run the agent as the postgres OS user")
    else:
        add("user", "ok", "runs as an unprivileged user (uid %d)" % f["euid"])
    # ---- binaries
    insts = scan_installations(eph)
    if major is None:
        major = _int_major(ctx)
    chosen = None
    if major:
        bindir, src = pick_bindir(major, eph, ctx.conn.bindir)
        i = _inst(bindir, src) if bindir else None
        if i and i["major"] == major and i["complete"]:
            chosen = i
            add("binaries", "ok", "PostgreSQL %d binaries found in %s (%s)" % (major, bindir, {"configured": "configured", "node": "this node's own", "system": "installed package", "private": "installed by pg_arca"}.get(src, src)))
        elif i and i["major"] == major:
            add("binaries", "bad", "PostgreSQL %d found in %s but tools are missing: %s" % (major, bindir, ", ".join(i["missing_tools"])), "install the server and client packages for PostgreSQL %d" % major)
        else:
            others = sorted({x["major"] for x in insts})
            add("binaries", "bad", "no PostgreSQL %d binaries on this host%s" % (major, (" (found: %s)" % ", ".join(str(o) for o in others)) if others else ""),
                "install PostgreSQL %d: see the installation plan below" % major, missing_major=major)
    else:
        add("binaries", "warn", "the PostgreSQL major version of the backups is not known yet (no backup in the repository?)")
    # ---- scratch
    try:
        os.makedirs(scratch, mode=0o700, exist_ok=True)
        ok_w = os.access(scratch, os.W_OK)
    except OSError:
        ok_w = False
    if not ok_w:
        add("scratch", "bad", "scratch directory %s is not writable" % scratch, "set a writable scratch directory (not a system directory)")
    else:
        free = _free(scratch)
        if need_bytes and free < need_bytes * 1.15:
            add("scratch", "bad", "scratch %s has %s free but about %s are needed" % (scratch, _hum(free), _hum(int(need_bytes * 1.15))), "free space, or point the scratch directory to a bigger volume", free=free)
        else:
            add("scratch", "ok", "scratch %s: %s free%s" % (scratch, _hum(free), (" (needs about %s)" % _hum(int(need_bytes * 1.15))) if need_bytes else ""), free=free)
        sd = _dev(scratch)
        for what, p in (("the live data directory", ctx.pgdata), ("the backup repository", ctx.repo.path)):
            if p and sd is not None and sd == _dev(p):
                add("disk_" + ("data" if "data" in what else "repo"), "warn", "scratch is on the same filesystem as %s: extraction and recovery compete for its I/O" % what,
                    "use a scratch directory on another volume (a fast local disk is best)")
    # ---- memory
    sb = int(eph.get("shared_buffers_mb") or 256)
    if f["mem_available"] is not None:
        need = (sb + 256) * 1048576
        if f["mem_available"] < need:
            add("memory", "warn", "%s of memory available, an ephemeral instance with shared_buffers=%d MB wants about %s" % (_hum(f["mem_available"]), sb, _hum(need)), "lower shared_buffers_mb or free memory")
        else:
            add("memory", "ok", "%s of memory available (ephemeral instance: about %s)" % (_hum(f["mem_available"]), _hum(need)))
    # ---- port
    try:
        p = free_port(eph)
        add("port", "ok", "a free port is available (%s)" % ("%d-%d" % (eph["port_min"], eph["port_max"]) if eph.get("port_min") else "any, listening on 127.0.0.1 only"))
    except EngineError as e:
        add("port", "bad", e.message, e.hint if hasattr(e, "hint") else None)
    # ---- repository + WAL archive readable from here (matters when the instance runs on another node than the backups)
    for cid, label, p in (("repo", "backup repository", ctx.repo.path), ("wal", "WAL archive", ctx.wal_dir)):
        if p and os.path.isdir(p) and os.access(p, os.R_OK | os.X_OK):
            add(cid, "ok", "%s readable: %s" % (label, p))
        else:
            add(cid, "bad", "%s %s is not readable from this host" % (label, p), "for a central recovery host mount the repository and the archive (NFS/SMB) at the same paths, read access is enough")
    # ---- can it be installed?
    plan = None
    if with_plan and major and chosen is None:
        plan = install_plan(major, eph, f)
    worst = "bad" if any(c["level"] == "bad" for c in checks) else ("warn" if any(c["level"] == "warn" for c in checks) else "ok")
    return {"ok": worst != "bad", "level": worst, "major": major, "checks": checks, "host": {k: f[k] for k in ("os", "family", "root", "sudo_nopasswd", "cpus", "mem_total", "mem_available")},
            "chosen": chosen, "installations": insts, "install_plan": plan, "settings": eph, "scratch_dir": scratch}


def _int_major(ctx):
    """Major version of the backups (newest complete set), else of the live data directory."""
    try:
        from pg_arca.pgcompat import set_profile
        for meta in reversed(ctx.repo.complete_sets()):
            pr = set_profile(meta)
            if pr is not None:
                return int(pr.major)
    except Exception:
        pass
    try:
        with open(os.path.join(ctx.pgdata, "PG_VERSION")) as f:
            return int(f.read().strip().split(".")[0])
    except (IOError, OSError, ValueError):
        return None


def _hum(n):
    n = float(n)
    for u in ("B", "KiB", "MiB", "GiB", "TiB"):
        if n < 1024 or u == "TiB":
            return ("%.0f %s" % (n, u)) if u == "B" else ("%.1f %s" % (n, u))
        n /= 1024.0
