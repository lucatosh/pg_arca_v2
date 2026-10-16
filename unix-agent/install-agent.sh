#!/usr/bin/env bash
# ==============================================================================
# pg_arca node agent installer — RHEL/Rocky/Alma 8-10, Debian, Ubuntu
#
#   curl -fsSL https://<console>/agent/install.sh | sudo \
#        PG_ARCA_URL=https://<console> PG_ARCA_ENROLL_TOKEN=arca_enr_... bash
#
# Idempotent: re-running upgrades the code and keeps config + credentials.
# Env:  PG_ARCA_URL (required on first install)   PG_ARCA_ENROLL_TOKEN (optional: without it the server announces itself and waits for approval in the web console)
#       PG_ARCA_NODE_NAME   PG_ARCA_TLS_CA=/path/ca.pem   PG_ARCA_BUNDLE_SHA256=<hex>
#       PG_ARCA_REPO=/var/lib/pgarca/repo   PG_ARCA_WAL=/var/lib/pgarca/wal   PG_ARCA_SCRATCH=/var/tmp/pg_arca_scratch
#       PG_ARCA_USER=<OS user that owns PostgreSQL; default: detected from the running server, else postgres>   PG_ARCA_PG_ROLE=<superuser role, only if unrelated to the OS user>
#       PG_ARCA_INSTANCE=<name> PG_ARCA_PGDATA=<data dir>   one more agent for ANOTHER PostgreSQL instance on the same server (several clusters on one host):
#                             own config /etc/pg-arca/<name>, state /var/lib/pgarca/<name>, service pg-arca-agent-<name>, node name <host>-<name>
#       PG_ARCA_ALLOW_PG_RESTART=0   do not let the agent restart PostgreSQL's systemd unit (default: allowed for the postgresql units only, through a polkit
#                             rule, or - polkit older than 0.106 or missing - the root-side pg-arca-pgctl bridge)
#       PG_ARCA_FORCE=1      uninstall although archiving through pg_arca is on / cannot be checked; upgrade although an agent is running an operation
#       PG_ARCA_NO_PKG=1     never install distribution packages (python3-zstandard, zstd, polkit): set by the .deb/.rpm, which declare them as dependencies
#       PG_ARCA_UNINSTALL=1  remove the agent (keeps backups/WAL; PG_ARCA_PURGE=1 deletes them too; refused while PostgreSQL archives through pg_arca)
#       PG_ARCA_ROLE=worker   operational machine (backup server, host for the recovery instances): no database is searched; runs as postgres if present, else as a
#                             dedicated system user "pgarca" created here
# ==============================================================================
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root (sudo)"
as_user() { if command -v runuser >/dev/null; then runuser -u "$PGUSER_OS" -- "$@"; else su -s /bin/sh "$PGUSER_OS" -c "$(printf '%q ' "$@")"; fi; }
conf_get() { [[ -f "$1" ]] && sed -n 's/.*"'"$2"'": *"\([^"]*\)".*/\1/p' "$1" | head -1 || true; }

# The agent must run as the OS user that OWNS the PostgreSQL server (postgres on Debian/RHEL, but also pgsql, enterprisedb, an application account...). Explicit PG_ARCA_USER wins;
# otherwise the owner of the running postmaster (oldest postgres/postmaster process), then "postgres".
detect_pg_user() {
  local u=""
  command -v ps >/dev/null && u="$(ps -eo user:32=,etimes=,comm= 2>/dev/null | awk '$3=="postgres"||$3=="postmaster"{print $2, $1}' | sort -rn | head -1 | awk '{print $2}')"
  [[ -n "$u" && "$u" != "root" ]] && id "$u" &>/dev/null && { echo "$u"; return; }
  echo postgres
}
# Re-run (upgrade, package upgrade, uninstall) on a host where the agent is already set up: the existing service user and role are the defaults,
# so a worker host running as "pgarca" (no postgres account) is not mistaken for a database server.
EXIST_UNIT=/etc/systemd/system/pg-arca-agent${PG_ARCA_INSTANCE:+-$PG_ARCA_INSTANCE}.service
EXIST_CONF=/etc/pg-arca${PG_ARCA_INSTANCE:+/$PG_ARCA_INSTANCE}/agent.conf
if [[ -n "${PG_ARCA_INSTANCE:-}" && -z "${PG_ARCA_PGDATA:-}" ]]; then PG_ARCA_PGDATA="$(conf_get "$EXIST_CONF" pg_data)"; [[ -n "$PG_ARCA_PGDATA" ]] && export PG_ARCA_PGDATA; fi
EXIST_ROLE=""; [[ -f "$EXIST_CONF" ]] && EXIST_ROLE="$(sed -n 's/.*"node_role": *"\([a-z]*\)".*/\1/p' "$EXIST_CONF" | head -1)"
EXIST_USER=""; [[ -f "$EXIST_UNIT" ]] && EXIST_USER="$(sed -n 's/^User=//p' "$EXIST_UNIT" | head -1)"
ROLE="${PG_ARCA_ROLE:-${EXIST_ROLE:-auto}}"
[[ "$ROLE" =~ ^(auto|database|worker)$ ]] || die "PG_ARCA_ROLE must be auto, database or worker"
if [[ -n "${PG_ARCA_USER:-}" ]]; then PGUSER_OS="$PG_ARCA_USER"
elif [[ -n "$EXIST_USER" ]] && id "$EXIST_USER" &>/dev/null; then PGUSER_OS="$EXIST_USER"; PG_ARCA_USER="$EXIST_USER"
elif [[ -n "${PG_ARCA_PGDATA:-}" && -d "${PG_ARCA_PGDATA:-}" ]]; then PGUSER_OS="$(stat -c %U "$PG_ARCA_PGDATA")"   # another instance: the owner of ITS data directory
else PGUSER_OS="$(detect_pg_user)"; fi
if [[ "$ROLE" == worker && -z "${PG_ARCA_USER:-}" ]] && ! id "$PGUSER_OS" &>/dev/null; then
  # a backup server / recovery host usually has no postgres account: a dedicated unprivileged system user
  PGUSER_OS=pgarca
  id pgarca &>/dev/null || useradd --system --create-home --home-dir /var/lib/pgarca --shell /bin/bash pgarca || die "cannot create the system user pgarca (set PG_ARCA_USER=...)"
