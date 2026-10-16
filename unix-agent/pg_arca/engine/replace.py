"""Whole-server restore that REPAIRS production (standalone PostgreSQL): the server is rebuilt next to its data directory, on the same volume, then the
production server is stopped, its data directory is renamed <pgdata>.pgarca-before-<ts> (kept: the way back) and the rebuilt one takes its path, the
server is started the way it is managed (its systemd unit, or pg_ctl with the options it ran with), recovers to the target and becomes the primary again.
If it does not come up, everything is put back as it was and started again. Patroni members are refused here (the cluster is replaced through Patroni).

Works with production DOWN too (that is often why the server is replaced): the unit is then found from the data directory, and the WAL that production
wrote but never archived (its pg_wal) is handed to the recovery when the target is 'the latest state', so nothing that was committed is lost.

Never touches: a data directory with tablespaces (their original locations belong to the live server)."""
import os
import re
import shlex
import shutil
import subprocess
import time

from pg_arca import pgrestart
from pg_arca.engine.pgsession import PgSession
from pg_arca.engine.util import Cancelled, EngineError, now_utc, read_file, tail_file

_PG_UNIT = pgrestart.PG_UNIT_RE
_SEG = re.compile(r"^[0-9A-F]{24}(\.partial)?$|^[0-9A-F]{8}\.history$")
KEPT_RE = re.compile(r"\.pgarca-(before|failed)-\d{14}$")


def staging_dir(pgdata):
    p = os.path.realpath(pgdata).rstrip("/")
    return "%s.pgarca-new-%s" % (p, now_utc().strftime("%Y%m%d%H%M%S"))


def _run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
        return r.returncode, r.stdout or "", r.stderr or ""
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "", str(e)


def find_unit(pgdata, runner=_run):
    """The PostgreSQL unit that runs this data directory, found WITHOUT the server running: RHEL-style units say PGDATA in their environment or
    command line, Debian's postgresql@<ver>-<cluster> point at /etc/postgresql/<ver>/<cluster>/postgresql.conf (data_directory)."""
    real = os.path.realpath(pgdata).rstrip("/")
    rc, out, _ = runner(["systemctl", "list-units", "--all", "--plain", "--no-legend", "--type=service", "postgresql*"])
    rc2, out2, _ = runner(["systemctl", "list-unit-files", "--plain", "--no-legend", "--type=service", "postgresql*"])
    if rc != 0 and rc2 != 0:
        return None
    names = []
    for ln in (out + "\n" + out2).splitlines():
        n = ln.split()[0] if ln.split() else ""
        if _PG_UNIT.match(n) and not n.endswith("@.service") and n not in names:
            names.append(n)
    for n in names:
        m = re.match(r"^postgresql@(\d+(?:\.\d+)?)-(.+)\.service$", n)
        if m:
            conf = "/etc/postgresql/%s/%s/postgresql.conf" % (m.group(1), m.group(2))
            try:
                with open(conf, "r", errors="replace") as f:
                    for ln in f:
                        mm = re.match(r"^\s*data_directory\s*=\s*'([^']+)'", ln)
                        if mm and os.path.realpath(mm.group(1)).rstrip("/") == real:
                            return n
            except OSError:
                pass
            continue
        rc, sh, _ = runner(["systemctl", "show", "-p", "Environment", "-p", "ExecStart", n])
        if rc == 0:
            for tok in re.split(r"[\s;=\"']+", sh):
                if tok.startswith("/") and os.path.realpath(tok).rstrip("/") == real:
                    return n
    return None


