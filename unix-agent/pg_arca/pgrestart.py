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


def systemd_permission(polkit_dir="/etc/polkit-1", rule_file=None, euid=None, running=None):
    """None when the agent may restart a PostgreSQL unit (root, or the polkit rule the installer writes is there); otherwise why not and what to do."""
    if (os.geteuid() if euid is None else euid) == 0:
        return None
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
        perm = systemd_permission()
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
        r = runner(["systemctl", "restart", p["unit"]], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)
        if r.returncode != 0:
            err = (r.stderr or r.stdout or "").strip()
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