fi
[[ -n "${PG_ARCA_USER:-}" ]] || echo "agent OS user: $PGUSER_OS (override with PG_ARCA_USER=...)"
id "$PGUSER_OS" &>/dev/null || die "OS user '$PGUSER_OS' not found. The agent must run as the PostgreSQL OS user (set PG_ARCA_USER=...)."
INSTALL_DIR=/opt/pg-arca; CONF_DIR=/etc/pg-arca; STATE_ROOT=/var/lib/pgarca; UNIT=pg-arca-agent
INST="${PG_ARCA_INSTANCE:-}"
if [[ -n "$INST" ]]; then
  [[ "$INST" =~ ^[a-z0-9][a-z0-9_-]{0,30}$ ]] || die "PG_ARCA_INSTANCE: lowercase letters, digits, - and _ (max 31)"
  [[ -n "${PG_ARCA_PGDATA:-}" ]] || die "PG_ARCA_INSTANCE needs PG_ARCA_PGDATA (the data directory of that instance)"
  CONF_DIR=/etc/pg-arca/$INST; STATE_ROOT=/var/lib/pgarca/$INST; UNIT=pg-arca-agent-$INST
  : "${PG_ARCA_NODE_NAME:=$(hostname -s)-$INST}"; export PG_ARCA_NODE_NAME
fi
# an existing configuration keeps its paths (re-run = upgrade); instances get their own scratch and log directories (they may run as other OS users)
REPO_DIR="${PG_ARCA_REPO:-$(conf_get "$CONF_DIR/agent.conf" repo_path)}"; REPO_DIR="${REPO_DIR:-$STATE_ROOT/repo}"
WAL_DIR="${PG_ARCA_WAL:-$(conf_get "$CONF_DIR/agent.conf" wal_archive_dir)}"; WAL_DIR="${WAL_DIR:-$STATE_ROOT/wal}"
SCRATCH="${PG_ARCA_SCRATCH:-$(conf_get "$CONF_DIR/agent.conf" scratch_dir)}"; SCRATCH="${SCRATCH:-/var/tmp/pg_arca_scratch${INST:+-$INST}}"
LOG_DIR=/var/log/pgarca${INST:+-$INST}
CTL_USERS=/etc/pg-arca-pgctl.users

# The polkit rule for every agent user of this host (several instances may run as different users): regenerated from $CTL_USERS.
write_polkit_rule() {
  [[ -d /etc/polkit-1 && -s "$CTL_USERS" ]] || return 0
  install -d -m 0755 /etc/polkit-1/rules.d
  { echo "// pg_arca: the agents (users listed in $CTL_USERS) may restart/start the PostgreSQL services of this server, nothing else (PG_ARCA_ALLOW_PG_RESTART=0 to disable)"
    echo "polkit.addRule(function(action, subject) {"
    echo "  var users = [$(sed 's/.*/"&"/' "$CTL_USERS" | paste -sd, -)];"
    echo '  if (action.id == "org.freedesktop.systemd1.manage-units" && users.indexOf(subject.user) >= 0 &&'
    echo '      /^postgresql([@-][A-Za-z0-9_.@-]+)?\.service$/.test(action.lookup("unit")) &&'
    echo '      (action.lookup("verb") == "restart" || action.lookup("verb") == "start")) {'
    echo "    return polkit.Result.YES;"
    echo "  }"
    echo "});"; } > /etc/polkit-1/rules.d/50-pg-arca-restart.rules.new
  chmod 0644 /etc/polkit-1/rules.d/50-pg-arca-restart.rules.new; mv /etc/polkit-1/rules.d/50-pg-arca-restart.rules.new /etc/polkit-1/rules.d/50-pg-arca-restart.rules
}

