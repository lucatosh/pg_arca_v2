"""Restart/start of a PostgreSQL systemd unit for an agent that may not ask systemd itself.

The agent runs unprivileged and with NoNewPrivileges (no sudo, no setuid helper). On most systems polkit authorizes it through a JavaScript rule limited
to the PostgreSQL units; polkit before 0.106 (Debian <= 11, Ubuntu <= 22.04) has no JavaScript rules, and its .pkla files cannot name a unit. There the
installer adds this bridge instead:

  pg-arca-pgctl.path     watches /run/pg-arca-ctl/*.req  (directory 1733 root: anyone may drop a file, nobody may list or touch another user's file)
  pg-arca-pgctl.service  root, oneshot: runs `python3 -I <this file> --serve`

Each request is a small JSON file {"verb", "unit"} written by the agent. The root side accepts it only when the FILE OWNER is one of the agent users
listed in /etc/pg-arca-pgctl.users, the verb is restart or start and the unit is a PostgreSQL unit known to systemd; the answer {"rc", "out"} is written
next to it as <id>.done, owned by the requester. Stdlib only, Python 3.6+, self-contained (run with -I as root: nothing imported from the agent)."""
import json
import os
import re
import stat
import subprocess
import sys
import time
import uuid

CTL_DIR = "/run/pg-arca-ctl"
USERS_FILE = "/etc/pg-arca-pgctl.users"
UNIT_RE = re.compile(r"^postgresql(?:[@-][A-Za-z0-9_.@-]+)?\.service$")
VERBS = ("restart", "start")


# ---------------------------------------------------------------- agent side
def available(ctl_dir=CTL_DIR, runner=subprocess.run):
    """True when the bridge is installed and its path unit watches the directory."""
    try:
        st = os.stat(ctl_dir)
    except OSError:
        return False
    if st.st_uid != 0 or not stat.S_ISDIR(st.st_mode) or (st.st_mode & 0o7777) != 0o1733:
        return False                                   # not the directory the installer made: never hand a request to it
    try:
        r = runner(["systemctl", "is-active", "pg-arca-pgctl.path"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return (r.stdout or "").strip() == "active"


def request(verb, unit, timeout=600, ctl_dir=CTL_DIR, poll=0.5):
    """Ask the root side; returns (rc, out). rc 124 when no answer came in time (the request may still run: the caller says so)."""
    rid = uuid.uuid4().hex
    tmp = os.path.join(ctl_dir, ".%s.tmp" % rid)
    req = os.path.join(ctl_dir, "%s.req" % rid)
    done = os.path.join(ctl_dir, "%s.done" % rid)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"verb": verb, "unit": unit}, f)
    os.rename(tmp, req)                                # appears whole: the path unit fires on *.req only
    end = time.time() + timeout + 30
    while time.time() < end:
        if os.path.exists(done):
            try:
                with open(done, "r") as f:
                    ans = json.load(f)
            except (OSError, ValueError):
                time.sleep(poll)
                continue
            try:
                os.unlink(done)
            except OSError:
                pass
            return int(ans.get("rc", 1)), str(ans.get("out") or "")
        time.sleep(poll)
    try:
        os.unlink(req)                                 # not picked up at all: withdrawn (when it was picked up, the unlink fails harmlessly)
    except OSError:
        pass
    return 124, "no answer from pg-arca-pgctl within %ss (systemctl status pg-arca-pgctl.path pg-arca-pgctl.service)" % (timeout + 30)


# ---------------------------------------------------------------- root side
def _allowed_users(path=USERS_FILE):
    try:
        st = os.stat(path)
        if st.st_uid != 0 or st.st_mode & 0o022:
            return set()                               # a list someone else could edit is no list
        with open(path, "r") as f:
            return set(x.strip() for x in f if x.strip() and not x.startswith("#"))
    except OSError:
        return set()


def _known_unit(unit, runner):
    r = runner(["systemctl", "show", "-p", "LoadState", "--value", unit], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=30)
    return (r.stdout or "").strip() == "loaded"


def _answer(ctl_dir, rid, uid, ans):
    tmp = os.path.join(ctl_dir, ".%s.%s.ans" % (rid, uuid.uuid4().hex))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(ans, f)
    os.chown(tmp, uid, -1)
    os.rename(tmp, os.path.join(ctl_dir, "%s.done" % rid))


def handle(ctl_dir=CTL_DIR, users=None, runner=subprocess.run, getpwuid=None, log=None):
    """Process every pending request once. Returns [(rid, user, verb, unit, rc)]."""
    import pwd
    getpwuid = getpwuid or (lambda uid: pwd.getpwuid(uid).pw_name)
    users = _allowed_users() if users is None else users
    log = log or (lambda m: sys.stderr.write(m + "\n"))
    out = []
    for name in sorted(os.listdir(ctl_dir)):
        if not name.endswith(".req"):
            continue
        rid = name[:-4]
        p = os.path.join(ctl_dir, name)
        try:
            st = os.lstat(p)
            if not stat.S_ISREG(st.st_mode) or not re.match(r"^[0-9a-f]{32}$", rid) or st.st_size > 4096:
                os.unlink(p)
                continue
            fd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            with os.fdopen(fd, "r") as f:
                st = os.fstat(f.fileno())                # the owner of what is READ (not of what was looked at a moment before)
                if not stat.S_ISREG(st.st_mode):
                    raise ValueError("not a regular file")
                body = json.loads(f.read(4097))
            os.unlink(p)
        except (OSError, ValueError):
            try:
                os.unlink(p)
            except OSError:
                pass
            continue
        try:
            user = getpwuid(st.st_uid)
        except KeyError:
            user = str(st.st_uid)
        verb, unit = str(body.get("verb") or ""), str(body.get("unit") or "")
        if user not in users:
            rc, msg = 77, "user %s is not allowed (not in %s)" % (user, USERS_FILE)
        elif verb not in VERBS:
            rc, msg = 77, "verb %r not allowed (only restart, start)" % verb
        elif not UNIT_RE.match(unit) or "@." in unit:
            rc, msg = 77, "%r is not a PostgreSQL unit" % unit
        elif not _known_unit(unit, runner):
            rc, msg = 77, "unit %s is not known to systemd" % unit
        else:
            try:
                r = runner(["systemctl", verb] + (["--no-block"] if verb == "start" else []) + [unit], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           universal_newlines=True, timeout=900)
                rc, msg = r.returncode, (r.stdout or "")[-2000:]
            except (OSError, subprocess.SubprocessError) as e:
                rc, msg = 1, str(e)
        log("pg-arca-pgctl: %s %s %s by %s -> %s" % (rid, verb, unit, user, rc))
        try:
            _answer(ctl_dir, rid, st.st_uid, {"rc": rc, "out": msg})
        except OSError as e:
            log("pg-arca-pgctl: cannot answer %s: %s" % (rid, e))
        out.append((rid, user, verb, unit, rc))
    # answers nobody collected (the agent gave up or died): removed after an hour
    now = time.time()
    for name in os.listdir(ctl_dir):
        if name.endswith(".done") or name.endswith(".tmp") or name.endswith(".ans"):
            try:
                if now - os.lstat(os.path.join(ctl_dir, name)).st_mtime > 3600:
                    os.unlink(os.path.join(ctl_dir, name))
            except OSError:
                pass
    return out


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve"]:
        if os.geteuid() != 0:
            sys.exit("pg-arca-pgctl: runs as root (from pg-arca-pgctl.service)")
        handle()
    else:
        sys.exit("usage: python3 -I pgctl_bridge.py --serve   (started by pg-arca-pgctl.path)")
