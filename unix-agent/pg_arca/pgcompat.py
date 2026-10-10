"""PostgreSQL version compatibility: ONE place that knows how versions differ.

Everything in the agent that behaves differently across PostgreSQL versions asks a Profile instead of comparing version numbers itself:
  * detection   - from the running server (`server_version_num` / `server_version`), from the data directory (`PG_VERSION`, works with the server stopped) or from a
                  binary (`postgres --version`), including vendor suffixes (Debian/Ubuntu, EDB, Percona...) and pre-release tags (17beta1, 18devel);
  * support tier - unsupported (< 10) | legacy (10, 11: written for but not exercised by the test matrix) | supported (12..NEWEST_KNOWN) | newer (> NEWEST_KNOWN:
                  everything is gated with ">=" so it is expected to work, but nobody has reviewed it) - plus the community end-of-life date;
  * differences - the backup API (pg_start_backup/pg_stop_backup <15, pg_backup_start/pg_backup_stop >=15), recovery configuration (recovery.conf <12,
                  recovery.signal + postgresql.auto.conf >=12), the replay-pause view (14), view columns, tools shipped with the server;
  * tools       - the version of the binaries actually used (pg_waldump cannot read WAL of another major; a postgres of another major cannot open the files).

Pure functions plus a tiny cache: nothing here connects to PostgreSQL.
"""
import datetime
import os
import re
import subprocess

MIN_LEGACY = 10          # below this the WAL/LSN naming (pg_xlog, *_location) differs everywhere: refused
MIN_SUPPORTED = 12       # first major with recovery.signal / the current feature set
NEWEST_KNOWN = 18        # newest major whose differences were reviewed (everything newer is "newer": allowed, with a warning)
VERIFIED = (16,)         # majors whose full test suite passed in a REAL run. Extend only when the version matrix (tools/lab/matrix.sh) passed for that major.

_EOL_FIXED = {9.6: "2021-11-11"}      # everything from 10 on follows the rule below


def _second_thursday_nov(year):
    d = datetime.date(year, 11, 1)
    first = d + datetime.timedelta(days=(3 - d.weekday()) % 7)
    return first + datetime.timedelta(days=7)


def eol_date(major):
    """Final minor release of a major: the second Thursday of November, five years after its first release (PostgreSQL versioning policy)."""
    if major in _EOL_FIXED:
        return datetime.date.fromisoformat(_EOL_FIXED[major])
    if major < 10:
        return datetime.date(2021, 11, 11)
    return _second_thursday_nov(2012 + int(major))        # 10 -> 2022, 12 -> 2024, 18 -> 2030


class VersionError(Exception):
    pass