# Does THIS agent's PostgreSQL instance archive WAL through pg_arca? Prints yes | no | unknown:<why>. Asked to the running server (its own socket and port,
# from postmaster.pid) or, when it is down, read from its configuration files. Before an uninstall a wrong "no" fills pg_wal: unknown is a refusal.
archiving_state() {
  command -v python3 >/dev/null || { echo "unknown:python3 is missing"; return; }
  python3 - "$CONF_DIR/agent.conf" "$STATE_ROOT/state/instance.json" "${PG_ARCA_PGDATA:-}" "$PGUSER_OS" <<'PY'
import glob, json, os, re, shlex, shutil, subprocess, sys
conf, inst, pgd, user = sys.argv[1:5]
def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return {}
c, i = load(conf), load(inst)
pgd = pgd or c.get("pg_data") or i.get("data_directory") or ""
if not pgd:
    alive = subprocess.call("ps -eo comm= 2>/dev/null | grep -qx -e postgres -e postmaster", shell=True) == 0
    print("unknown:the data directory of this agent is not known (give PG_ARCA_PGDATA=<data directory>)" if alive else "no")
    sys.exit(0)
def verdict(mode, cmd):
    print("yes" if mode in ("on", "always") and "pg-arca-wal" in cmd else "no")
    sys.exit(0)
port = sock = None
try:
    L = open(os.path.join(pgd, "postmaster.pid")).read().splitlines()
    if os.path.exists("/proc/%d" % int(L[0])):
        port, sock = L[3].strip(), (L[4].strip().split(",")[0].strip() or "127.0.0.1")   # no unix socket: TCP on the loopback
except Exception:
    pass
if port:
    psql = shutil.which("psql") or (sorted(glob.glob("/usr/lib/postgresql/*/bin/psql") + glob.glob("/usr/pgsql-*/bin/psql") + glob.glob("/usr/local/pgsql/bin/psql")) or [None])[-1]
    if not psql:
        print("unknown:PostgreSQL runs but psql was not found"); sys.exit(0)
    cmd = [psql, "-XAtq", "-h", sock, "-p", port, "-d", "postgres"] + (["-U", c["pg_user"]] if c.get("pg_user") else []) + \
          ["-c", "select current_setting('archive_mode')||'|'||current_setting('archive_command')"]
    if os.geteuid() == 0 and user != "root":
        cmd = ["runuser", "-u", user, "--"] + cmd if shutil.which("runuser") else ["su", "-s", "/bin/sh", user, "-c", " ".join(shlex.quote(x) for x in cmd)]
    try:
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=30, cwd="/")
    except Exception as e:
        print("unknown:cannot ask the running server (%s)" % e); sys.exit(0)
    if r.returncode == 0 and "|" in r.stdout:
        verdict(*r.stdout.strip().split("|", 1))
    print("unknown:cannot ask the running server on port %s (%s)" % (port, (r.stderr or "").strip()[:200])); sys.exit(0)
# PostgreSQL is down: its configuration files, in the order the server reads them (Debian keeps the main one in /etc/postgresql)
files = []
for f in glob.glob("/etc/postgresql/*/*/postgresql.conf"):
    try:
        if re.search(r"^\s*data_directory\s*=\s*'%s/?'" % re.escape(os.path.realpath(pgd)), open(f).read(), re.M):
            files.append(f)
    except Exception:
        pass
files += [os.path.join(pgd, n) for n in ("postgresql.base.conf", "postgresql.conf", "postgresql.auto.conf")]
val = {"archive_mode": "off", "archive_command": ""}
for f in files:
    try:
        text = open(f).read()
    except Exception:
        continue
    for m in re.finditer(r"^\s*(archive_mode|archive_command)\s*=?\s*(?:'((?:[^']|'')*)'|([^\s#]+))", text, re.M):
        val[m.group(1)] = (m.group(2) if m.group(2) is not None else m.group(3)).replace("''", "'")
verdict(val["archive_mode"].lower(), val["archive_command"])
PY
}

# --- uninstall ------------------------------------------------------------------
# PG_ARCA_UNINSTALL=1: removes the agent (service, code, commands, polkit rule, configuration and console credentials) and KEEPS the backups and the WAL
# archive ($STATE_ROOT) unless PG_ARCA_PURGE=1. Refused while PostgreSQL still archives through pg-arca-wal: removing the command would make every
# archive attempt fail and pg_wal would grow until the disk is full. Switch archiving off (or to another tool) first, or PG_ARCA_FORCE=1.
if [[ "${PG_ARCA_UNINSTALL:-}" == 1 ]]; then
  if [[ "${PG_ARCA_FORCE:-}" != 1 ]]; then
    st="$(archiving_state 2>/dev/null || echo "unknown:the check failed")"
    [[ "$st" == yes ]] && die "PostgreSQL still archives WAL through this agent ($UNIT). Switch archiving off or to another tool first (then reload), or set PG_ARCA_FORCE=1."
    [[ "$st" == unknown:* ]] && die "cannot tell whether PostgreSQL still archives WAL through this agent ($UNIT): ${st#unknown:}. Removing the agent while it does fills pg_wal. Check archive_command, then re-run with PG_ARCA_FORCE=1."
  fi
  systemctl disable --now "$UNIT.service" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$UNIT.service"; systemctl daemon-reload 2>/dev/null || true
  # only this agent's own files: the main agent's directories (/etc/pg-arca, /var/lib/pgarca) are also the parents of the other instances' ones.
  # An encryption key kept in the configuration directory stays (the backups that are kept need it) unless the backups go too (PG_ARCA_PURGE=1).
  KEY="$(conf_get "$CONF_DIR/agent.conf" encryption_key_file)"
  rm -f "$CONF_DIR/agent.conf" "$CONF_DIR/credentials.json" "$CONF_DIR/enroll.env" "$CONF_DIR/agent.local.json" "$CONF_DIR/console-ca.pem" "$CONF_DIR"/*.tmp
  if [[ "${PG_ARCA_PURGE:-}" == 1 ]]; then
    [[ -n "$KEY" && "$(dirname "$KEY")" == "$CONF_DIR" ]] && rm -f "$KEY"
    rm -rf "$REPO_DIR" "$WAL_DIR" "$STATE_ROOT/state" "$SCRATCH"
    [[ -n "$INST" ]] && rm -rf "$STATE_ROOT"
    rmdir "$STATE_ROOT" 2>/dev/null || true
    echo "pg_arca agent $UNIT removed; its backups ($REPO_DIR) and WAL archive ($WAL_DIR) DELETED."
  else
    echo "pg_arca agent $UNIT removed. Backups ($REPO_DIR) and WAL archive ($WAL_DIR) are kept (PG_ARCA_PURGE=1 to delete them too). Remove the node from the console as well."
    [[ -n "$KEY" && -f "$KEY" ]] && echo "The encryption key of those backups is kept too: $KEY"
  fi
  rmdir "$CONF_DIR" 2>/dev/null || { [[ -d "$CONF_DIR" ]] && echo "NOTE: $CONF_DIR is kept (other files or instances in it)."; }
  # the shared parts (code, commands, restart permission) go with the LAST agent of this host, whichever it is
  LEFT=""; for f in /etc/systemd/system/pg-arca-agent.service /etc/systemd/system/pg-arca-agent-*.service /etc/pg-arca/agent.conf /etc/pg-arca/*/agent.conf; do [[ -e "$f" ]] && LEFT=1; done
  if [[ -z "$LEFT" ]]; then
    systemctl disable --now pg-arca-pgctl.path >/dev/null 2>&1 || true
    rm -rf "$INSTALL_DIR" /usr/local/bin/pg-arca-cli /usr/local/bin/pg-arca-wal /etc/polkit-1/rules.d/50-pg-arca-restart.rules /etc/sudoers.d/pg-arca-restart \
           /etc/systemd/system/pg-arca-pgctl.path /etc/systemd/system/pg-arca-pgctl.service /etc/tmpfiles.d/pg-arca-ctl.conf /run/pg-arca-ctl "$CTL_USERS"
    systemctl daemon-reload 2>/dev/null || true
  else
    echo "NOTE: other pg_arca agents on this server are left in place, and so is the shared code"
    if [[ -f "$CTL_USERS" ]] && ! grep -qx "User=$PGUSER_OS" /etc/systemd/system/pg-arca-agent*.service 2>/dev/null; then
      grep -vx "$PGUSER_OS" "$CTL_USERS" > "$CTL_USERS.new" || true; install -m 0644 "$CTL_USERS.new" "$CTL_USERS"; rm -f "$CTL_USERS.new"   # no agent runs as this user any more
      [[ -f /etc/polkit-1/rules.d/50-pg-arca-restart.rules ]] && write_polkit_rule
    fi
  fi
  exit 0