def how_managed(pgdata, unit_hint=None, runner=_run):
    """How production is stopped and started: {'method': 'systemd'|'pg_ctl', 'unit', 'alive', 'opts'}; raises when pg_arca cannot do it safely."""
    pid = pgrestart.postmaster_pid(pgdata)
    alive = bool(pid and os.path.exists("/proc/%d" % pid))
    opts = None
    try:
        opts = shlex.split(read_file(os.path.join(pgdata, "postmaster.opts"), first_line=True) or "")
    except (OSError, ValueError, TypeError):
        pass
    if alive and pid == 1:
        raise EngineError("PGA-RST-087", "PostgreSQL is the main process of this container: stopping it stops the container (and the agent with it)",
                          "restore a database or a table (they go back into the running server), or restore a copy of the server and swap it with the container's volume")
    if alive:
        p = pgrestart.plan(pgdata)
        if p["method"] == "refuse":
            raise EngineError("PGA-RST-070", p["why"], "replace the data directory by hand, or run PostgreSQL under its own systemd unit")
        out = {"method": p["method"], "alive": True, "opts": opts}
        if p.get("unit"):
            out["unit"] = p["unit"]
    else:
        unit = unit_hint if unit_hint and _PG_UNIT.match(unit_hint) else find_unit(pgdata, runner)
        out = {"method": "systemd", "unit": unit, "alive": False, "opts": opts} if unit else {"method": "pg_ctl", "alive": False, "opts": opts}
        if not unit and pgrestart.unit_of_pid(os.getpid()):
            raise EngineError("PGA-RST-070", "PostgreSQL is down and no systemd unit runs %s: starting it from the agent would tie the database to the agent's service" % pgdata,
                              "start PostgreSQL the usual way after the restore, or give its systemd unit")
    if out["method"] == "systemd" and os.geteuid() != 0:
        rc, sh, _ = runner(["systemctl", "show", "-p", "Restart", "--value", out["unit"]])
        if rc == 0 and sh.strip() == "always":
            # the agent stops the server with a signal (it may only START units): systemd would bring it back at once, on the wrong directory
            raise EngineError("PGA-RST-079", "the unit %s has Restart=always: stopped by the agent it would be restarted by systemd in the middle of the swap" % out["unit"],
                              "run the replacement with the agent as root, or set Restart=on-failure for the unit")
        perm = pgrestart.systemd_permission()
        if perm:
            raise EngineError("PGA-RST-071", "the agent cannot start %s: %s" % (out["unit"], perm), "run the pg_arca installer again (polkit rule), then retry")
    return out


def _sysctl(verb, unit, timeout=120):
    rc, out, err = _run(["systemctl", verb] + (["--no-block"] if verb == "start" else []) + [unit], timeout=timeout)
    if rc != 0:
        err = (err or out or "").strip()
        if re.search(r"(?i)interactive authentication|access denied|not authorized|authentication is required", err):
            raise EngineError("PGA-RST-071", "systemd refused '%s %s' to the agent's user (%s)" % (verb, unit, err.splitlines()[-1][:160]),
                              "upgrade the agent (run its installer again: the polkit rule then allows start of PostgreSQL units), or run: sudo systemctl %s %s" % (verb, unit))
        raise EngineError("PGA-RST-072", "systemctl %s %s failed: %s" % (verb, unit, err[:300]))


def _pg_ctl(bindir, args, timeout=900, log=None):
    exe = os.path.join(bindir, "pg_ctl") if bindir else "pg_ctl"
    out = open(log, "ab") if log else subprocess.DEVNULL
    try:
        r = subprocess.run([exe] + args, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True, timeout=timeout)
    finally:
        if log:
            out.close()
    return r.returncode


def _alive(pgdata):
    pid = pgrestart.postmaster_pid(pgdata)
    return bool(pid and os.path.exists("/proc/%d" % pid))


def stop(m, pgdata, bindir):
    if not m.get("alive"):
        return "already stopped"
    if m["method"] == "systemd" and os.geteuid() == 0:
        _sysctl("stop", m["unit"], timeout=600)
        return "systemctl stop %s" % m["unit"]
    # the agent's user owns the server: a fast shutdown by signal (pg_ctl stop). Under systemd the unit then simply ends (it only restarts on failure)
    rc = _pg_ctl(bindir, ["stop", "-D", pgdata, "-m", "fast", "-w", "-t", "300"], timeout=360)
    if rc != 0 and _alive(pgdata):
        raise EngineError("PGA-RST-073", "pg_ctl stop failed (exit %d): nothing was replaced" % rc)
    if m["method"] == "systemd":
        for _ in range(30):
            rc, out, _e = _run(["systemctl", "is-active", m["unit"]], timeout=10)
            if out.strip() not in ("active", "deactivating", "reloading"):
                break
            time.sleep(1)
    return "pg_ctl stop -m fast" + (" (unit %s now inactive)" % m["unit"] if m["method"] == "systemd" else "")


def _start_opts(opts):
    """The options production ran with (postmaster.opts), minus the program and the data directory (given explicitly)."""
    clean, skip = [], False
    for o in (opts or [])[1:]:
        if skip:
            skip = False
            continue
        if o == "-D":
            skip = True
            continue
        if o.startswith("-D") or o.startswith("--pgdata"):
            continue
        clean.append(o)
    return clean


