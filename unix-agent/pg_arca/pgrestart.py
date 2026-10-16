"""Restart of a standalone PostgreSQL (no Patroni) from the console, done the way that server is really managed:

  - postmaster inside a systemd service (postgresql@14-main, postgresql-16, postgresql...)  -> `systemctl restart <that unit>` (needs the polkit rule the
    installer writes: the agent's user may restart/start ONLY PostgreSQL units; without it the error says exactly what to add)
  - no systemd around it and the agent not under systemd either (containers, hand-made setups)  -> `pg_ctl restart` with the options it was started with
  - postmaster started by hand while the agent is a systemd service  -> refused: a pg_ctl restart from the agent would move PostgreSQL into the agent's
    service, and restarting the agent would then stop the database.
Nothing here decides WHETHER to restart: the console asks (typed confirmation) and the executor refuses on Patroni members (patroni_restart is the way)."""
import os
import re
import subprocess

from pg_arca import pgctl_bridge

UNIT_RE = re.compile(r"/([^/\s]+\.service)(?:/[^/\s]*)?\s*$")
PG_UNIT_RE = re.compile(r"^postgresql(?:[@-][A-Za-z0-9_.@-]+)?\.service$")
POLKIT_FILE = "/etc/polkit-1/rules.d/50-pg-arca-restart.rules"


def polkit_rule(user):
    return ("// pg_arca: the agent (user %s) may restart/start the PostgreSQL services of this server, nothing else\n"
            "polkit.addRule(function(action, subject) {\n"
            "  if (action.id == \"org.freedesktop.systemd1.manage-units\" && subject.user == \"%s\" &&\n"
            "      /^postgresql([@-][A-Za-z0-9_.@-]+)?\\.service$/.test(action.lookup(\"unit\")) &&\n"
            "      (action.lookup(\"verb\") == \"restart\" || action.lookup(\"verb\") == \"start\")) {\n"
            "    return polkit.Result.YES;\n"
            "  }\n"
            "});\n" % (user, user))


def unit_of_pid(pid, proc="/proc"):
    """The systemd service a process belongs to (cgroup v1 or v2), or None."""
    try:
        with open(os.path.join(proc, str(pid), "cgroup"), "r") as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    for ln in lines:                                   # v2: "0::/system.slice/x.service"; v1: "1:name=systemd:/system.slice/x.service"
        parts = ln.split(":", 2)
        if len(parts) == 3 and (parts[0] == "0" or "systemd" in parts[1]):
            m = UNIT_RE.search(parts[2])
            if m:
                return m.group(1)
    return None


def postmaster_pid(data_dir):
    try:
        with open(os.path.join(data_dir, "postmaster.pid"), "r") as f:
            return int(f.readline().strip())
    except (OSError, ValueError):
        return None