fi

# --- python + tools ------------------------------------------------------------
NOPKG="${PG_ARCA_NO_PKG:-}"
if ! command -v python3 >/dev/null; then
  [[ -z "$NOPKG" ]] || die "python3 missing"
  if command -v dnf >/dev/null; then dnf install -y -q python3; elif command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq python3; else die "python3 missing"; fi
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,6) else 1)' || die "Python >= 3.6 required"
# python zstandard: the chunk compressor of the backups. Without it the agent falls back to zlib, measured 5-10x slower per core on database pages
# (the lab: zlib ~16-80 MB/s per core). Debian/Ubuntu: python3-zstandard; RHEL/Rocky/Alma: python3-zstandard from EPEL (or AppStream on newer releases).
if [[ -z "$NOPKG" ]] && ! python3 -c 'import zstandard' 2>/dev/null && ! python3 -c 'from compression import zstd' 2>/dev/null; then
  { command -v apt-get >/dev/null && { apt-get install -y -qq python3-zstandard >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq python3-zstandard >/dev/null 2>&1; }; }; } || { command -v dnf >/dev/null && dnf install -y -q python3-zstandard >/dev/null 2>&1; } \
    || echo "WARN: python3-zstandard not available: backups will use zlib (much slower). Install python3-zstandard (EPEL on RHEL) or 'pip3 install zstandard' for the agent's python."
fi
if [[ -z "$NOPKG" ]] && ! command -v zstd >/dev/null; then
  { command -v dnf >/dev/null && dnf install -y -q zstd; } || { command -v apt-get >/dev/null && { apt-get install -y -qq zstd >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq zstd >/dev/null 2>&1; }; }; } || echo "WARN: zstd not installed; without python3-zstandard too, WAL segments are archived with gzip (slower)"
fi

# --- obtain the bundle ------------------------------------------------------------
SRC=""; [[ -f "${BASH_SOURCE[0]:-}" ]] && SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
[[ "$SRC" == "$INSTALL_DIR" ]] && SRC=""          # the installed copy is not a bundle to install from
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [[ -n "$SRC" && -d "$SRC/pg_arca" && -f "$SRC/pg-arca-agent.py" ]]; then
  BUNDLE="$SRC"
else
  [[ -n "${PG_ARCA_URL:-}" ]] || die "PG_ARCA_URL is required"
  CURL=(curl -fsSL --retry 3); [[ -n "${PG_ARCA_TLS_CA:-}" ]] && CURL+=(--cacert "$PG_ARCA_TLS_CA")
  "${CURL[@]}" "${PG_ARCA_URL%/}/agent/pg-arca-agent.tar.gz" -o "$TMP/agent.tgz" || die "cannot download the agent bundle from $PG_ARCA_URL"
  if [[ -n "${PG_ARCA_BUNDLE_SHA256:-}" ]]; then echo "${PG_ARCA_BUNDLE_SHA256}  $TMP/agent.tgz" | sha256sum -c - >/dev/null || die "bundle checksum mismatch"; fi
  mkdir "$TMP/b"
  if command -v tar >/dev/null; then tar xzf "$TMP/agent.tgz" -C "$TMP/b"
  else python3 -W ignore -c 'import sys, tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2])' "$TMP/agent.tgz" "$TMP/b"; fi      # minimal images (Rocky/RHEL containers) have no tar
  BUNDLE="$TMP/b"