def start(m, pgdata, bindir, log_dir):
    if m["method"] == "systemd":
        _sysctl("start", m["unit"])
        return "systemctl start %s" % m["unit"]
    args = ["start", "-D", pgdata, "-W", "-l", os.path.join(log_dir or "/tmp", "postgresql-started-by-pg_arca.log")]
    clean = _start_opts(m.get("opts"))
    if clean:
        args += ["-o", " ".join(shlex.quote(x) for x in clean)]
    rc = _pg_ctl(bindir, args, timeout=120)
    if rc != 0:
        raise EngineError("PGA-RST-074", "pg_ctl start failed (exit %d)" % rc)
    return "pg_ctl start"


def _wait_accepting(conn, seconds):
    """Wait until the server accepts connections (pg_ctl -W returns at once; right after a start it answers 'the database system is starting up').
    True when it answers; False after `seconds` (the caller reports what it knows, it does not fail the rollback on it)."""
    end = time.time() + seconds
    while time.time() < end:
        try:
            s = PgSession(conn.with_db("postgres"), read_only=True)
            try:
                s.scalar("SELECT 1")
                return True
            finally:
                s.close()
        except Exception:
            time.sleep(1)
    return False


def _state(conn, pgdata):
    """'in production', 'in archive recovery', 'shut down', ... (pg_controldata, labels forced to English)."""
    try:
        from pg_arca.engine.pgsession import run_tool
        rc, out, _err = run_tool(conn, "pg_controldata", ["-D", pgdata], timeout=30, extra_env={"LC_ALL": "C", "LANG": "C"})
        if rc == 0:
            for ln in out.splitlines():
                if ln.startswith("Database cluster state:"):
                    return ln.split(":", 1)[1].strip()
    except Exception:
        pass
    return ""


def wait_primary(conn, pgdata, progress=None, cancel=None, stall_sec=1800, grace=30):
    """Up, recovered to the target and promoted (a normal read-write primary again). Decided by the control file ('in production' with a live postmaster),
    so it works even when the agent's login role did not exist yet at the restored point in time. No fixed timeout: a long recovery is fine as long as
    it moves; it fails when the server dies or nothing moves for stall_sec."""
    t0 = last_move = time.time()
    seen = None
    while True:
        if cancel and cancel():
            raise Cancelled()
        alive = _alive(pgdata)
        st = _state(conn, pgdata) if alive else ""
        # the copied pg_control says 'in production' before the startup process even begins: the recovery is over only when the signal file is gone too
        # (removed at promotion; recovery.conf becomes recovery.done before 12)
        pending = any(os.path.exists(os.path.join(pgdata, f)) for f in ("recovery.signal", "recovery.conf"))
        if alive and st == "in production" and not pending:
            return round(time.time() - t0, 1)
        where = None
        try:
            s = PgSession(conn.with_db("postgres"), read_only=True)
            try:
                if s.scalar("SELECT pg_is_in_recovery()") == "f" and not pending:
                    return round(time.time() - t0, 1)
                where = s.scalar("SELECT COALESCE(pg_last_wal_replay_lsn()::text, '-')")
            finally:
                s.close()
        except EngineError:
            pass
        try:
            mark = (where, os.path.getmtime(os.path.join(pgdata, "global", "pg_control")), len(os.listdir(os.path.join(pgdata, "pg_wal"))))
        except OSError:
            mark = (where,)
        if mark != seen:
            seen, last_move = mark, time.time()
        if progress:
            progress({"phase": "recovery", "msg": "production recovering%s" % (": WAL applied up to %s" % where if where else " (starting up)")})
        if not alive and time.time() - t0 > grace:
            return None
        if time.time() - last_move > stall_sec:
            return None
        time.sleep(2)


def carry_wal(old, new):
    """WAL production wrote but did not archive yet (its pg_wal, after the stop): given to the recovery, which reads pg_wal when the archive has no more.
    Recycled segments with old contents are harmless (their page headers do not match, recovery stops there). Returns the number of files."""
    src, dst = os.path.join(old, "pg_wal"), os.path.join(new, "pg_wal")
    if not os.path.isdir(src) or not os.path.isdir(dst):
        return 0
    n = 0
    for f in sorted(os.listdir(src)):
        if _SEG.match(f) and not os.path.exists(os.path.join(dst, f)):
            shutil.copy2(os.path.join(src, f), os.path.join(dst, f))
            n += 1
    return n