_NUM_RE = re.compile(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?")


def parse_version(text):
    """'16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)', '9.6.24', '17beta1', '18devel', '15.4 - Percona...', 160015, '16' -> server_version_num (int). Raises VersionError."""
    if isinstance(text, int):
        return text
    t = str(text or "").strip()
    if t.isdigit() and len(t) >= 5:
        return int(t)                                             # already a server_version_num
    m = _NUM_RE.match(t.lstrip("vV"))
    if not m:
        raise VersionError("cannot read a PostgreSQL version from %r" % (text,))
    a = int(m.group(1))
    b = int(m.group(2)) if m.group(2) is not None else 0
    c = int(m.group(3)) if m.group(3) is not None else 0
    if a >= 10:
        return a * 10000 + b                                      # 16.15 -> 160015; PG_VERSION '16' -> 160000; 17beta1 -> 170000
    return a * 10000 + b * 100 + c                                # 9.6.24 -> 90624; PG_VERSION '9.6' -> 90600


def set_profile(meta, default=None):
    """Profile of the server that wrote a backup set (from its metadata); `default` for sets that predate the field."""
    for key in ("pg_version_num", "pg_version"):
        if meta.get(key):
            try:
                return Profile.from_text(meta[key])
            except VersionError:
                pass
    return default


def num_to_major(num):
    """Major as the community names it: 16, 17... ; 9.6 for the old numbering."""
    n = int(num)
    if n >= 100000:
        return n // 10000
    return round((n // 10000) + ((n // 100) % 100) / 10.0, 1)


class Profile(object):
    def __init__(self, num):
        self.num = int(num)
        self.major = num_to_major(self.num)
        self.label = ("%d" % self.major) if self.num >= 100000 else ("%.1f" % self.major)
        if self.num < MIN_LEGACY * 10000:
            self.tier = "unsupported"
        elif self.num < MIN_SUPPORTED * 10000:
            self.tier = "legacy"
        elif self.num >= (NEWEST_KNOWN + 1) * 10000:
            self.tier = "newer"
        else:
            self.tier = "supported"
        self.eol = eol_date(self.major)
        self.verified = int(self.major) in VERIFIED if self.num >= 100000 else False

    # ------------------------------------------------------------------ constructors
    @classmethod
    def from_text(cls, text):
        return cls(parse_version(text))

    @classmethod
    def from_pgdata(cls, pgdata):
        """From PG_VERSION (works with the server stopped); only the MAJOR is known there."""
        with open(os.path.join(pgdata, "PG_VERSION"), "r") as f:
            return cls.from_text(f.read().strip())

    @classmethod
    def from_binary(cls, path):
        """From `<bin> --version` ('postgres (PostgreSQL) 16.15 (Ubuntu ...)', 'pg_waldump (PostgreSQL) 14.9')."""
        out = subprocess.run([path, "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10).stdout
        m = re.search(r"\(PostgreSQL\)\s*(\S+)", out) or re.search(r"\s(\d+(?:\.\d+)*)", out)
        if not m:
            raise VersionError("cannot read a version from %r" % out.strip()[:80])
        return cls.from_text(m.group(1))

    # ------------------------------------------------------------------ differences
    @property
    def recovery_conf_file(self):
        """Before 12 recovery is configured in recovery.conf (and ENDS by renaming it); from 12 on in postgresql.auto.conf + a recovery.signal file."""
        return self.num < 120000

    @property
    def has_pause_state(self):
        return self.num >= 140000                                  # pg_get_wal_replay_pause_state(); before: pg_is_wal_replay_paused()

    @property
    def new_backup_api(self):
        return self.num >= 150000                                  # pg_backup_start/pg_backup_stop; the exclusive API is gone

    @property
    def has_slot_wal_status(self):
        return self.num >= 130000                                  # pg_replication_slots.wal_status / safe_wal_size

    @property
    def has_pg_checksums(self):
        return self.num >= 120000                                  # pg_checksums (before: pg_verify_checksums in 11, nothing in 10)

    @property
    def has_wal_segsize_initdb(self):
        return self.num >= 110000

    @property
    def has_idle_session_timeout(self):
        return self.num >= 140000

    def backup_start_sql(self, label_literal, fast):
        """Non-exclusive backup start (the session that runs it must also run the stop)."""
        f = "true" if fast else "false"
        if self.new_backup_api:
            return "SELECT pg_backup_start(%s, %s)::text" % (label_literal, f)
        return "SELECT pg_start_backup(%s, %s, false)::text" % (label_literal, f)

    def backup_stop_sql(self):
        fn = "pg_backup_stop(false)" if self.new_backup_api else "pg_stop_backup(false, false)"
        return ("SELECT lsn::text, translate(encode(convert_to(labelfile,'UTF8'),'base64'), E'\\n', ''), "
                "translate(encode(convert_to(COALESCE(spcmapfile,''),'UTF8'),'base64'), E'\\n', '') FROM %s" % fn)

    def replay_paused_sql(self):
        """Returns 1 when recovery is paused at its target, else 0."""
        if self.has_pause_state:
            return "SELECT (pg_get_wal_replay_pause_state() = 'paused')::int"
        return "SELECT pg_is_wal_replay_paused()::int"

    def install_recovery(self, pgdata, lines):
        """Configure archive recovery in `pgdata` with the version's own mechanism. `lines` = the text of the recovery settings (restore_command, recovery_target_*)."""
        if self.recovery_conf_file:
            for stale in ("recovery.signal", "standby.signal"):
                p = os.path.join(pgdata, stale)
                if os.path.exists(p):
                    os.unlink(p)
            with open(os.path.join(pgdata, "recovery.conf"), "w") as f:
                f.write(lines)
            return "recovery.conf"
        with open(os.path.join(pgdata, "postgresql.auto.conf"), "a") as f:
            f.write(lines)
        open(os.path.join(pgdata, "recovery.signal"), "w").close()
        return "recovery.signal"

    # ------------------------------------------------------------------ reporting
    def problems(self):
        """[(severity, code, text)] for a human: why this version needs attention."""
        out = []
        today = datetime.date.today()
        if self.tier == "unsupported":
            out.append(("critical", "unsupported", "PostgreSQL %s is not supported (minimum %d): backup and restore refuse to run on it." % (self.label, MIN_LEGACY)))
        elif self.tier == "legacy":
            out.append(("warning", "legacy", "PostgreSQL %s is only supported in legacy mode (recovery.conf and older views are handled, but this version is not part of the test matrix)." % self.label))
        elif self.tier == "newer":
            out.append(("info", "newer", "PostgreSQL %s is newer than the newest version reviewed (%d): it is expected to work, but verify a restore before relying on it." % (self.label, NEWEST_KNOWN)))
        if self.tier != "unsupported" and today > self.eol:
            out.append(("warning", "eol", "PostgreSQL %s reached end of life on %s: it no longer receives security fixes. Plan an upgrade." % (self.label, self.eol.isoformat())))
        return out

    def describe(self):
        return {"version_num": self.num, "major": self.major, "label": self.label, "tier": self.tier, "verified": self.verified,
                "eol_date": self.eol.isoformat(), "eol": datetime.date.today() > self.eol,
                "features": {"recovery_conf_file": self.recovery_conf_file, "new_backup_api": self.new_backup_api, "pause_state": self.has_pause_state,
                             "slot_wal_status": self.has_slot_wal_status, "pg_checksums": self.has_pg_checksums},
                "problems": [{"severity": s, "code": c, "text": t} for s, c, t in self.problems()]}


def same_major_version(a, b):
    """16.4 and 16.15 are the same major; 9.6 and 9.5 are not (the old numbering has a two-part major)."""
    if a.num >= 100000 and b.num >= 100000:
        return int(a.major) == int(b.major)
    return a.major == b.major


def tool_problems(server, bindir_versions):
    """Mismatches between the server and the binaries the agent will use. `bindir_versions` = {tool: Profile or None}."""
    out = []
    for tool, p in sorted(bindir_versions.items()):
        if p is None:
            continue
        same_major = same_major_version(p, server)
        if tool in ("postgres", "pg_waldump", "pg_controldata", "pg_ctl", "pg_resetwal") and not same_major:
            out.append(("critical", "tool_major", "%s is version %s but the server is %s: it cannot read this cluster's files/WAL. Set pg_bin_dir to the server's own bin directory." % (tool, p.label, server.label)))
        elif tool in ("psql", "pg_dump", "pg_basebackup", "pg_amcheck") and p.num < server.num and int(p.major) != int(server.major):
            out.append(("warning", "tool_old", "%s is version %s, older than the server (%s): some features may not work. Use the server's own client tools." % (tool, p.label, server.label)))
    return out


_binary_cache = {}


def binary_profile(path):
    """Cached Profile of a binary (None when it cannot be run or parsed)."""
    if not path:
        return None
    if path not in _binary_cache:
        try:
            _binary_cache[path] = Profile.from_binary(path)
        except Exception:
            _binary_cache[path] = None
    return _binary_cache[path]


def check_tools(server, bindir, tools=("postgres", "psql", "pg_waldump", "pg_controldata", "pg_ctl")):
    found = {}
    for t in tools:
        p = os.path.join(bindir, t) if bindir else None
        found[t] = binary_profile(p) if p and os.path.exists(p) else None
    return tool_problems(server, found)


def require_supported(profile, what):
    """Raises EngineError when the version cannot be handled at all."""
    from pg_arca.engine.util import EngineError
    if profile.tier == "unsupported":
        raise EngineError("PGA-VER-001", "%s is not possible on PostgreSQL %s (minimum supported: %d)" % (what, profile.label, MIN_LEGACY),
                          "upgrade PostgreSQL, or protect this cluster with a tool that supports it")
    return profile


def require_same_major(set_profile, server_profile, what):
    """A data directory only opens with the SAME major version of postgres."""
    from pg_arca.engine.util import EngineError
    if server_profile is not None and not same_major_version(set_profile, server_profile):
        raise EngineError("PGA-VER-002", "%s needs PostgreSQL %s binaries, but the ones available here are %s" % (what, set_profile.label, server_profile.label),
                          "install the matching PostgreSQL %s server package on this host (or set pg_bin_dir to it); a backup cannot be recovered with another major version" % set_profile.label)
    return set_profile