fi

# --- an agent in the middle of an operation is not restarted under it: the upgrade puts new code in place and restarts EVERY agent of this host
if [[ "${PG_ARCA_FORCE:-}" != 1 ]] && command -v python3 >/dev/null && ls /etc/systemd/system/pg-arca-agent*.service >/dev/null 2>&1; then
  BUSY="$(python3 - /etc/systemd/system/pg-arca-agent*.service <<'PY'
import glob, json, os, re, subprocess, sys, time
out = []
for unit in sys.argv[1:]:
    m = re.search(r"PG_ARCA_CONF_FILE=(\S+)", open(unit).read())
    try:
        st = json.load(open(m.group(1))).get("state_dir") if m else None
    except Exception:
        st = None
    name = os.path.basename(unit)[:-len(".service")]
    try:
        pid = int(subprocess.run(["systemctl", "show", "-p", "MainPID", "--value", name], stdout=subprocess.PIPE, universal_newlines=True, timeout=10).stdout.strip() or 0)
    except Exception:
        pid = 0
    if not st or pid <= 0:
        continue
    try:            # start of the running agent: an operation journaled 'running' before it belongs to an earlier process (interrupted, not running)
        btime = int(re.search(r"^btime (\d+)", open("/proc/stat").read(), re.M).group(1))
        started = btime + int(open("/proc/%d/stat" % pid).read().rsplit(")", 1)[1].split()[19]) / os.sysconf("SC_CLK_TCK")
    except Exception:
        started = 0
    for f in glob.glob(os.path.join(st, "ops", "op-*.json")):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if d.get("status") == "running" and float(d.get("started") or 0) >= started - 5:
            out.append("%s runs %s (%s, since %s)" % (name, d.get("type"), d.get("id"), time.strftime("%H:%M", time.localtime(float(d.get("started") or 0)))))
print("; ".join(out))
PY
)" || BUSY=""
  [[ -n "$BUSY" ]] && die "not upgraded: $BUSY. The upgrade restarts every pg_arca agent of this host; run it again when the operation has finished (or PG_ARCA_FORCE=1)."
fi