def swap_blocker(pgdata):
    """None when the data directory can be swapped by renaming it; else the EngineError that says why not - found BEFORE production is stopped.
    A data directory that is itself a mount point cannot be renamed (EBUSY): stopping production and then failing the rename left it down."""
    real = os.path.realpath(pgdata).rstrip("/")
    try:
        mounted = os.path.ismount(real) or os.stat(real).st_dev != os.stat(os.path.dirname(real)).st_dev
    except OSError as e:
        return EngineError("PGA-RST-089", "cannot inspect the data directory %s: %s" % (real, e))
    if mounted:
        return EngineError("PGA-RST-089", "the data directory %s is a mount point: it cannot be swapped in place (a mount point cannot be renamed)" % real,
                           "restore the whole server as a copy and move it onto the volume by hand, or restore the databases you need (they go back in place)")
    return None


def wal_to_carry(old):
    """(files, bytes) of production's pg_wal that the recovery must be given after the stop (see carry_wal)."""
    src = os.path.join(old, "pg_wal")
    n = b = 0
    try:
        for f in os.listdir(src):
            if _SEG.match(f):
                n += 1
                b += os.path.getsize(os.path.join(src, f))
    except OSError:
        pass
    return n, b


def _own_like(tree, ref):
    """An agent running as root writes root-owned files: PostgreSQL refuses to start on them ('wrong ownership'). Give the rebuilt tree the owner of
    the data directory it replaces (no-op for any other agent user: it cannot chown, and its files are already its own)."""
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return
    st = os.stat(ref)
    for cur, dirs, files in os.walk(tree, followlinks=False):
        for x in [cur] + [os.path.join(cur, d) for d in dirs] + [os.path.join(cur, f) for f in files]:
            os.lchown(x, st.st_uid, st.st_gid)


def swap_in(ctx, staged, m, bindir, log_dir, progress=None, cancel=None, latest=False, stall_sec=1800):
    """Stop production, put the rebuilt data directory in its place, start, wait. On failure: back as it was and started again (if it was running)."""
    pgdata = os.path.realpath(ctx.pgdata).rstrip("/")
    staged = os.path.realpath(staged)
    if os.path.dirname(staged) != os.path.dirname(pgdata) or os.stat(staged).st_dev != os.stat(os.path.dirname(pgdata)).st_dev:
        raise EngineError("PGA-RST-075", "the rebuilt data directory is not next to %s on the same volume: it cannot be swapped atomically" % pgdata)
    for f in ("PG_VERSION", "global/pg_control"):
        if not os.path.exists(os.path.join(staged, f)):
            raise EngineError("PGA-RST-080", "the rebuilt data directory %s is incomplete (%s missing): production was not touched" % (staged, f))
    blk = swap_blocker(pgdata)
    if blk:
        raise blk
    _own_like(staged, pgdata)
    if latest:
        # the WAL production has not archived is COPIED next to the rebuilt data (a hard link would let the new server overwrite the kept original's
        # segments when it recycles them): the volume must hold it, checked while production still runs (a full volume after the stop left it down)
        _n, need = wal_to_carry(pgdata)
        st = os.statvfs(os.path.join(staged, "pg_wal") if os.path.isdir(os.path.join(staged, "pg_wal")) else staged)
        if need and st.f_bavail * st.f_frsize < need * 1.1 + (256 << 20):
            raise EngineError("PGA-RST-090", "not enough free space next to the data directory to hand production's not yet archived WAL (%.1f GiB) to the "
                                             "recovery: production was not stopped" % (need / 2.0 ** 30),
                              "free space on that volume, or let the archiver catch up (then less WAL is left to carry), or restore to a point in time")
    old = "%s.pgarca-before-%s" % (pgdata, now_utc().strftime("%Y%m%d%H%M%S"))
    steps = []
    if progress:
        progress({"phase": "swap", "msg": "stopping production PostgreSQL"})
    steps.append(stop(m, pgdata, bindir))
    try:
        os.rename(pgdata, old)
    except OSError as e:
        # nothing moved: production back up as it was
        if m.get("alive"):
            start(dict(m, alive=False), pgdata, bindir, log_dir)
            _wait_accepting(ctx.conn, 120)
        raise EngineError("PGA-RST-091", "the data directory could not be moved aside (%s): production was started again on it, nothing changed" % e,
                          "check the directory's permissions and that nothing else (a mount, an open shell) holds it")
    try:
        os.rename(staged, pgdata)
    except OSError as e:
        os.rename(old, pgdata)
        if m.get("alive"):
            start(dict(m, alive=False), pgdata, bindir, log_dir)
            _wait_accepting(ctx.conn, 120)
        raise EngineError("PGA-RST-091", "the rebuilt data directory could not be put in place (%s): production was started again on its own data, nothing changed" % e)
    steps.append("data directory replaced (previous one kept as %s)" % old)
    try:
        if latest:
            n = carry_wal(old, pgdata)
            if n:
                steps.append("%d WAL file(s) production had not archived yet handed to the recovery" % n)
        if progress:
            progress({"phase": "swap", "msg": "starting production on the restored data"})
        steps.append(start(dict(m, alive=False), pgdata, bindir, log_dir))
        took = wait_primary(ctx.conn, pgdata, progress=progress, cancel=cancel, stall_sec=stall_sec)
        if took is None:
            raise EngineError("PGA-RST-076", "production did not come up on the restored data directory:\n%s" % _why(pgdata, log_dir))
        steps.append("primary again after %.0f s" % took)
        try:
            from pg_arca.engine.restore import scrub_recovery_settings
            scrub_recovery_settings(pgdata)          # the restore's target/restore_command must not follow this server into its next backups / standbys
            steps.append("recovery settings of the restore commented out in postgresql.auto.conf")
        except Exception:
            pass
        return {"replaced": True, "old_kept_as": old, "steps": steps, "data_directory": pgdata}
    except BaseException as e:
        # back as it was: the original data directory in place and started (what was running before the operation)
        try:
            stop(dict(m, alive=_alive(pgdata)), pgdata, bindir)
        except Exception:
            pass
        failed = "%s.pgarca-failed-%s" % (pgdata, now_utc().strftime("%Y%m%d%H%M%S"))
        try:
            os.rename(pgdata, failed)
            if latest:                                  # the carried WAL copies are also in the original: give their space back
                try:
                    for f in os.listdir(os.path.join(failed, "pg_wal")):
                        if _SEG.match(f) and os.path.exists(os.path.join(old, "pg_wal", f)):
                            os.unlink(os.path.join(failed, "pg_wal", f))
                except OSError:
                    pass
            os.rename(old, pgdata)
            if m.get("alive"):
                start(dict(m, alive=False), pgdata, bindir, log_dir)
                _wait_accepting(ctx.conn, 120)            # "back in place and started" is said once it really answers
        except Exception as e2:
            raise EngineError("PGA-RST-077", "replacement failed (%s) AND putting the original back failed (%s): the original data directory is %s"
                              % (getattr(e, "message", str(e))[:300], e2, old if os.path.exists(old) else pgdata), "start PostgreSQL by hand on the original data directory")
        if isinstance(e, EngineError):
            e.hint = ((e.hint or "") + " The original data directory is back in place%s; the rebuilt one is kept as %s for inspection."
                      % (" and started" if m.get("alive") else "", failed)).strip()
        raise