def polkit_running(runner=subprocess.run):
    """True/False when systemd can tell whether the polkit service runs, None when it cannot be asked."""
    try:
        r = runner(["systemctl", "is-active", "polkit"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return (r.stdout or "").strip() == "active"


def polkit_version(runner=subprocess.run):
    """(major, minor) of the installed polkit, None when unknown. Before 0.106 polkit has no JavaScript rules (Debian <= 11, Ubuntu <= 22.04): the rule
    file the installer writes is silently ignored there, and the installer adds the pg-arca-pgctl bridge instead (pgctl_bridge.py)."""
    try:
        r = runner(["pkaction", "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"(\d+)(?:\.(\d+))?", r.stdout or "")
    return (int(m.group(1)), int(m.group(2) or 0)) if m else None


def legacy_polkit(version):
    return version is not None and version < (0, 106)


def systemctl_args(verb, unit):
    return [verb] + (["--no-block"] if verb == "start" else []) + [unit]


def use_bridge(euid=None, bridge=None):
    """True when systemctl restart/start of a PostgreSQL unit goes through the root-side pg-arca-pgctl bridge (installed where polkit cannot do it)."""
    if (os.geteuid() if euid is None else euid) == 0:
        return False
    return pgctl_bridge.available() if bridge is None else bridge


def systemctl(verb, unit, timeout=180, runner=None, euid=None, bridge=None):
    """Run `systemctl <verb> <unit>` the way this host allows it; returns (rc, stdout, stderr)."""
    if runner is None and use_bridge(euid, bridge):
        rc, out = pgctl_bridge.request(verb, unit, timeout=timeout)
        return rc, ("" if rc else out), (out if rc else "")
    run = runner or subprocess.run
    try:
        r = run(["systemctl"] + systemctl_args(verb, unit), stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "", str(e)
    return r.returncode, r.stdout or "", r.stderr or ""


def systemd_permission(polkit_dir="/etc/polkit-1", rule_file=None, euid=None, running=None, unit=None, verb="restart", polkit=None, bridge=None):
    """None when the agent may restart a PostgreSQL unit (root, the pg-arca-pgctl bridge, or the polkit rule the installer writes); otherwise why not and
    what to do."""
    if (os.geteuid() if euid is None else euid) == 0:
        return None
    if use_bridge(euid, bridge):
        return None
    ver = polkit_version() if polkit is None else polkit
    if legacy_polkit(ver):
        return ("polkit %d.%d on this server ignores the rule file the installer writes (JavaScript rules need polkit 0.106 or later) and the "
                "pg-arca-pgctl bridge is not active (systemctl status pg-arca-pgctl.path): run the pg_arca installer again as root, "
                "or restart PostgreSQL yourself" % ver)
    if not os.path.isdir(polkit_dir):
        return ("polkit is not installed on this server, so the agent's user cannot restart system services: install it (apt-get install polkitd / "
                "dnf install polkit) and run the pg_arca installer again - or restart PostgreSQL yourself")
    if not os.path.exists(rule_file or POLKIT_FILE):
        return ("the polkit rule that lets the agent restart PostgreSQL units is missing (%s): run the pg_arca installer again as root, or restart PostgreSQL yourself"
                % (rule_file or POLKIT_FILE))
    if (polkit_running() if running is None else running) is False:
        # installed but not running (it failed to start, or it was never started): systemd waits for it and the restart times out
        return "the polkit service is installed but not running (systemctl status polkit), so systemd cannot authorize the restart: start it, or restart PostgreSQL yourself"
    return None


def plan(data_dir, proc="/proc", self_pid=None):
    """How this instance can be restarted: {'method': 'systemd'|'pg_ctl'|'refuse', 'unit', 'why'}."""
    pid = postmaster_pid(data_dir)
    if not pid or not os.path.exists(os.path.join(proc, str(pid))):
        return {"method": "refuse", "why": "PostgreSQL is not running from %s (no live postmaster.pid): start it the usual way" % data_dir}
    unit = unit_of_pid(pid, proc)
    mine = unit_of_pid(self_pid or os.getpid(), proc)
    if unit and PG_UNIT_RE.match(unit):
        out = {"method": "systemd", "unit": unit, "pid": pid}
        perm = systemd_permission(unit=unit)
        if perm:
            # said in the dry run, not only when the real restart fails: the agent's user may not restart system units
            out["allowed"] = False
            out["why"] = perm
            out["manual"] = "sudo systemctl restart %s" % unit
        return out
    if unit and unit == mine:
        return {"method": "pg_ctl", "pid": pid, "why": "PostgreSQL runs inside the agent's own service (container / test setup)"}
    if unit:
        return {"method": "refuse", "unit": unit, "pid": pid,
                "why": "PostgreSQL runs inside the service %s, which is not a PostgreSQL unit: restart it with that service's own tooling" % unit}
    if mine:
        return {"method": "refuse", "pid": pid,
                "why": "PostgreSQL was started by hand (outside systemd) while the agent is a systemd service: restarting it from the agent would tie the database "
                       "to the agent's service. Restart it the way it was started (or put it under systemd)"}
    return {"method": "pg_ctl", "pid": pid}


def run(p, data_dir, bindir, user, timeout=180, runner=subprocess.run, log_dir=None):
    """Execute the plan. Returns a short description; raises RuntimeError with the cause and the way out."""
    if p["method"] == "systemd":
        rc, sout, serr = systemctl("restart", p["unit"], timeout=timeout, runner=None if runner is subprocess.run else runner)
        if rc != 0:
            err = (serr or sout or "").strip() or "exit %s" % rc
            if re.search(r"(?i)interactive authentication|access denied|not authorized|authentication is required", err):
                polkit = os.path.isdir("/etc/polkit-1")
                raise RuntimeError("systemd refused the restart of %s for user %s (%s). Nothing was restarted. %s"
                                   "Or restart it yourself: sudo systemctl restart %s" % (
                                       p["unit"], user, err.splitlines()[-1][:160],
                                       ("Allow it once as root: run the pg_arca installer again, or write %s with:\n%s" % (POLKIT_FILE, polkit_rule(user))) if polkit else
                                       "polkit is not installed on this server: install it (apt-get install polkitd / dnf install polkit) and run the pg_arca installer again. ",
                                       p["unit"]))
            if re.search(r"(?i)method call timed out|connection timed out", err):
                raise RuntimeError("systemd did not answer the restart request of %s in time (%s): usually the polkit service is not running (systemctl status polkit). "
                                   "Check whether PostgreSQL was restarted (systemctl status %s) before trying again; or restart it yourself: sudo systemctl restart %s"
                                   % (p["unit"], err.splitlines()[0][:160], p["unit"], p["unit"]))
            raise RuntimeError("systemctl restart %s failed: %s" % (p["unit"], err[:400]))
        return "systemctl restart %s" % p["unit"]
    if p["method"] == "pg_ctl":
        exe = os.path.join(bindir, "pg_ctl") if bindir else "pg_ctl"
        # the new postmaster inherits pg_ctl's stdout/stderr: never a pipe (we would wait for its EOF forever) - a log file, in its own session
        log = os.path.join(log_dir or "/tmp", "postgresql-restarted-by-pg_arca.log")
        with open(log, "ab") as out:
            r = runner([exe, "restart", "-D", data_dir, "-m", "fast", "-w", "-t", str(min(timeout, 600))], stdout=out, stderr=subprocess.STDOUT,
                       stdin=subprocess.DEVNULL, start_new_session=True, timeout=timeout + 30)
        if r.returncode != 0:
            try:
                with open(log, "rb") as f:
                    f.seek(max(0, os.path.getsize(log) - 600))
                    tail = f.read().decode("utf-8", "replace")
            except OSError:
                tail = ""
            raise RuntimeError("pg_ctl restart failed (exit %s): %s" % (r.returncode, tail.strip()[-400:]))
        return "pg_ctl restart -m fast (server output without logging_collector: %s)" % log
    raise RuntimeError(p.get("why") or "restart not possible here")