# --- layout ----------------------------------------------------------------------
install -d -m 0755 "$INSTALL_DIR"
# The agent's own directories: created, or taken over when the agent's user changed on a re-run (otherwise it crash-loops on its own files).
# The main agent's /etc/pg-arca and /var/lib/pgarca are also the parents of the other instances' directories, which may belong to other OS users:
# traversable by them (0711), never listable; each file keeps its own restrictive mode.
own_dir() {   # <dir> <mode> [recursive]
  if [[ -d "$1" ]]; then
    if [[ "$(stat -c %U "$1")" != "$PGUSER_OS" ]]; then if [[ -n "${3:-}" ]]; then chown -R "$PGUSER_OS" "$1"; else chown "$PGUSER_OS" "$1"; fi; fi
    chmod "$2" "$1"
  else install -d -m "$2" -o "$PGUSER_OS" "$1"; fi
}
# Repository / WAL archive: a directory that already exists outside the agent's tree (a mount, a network share with root_squash) is used as it is when the
# agent's user can write into it - never chowned/chmodded by root here.
data_dir() {  # <dir>
  if [[ -d "$1" && "$1" != "$STATE_ROOT"/* ]]; then
    as_user test -w "$1" -a -x "$1" || die "$1 exists but the agent's user $PGUSER_OS cannot write into it: give it to $PGUSER_OS (chown -R $PGUSER_OS $1) or choose another directory"
  else own_dir "$1" 0750 recursive; fi
}
if [[ -n "$INST" ]]; then for d in /etc/pg-arca /var/lib/pgarca; do [[ -d "$d" ]] || install -d -m 0711 "$d"; chmod o+x "$d"; done; PMODE=0750; else PMODE=0711; fi
own_dir "$CONF_DIR" "$PMODE"; own_dir "$STATE_ROOT" "$PMODE"; own_dir "$STATE_ROOT/state" 0750 recursive
data_dir "$REPO_DIR"; data_dir "$WAL_DIR"; own_dir "$LOG_DIR" 0750 recursive; own_dir "$SCRATCH" 0750 recursive
# SELinux enforcing (RHEL family): archive_command runs inside PostgreSQL's confined domain and writes into the WAL archive; a directory labelled
# var_lib_t refuses it (archive failures, pg_wal grows). Labelled as PostgreSQL data, persistently. Not done for a share that cannot carry labels (NFS).
if command -v getenforce >/dev/null && [[ "$(getenforce 2>/dev/null)" != Disabled ]]; then
  if command -v semanage >/dev/null; then
    install -d -m 0750 -o "$PGUSER_OS" "$STATE_ROOT/state/walspool"       # asynchronous archiving parks segments here (wal_spool.py)
    for d in "$WAL_DIR" "$STATE_ROOT/state/walspool"; do
      semanage fcontext -a -t postgresql_db_t "$(readlink -f "$d")(/.*)?" 2>/dev/null || semanage fcontext -m -t postgresql_db_t "$(readlink -f "$d")(/.*)?" 2>/dev/null || true
    done
    restorecon -R "$WAL_DIR" "$STATE_ROOT/state/walspool" 2>/dev/null || echo "NOTE: could not relabel $WAL_DIR for SELinux (network share?): archive_command may be refused - see INSTALL.md (SELinux)"
  else
    echo "NOTE: SELinux is on and semanage is missing (dnf install policycoreutils-python-utils): label the WAL archive for PostgreSQL by hand - see INSTALL.md (SELinux)"
  fi
fi
for f in agent.conf credentials.json enroll.env agent.local.json; do [[ -f "$CONF_DIR/$f" ]] && chown "$PGUSER_OS" "$CONF_DIR/$f"; done
rm -rf "$INSTALL_DIR/pg_arca.new"; cp -r "$BUNDLE/pg_arca" "$INSTALL_DIR/pg_arca.new"
rm -rf "$INSTALL_DIR/pg_arca.old"; [[ -d "$INSTALL_DIR/pg_arca" ]] && mv "$INSTALL_DIR/pg_arca" "$INSTALL_DIR/pg_arca.old"
mv "$INSTALL_DIR/pg_arca.new" "$INSTALL_DIR/pg_arca"; rm -rf "$INSTALL_DIR/pg_arca.old"
install -m 0755 "$BUNDLE/pg-arca-agent.py" "$INSTALL_DIR/pg-arca-agent.py"
install -m 0755 "$BUNDLE/pg-arca-cli" /usr/local/bin/pg-arca-cli
install -m 0755 "$BUNDLE/pg-arca-wal" /usr/local/bin/pg-arca-wal
chown -R root:root "$INSTALL_DIR"

# --- CA of the console certificate: copied next to the config, readable by the agent's user. The path given (/root/console.crt, the console's own
# tls/ directory, ...) is usually readable by root only, and the agent does not run as root (found by the release test: PermissionError at start).
if [[ -n "${PG_ARCA_TLS_CA:-}" ]]; then
  [[ -r "$PG_ARCA_TLS_CA" ]] || die "PG_ARCA_TLS_CA=$PG_ARCA_TLS_CA is not readable"
  if [[ "$(readlink -f "$PG_ARCA_TLS_CA")" != "$(readlink -f "$CONF_DIR/console-ca.pem" 2>/dev/null)" ]]; then install -m 0644 "$PG_ARCA_TLS_CA" "$CONF_DIR/console-ca.pem"; fi
  PG_ARCA_TLS_CA="$CONF_DIR/console-ca.pem"; export PG_ARCA_TLS_CA
  if [[ -f "$CONF_DIR/agent.conf" ]]; then                                   # upgrade or re-run with a CA: point an existing config at the copy
    python3 - "$CONF_DIR/agent.conf" "$PG_ARCA_TLS_CA" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
if c.get("tls_ca_file") != sys.argv[2]:
    c["tls_ca_file"] = sys.argv[2]; json.dump(c, open(sys.argv[1], "w"), indent=2)
PY
  fi
fi

# --- config (never overwritten) -------------------------------------------------------
if [[ ! -f "$CONF_DIR/agent.conf" ]]; then
  [[ -n "${PG_ARCA_URL:-}" ]] || die "PG_ARCA_URL is required on first install"
  python3 - "$CONF_DIR/agent.conf" <<PY
import json, os, sys
c = {"connection_mode": "push", "web_server_url": os.environ["PG_ARCA_URL"].rstrip("/"),
     "repo_path": "$REPO_DIR", "wal_archive_dir": "$WAL_DIR", "scratch_dir": "$SCRATCH", "state_dir": "$STATE_ROOT/state",
     "credentials_file": "$CONF_DIR/credentials.json"}
# no "pg_user": the agent finds the role that connects (owner of PGDATA, its own OS user, postgres). Set PG_ARCA_PG_ROLE only for a superuser with an unrelated name.
if os.environ.get("PG_ARCA_PG_ROLE"): c["pg_user"] = os.environ["PG_ARCA_PG_ROLE"]
if os.environ.get("PG_ARCA_NODE_NAME"): c["node_name"] = os.environ["PG_ARCA_NODE_NAME"]
if "$ROLE" != "auto": c["node_role"] = "$ROLE"
if os.environ.get("PG_ARCA_PGDATA"): c["pg_data"] = os.environ["PG_ARCA_PGDATA"]      # this agent manages THIS instance (several on one host: one agent each)
if os.environ.get("PG_ARCA_TLS_CA"): c["tls_ca_file"] = os.environ["PG_ARCA_TLS_CA"]
json.dump(c, open(sys.argv[1], "w"), indent=2)
PY
  chown "$PGUSER_OS" "$CONF_DIR/agent.conf"; chmod 0640 "$CONF_DIR/agent.conf"
fi
if [[ -n "${PG_ARCA_ENROLL_TOKEN:-}" && ! -f "$CONF_DIR/credentials.json" ]]; then
  umask 077; printf 'PG_ARCA_ENROLL_TOKEN=%s\n' "$PG_ARCA_ENROLL_TOKEN" > "$CONF_DIR/enroll.env"; chown "$PGUSER_OS" "$CONF_DIR/enroll.env"; chmod 0600 "$CONF_DIR/enroll.env"
fi
if [[ ! -f "$CONF_DIR/credentials.json" && ! -f "$CONF_DIR/enroll.env" ]]; then
  echo "No enrollment token given: this server will announce itself to ${PG_ARCA_URL:-the console} and wait for an administrator to approve it in the web console (Cluster page)."
fi

# --- service -------------------------------------------------------------------------
# No systemd (container) or PG_ARCA_NO_SERVICE=1: files are installed, the caller starts the agent:
#   su postgres -c 'PYTHONPATH=/opt/pg-arca PG_ARCA_CONF_FILE=/etc/pg-arca/agent.conf python3 /opt/pg-arca/pg-arca-agent.py'
if [[ -n "${PG_ARCA_NO_SERVICE:-}" || ! -d /run/systemd/system ]]; then
  echo "pg_arca agent installed WITHOUT a systemd service (no systemd here, or PG_ARCA_NO_SERVICE set). Start it with (keeps running, restarts if it exits):"
  echo "  su $PGUSER_OS -c 'set -a; [ -f $CONF_DIR/enroll.env ] && . $CONF_DIR/enroll.env; set +a; export PYTHONPATH=$INSTALL_DIR PG_ARCA_CONF_FILE=$CONF_DIR/agent.conf; nohup sh -c \"while true; do python3 $INSTALL_DIR/pg-arca-agent.py >>$LOG_DIR/agent.out 2>&1; sleep 5; done\" >/dev/null 2>&1 &'"
  echo "  logs: tail -f $LOG_DIR/agent.out"
  exit 0
fi
# restart of a STANDALONE PostgreSQL from the console (after enabling WAL archiving or changing a restart-only parameter) and START of its unit by a
# whole-server restore that puts production back. The agent's user may restart/start ONLY postgresql units (postgresql.service, postgresql@14-main,
# postgresql-16), never stop them, nothing else. Two ways, chosen here:
#   - polkit 0.106 or later: a JavaScript rule (/etc/polkit-1/rules.d/50-pg-arca-restart.rules)
#   - polkit older than 0.106 (Debian <= 11, Ubuntu <= 22.04: no JavaScript rules, and .pkla files cannot name a unit) or no polkit at all: the
#     pg-arca-pgctl bridge, a root oneshot started by a path unit that executes only those two verbs on known PostgreSQL units for the listed users
#     (pg_arca/pgctl_bridge.py). The agent itself keeps NoNewPrivileges: no sudo, no setuid.
# Patroni members restart through Patroni: nothing needed. Opt out with PG_ARCA_ALLOW_PG_RESTART=0 (the console then shows the command to run by hand).
IS_PATRONI=""; { pgrep -f "bin/patroni" >/dev/null 2>&1 || systemctl is-active --quiet patroni 2>/dev/null; } && IS_PATRONI=1
remove_bridge() {
  systemctl disable --now pg-arca-pgctl.path >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/pg-arca-pgctl.path /etc/systemd/system/pg-arca-pgctl.service /etc/tmpfiles.d/pg-arca-ctl.conf
}
rm -f /etc/sudoers.d/pg-arca-restart                           # left by 1.0.0-rc.1 builds: it never worked under NoNewPrivileges
if [[ "${PG_ARCA_ALLOW_PG_RESTART:-1}" != 0 && "$ROLE" != worker && -z "$IS_PATRONI" ]]; then
  if [[ -z "$NOPKG" && ! -d /etc/polkit-1 ]]; then
    echo "installing polkit (lets the agent start/restart ONLY the PostgreSQL units; PG_ARCA_ALLOW_PG_RESTART=0 to skip)"
    { command -v apt-get >/dev/null && { apt-get install -y -qq polkitd >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && { apt-get install -y -qq polkitd >/dev/null 2>&1 || apt-get install -y -qq policykit-1 >/dev/null 2>&1; }; }; }; } \
      || { command -v dnf >/dev/null && dnf install -y -q polkit >/dev/null 2>&1; } || { command -v yum >/dev/null && yum install -y -q polkit >/dev/null 2>&1; } || true
    [ -d /etc/polkit-1 ] && { systemctl enable --now polkit >/dev/null 2>&1 || systemctl start polkit >/dev/null 2>&1 || true; }
  fi
  { [[ -f "$CTL_USERS" ]] && grep -v '^#' "$CTL_USERS"; echo "$PGUSER_OS"; } | sed '/^$/d' | sort -u > "$CTL_USERS.new"
  install -m 0644 -o root -g root "$CTL_USERS.new" "$CTL_USERS"; rm -f "$CTL_USERS.new"
  PKV=$(pkaction --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)?' | head -1 || true)
  if [[ -d /etc/polkit-1 && -n "$PKV" ]] && ! [[ "$PKV" == 0.* && "${PKV#0.}" -lt 106 ]]; then
    write_polkit_rule; remove_bridge
    echo "restart from the console: allowed for the PostgreSQL units only (polkit rule /etc/polkit-1/rules.d/50-pg-arca-restart.rules; PG_ARCA_ALLOW_PG_RESTART=0 to disable)"
  else
    rm -f /etc/polkit-1/rules.d/50-pg-arca-restart.rules        # ignored by this polkit anyway
    echo "d /run/pg-arca-ctl 1733 root root -" > /etc/tmpfiles.d/pg-arca-ctl.conf
    systemd-tmpfiles --create /etc/tmpfiles.d/pg-arca-ctl.conf 2>/dev/null || { install -d -m 1733 -o root -g root /run/pg-arca-ctl; chmod 1733 /run/pg-arca-ctl; }
    cat > /etc/systemd/system/pg-arca-pgctl.path <<PATHU
[Unit]
Description=pg_arca: restart/start requests of the agents for the PostgreSQL units

[Path]
PathExistsGlob=/run/pg-arca-ctl/*.req

[Install]
WantedBy=multi-user.target
PATHU
    cat > /etc/systemd/system/pg-arca-pgctl.service <<SVCU
[Unit]
Description=pg_arca: restart/start of a PostgreSQL unit asked by an agent (users in $CTL_USERS, postgresql units only)

[Service]
Type=oneshot
ExecStart=/usr/bin/env python3 -I $INSTALL_DIR/pg_arca/pgctl_bridge.py --serve
TimeoutStartSec=1000
SVCU
    systemctl daemon-reload; systemctl enable --now pg-arca-pgctl.path >/dev/null 2>&1 || echo "WARNING: pg-arca-pgctl.path did not start: restarting PostgreSQL from the console will not be possible"
    echo "restart from the console: allowed for the PostgreSQL units only (${PKV:+polkit $PKV has no JavaScript rules; }bridge pg-arca-pgctl, users in $CTL_USERS; PG_ARCA_ALLOW_PG_RESTART=0 to disable)"
  fi
elif [[ "${PG_ARCA_ALLOW_PG_RESTART:-1}" == 0 ]]; then
  if [[ -f "$CTL_USERS" ]]; then grep -vx "$PGUSER_OS" "$CTL_USERS" > "$CTL_USERS.new" || true; install -m 0644 "$CTL_USERS.new" "$CTL_USERS"; rm -f "$CTL_USERS.new"; fi
  if [[ ! -s "$CTL_USERS" ]]; then rm -f /etc/polkit-1/rules.d/50-pg-arca-restart.rules "$CTL_USERS"; remove_bridge; else write_polkit_rule; fi
fi
cat > /etc/systemd/system/$UNIT.service <<UNIT
[Unit]
Description=pg_arca node agent${INST:+ (instance $INST)}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$PGUSER_OS
Environment=PYTHONPATH=$INSTALL_DIR PG_ARCA_CONF=$CONF_DIR/agent.conf PG_ARCA_CONF_FILE=$CONF_DIR/agent.conf
EnvironmentFile=-$CONF_DIR/enroll.env
ExecStart=/usr/bin/env python3 $INSTALL_DIR/pg-arca-agent.py
Restart=always
RestartSec=5
# least privilege: read the system, write only agent state
NoNewPrivileges=yes
# 'full' (not 'strict'): restores, pg_hba/postgresql.conf edits and PGDATA/tablespaces live in arbitrary paths (/var/lib/pgsql, /data, /pgdata, /mnt/...). Only /usr, /boot and /etc stay read-only, with the usual PostgreSQL config dirs re-opened.
ProtectSystem=full
ReadWritePaths=-/etc/postgresql -/etc/postgresql-common -/etc/patroni -/etc/pgbouncer
# no ProtectHome/PrivateTmp: PGDATA, tablespaces or restore targets may live under /home, and a PostgreSQL unix socket in /tmp (source builds, some PGDG setups) must stay reachable
ReadWritePaths=$CONF_DIR $STATE_ROOT $REPO_DIR $LOG_DIR $SCRATCH
# AF_NETLINK: 'ip -o addr' (which addresses are this host's: which Patroni member the agent is)
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
CapabilityBoundingSet=
# be a good neighbour on a production database host
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
CPUWeight=20
IOWeight=20
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable $UNIT.service >/dev/null
systemctl restart $UNIT.service      # restart (not just start): re-running the installer is the upgrade path, the old code must not keep running
# the code in $INSTALL_DIR is shared by every agent of this host (one per PostgreSQL instance): they all restart on the new code
for u in $(systemctl list-units --plain --no-legend --type=service 'pg-arca-agent*' 2>/dev/null | awk '{print $1}'); do
  [[ "$u" == "$UNIT.service" ]] || systemctl restart "$u" || true
done
sleep 2
systemctl is-active --quiet $UNIT.service && echo "pg_arca agent is running ($UNIT)." || { echo "agent failed to start:"; journalctl -u $UNIT -n 20 --no-pager; exit 1; }
# wait (max ~40 s) for the agent to tell how its registration went, so the person at the terminal knows right away whether to look at the console or fix something here
ST="$STATE_ROOT/state/console_status.json"; state=""
for _ in $(seq 1 40); do
  [[ -f "$ST" ]] && state="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("state","")+"|"+str(d.get("detail") or "")+"|"+str(d.get("node_id") or ""))' "$ST" 2>/dev/null || true)"
  case "${state%%|*}" in enrolled|connected|waiting_approval) break ;; esac
  systemctl is-active --quiet $UNIT.service || break
  sleep 1
done
IFS='|' read -r st detail nid <<<"$state"
case "$st" in
  enrolled|connected) echo "OK: registered in the console as node $nid. Open ${PG_ARCA_URL:-the console}: the server is listed under Clusters." ;;
  waiting_approval)   [[ -n "$detail" ]] && echo "NOTE: the enrollment token was refused ($detail: expired, already used or unknown)."
                      echo "WAITING: this server announced itself; an administrator approves it in the console (Today / Clusters: 'New server detected')." ;;
  token_refused)      echo "NOTE: the enrollment token was refused ($detail); the agent is announcing the server for approval instead." ;;
  unreachable)        echo "PROBLEM: the agent cannot reach the console: $detail"; echo "  check the address (${PG_ARCA_URL:-?}), DNS, firewall/proxy from this server; the agent keeps retrying." ;;
  *)                  echo "The agent is starting; registration not confirmed yet. Follow it with: journalctl -u $UNIT -f" ;;
esac
echo "Logs: journalctl -u $UNIT -f"
# what is left to do, said only when it is really left (THIS agent's instance: its own data directory, socket and port)
sleep 3
case "$(archiving_state 2>/dev/null)" in
  yes) echo "WAL archiving: already active through pg_arca." ;;
  no)  echo "Next: WAL archiving (needed for point-in-time restore) is switched on from the console, Backup tab -> 'Enable WAL archiving' (on Patroni through the DCS)." ;;
  *)   echo "Next: check WAL archiving in the console (Backup tab): it is needed for point-in-time restore." ;;
esac