def _why(pgdata, log_dir):
    for f in (os.path.join(log_dir or "/tmp", "postgresql-started-by-pg_arca.log"), os.path.join(pgdata, "log"), os.path.join(pgdata, "pg_log")):
        if os.path.isfile(f):
            return tail_file(f, 20)
        if os.path.isdir(f):
            logs = sorted((os.path.join(f, x) for x in os.listdir(f)), key=os.path.getmtime)
            if logs:
                return tail_file(logs[-1], 20)
    return "(no server log found: see journalctl for the PostgreSQL unit)"


def kept(pgdata):
    """Data directories kept by replacements of this server (the way back, and disk space to give back)."""
    real = os.path.realpath(pgdata).rstrip("/")
    d, base = os.path.dirname(real), os.path.basename(real)
    out = []
    try:
        for x in sorted(os.listdir(d)):
            if x.startswith(base + ".pgarca-") and KEPT_RE.search(x) or x.startswith(base + ".pgarca-new-"):
                p = os.path.join(d, x)
                out.append({"path": p, "kind": "before" if ".pgarca-before-" in x else "failed" if ".pgarca-failed-" in x else "partial"})
    except OSError:
        pass
    return out


def drop_kept(pgdata, path):
    """A data directory kept by a replacement of THIS server, removed when the operator says so (only <pgdata>.pgarca-before/-failed/-new-<ts>)."""
    real = os.path.realpath(pgdata).rstrip("/")
    p = os.path.realpath(path or "")
    if not p.startswith(real + ".pgarca-") or not re.search(r"\.pgarca-(before|failed|new)-\d{14}$", p) or not os.path.isdir(p):
        raise EngineError("PGA-RST-078", "%s is not a data directory kept by a pg_arca replacement of %s" % (path, real))
    if os.path.exists(os.path.join(p, "postmaster.pid")) and _alive(p):
        raise EngineError("PGA-RST-078", "%s is running" % p)
    shutil.rmtree(p)
    return {"removed": p}
