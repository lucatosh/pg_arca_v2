"""Persistent psql session + connection descriptor.

pg_backup_start() and pg_backup_stop() MUST run in the same session (non-exclusive backup), so a long-lived
psql child is used instead of one process per statement. If the session (or the agent) dies, PostgreSQL
aborts the backup on its own - nothing is left running in the server.
"""

import os
import re
import subprocess
import threading
import time
import uuid

from pg_arca.engine.util import EngineError, tail_file


class PgConn(object):
    """Where and how to connect. Never turned into a shell string: always argv + environment."""

    def __init__(self, host="", port=5432, user="postgres", password=None, dbname="postgres", bindir=""):
        self.host = host or ""
        self.port = int(port or 5432)
        self.user = user or "postgres"
        self.password = password
        self.dbname = dbname or "postgres"
        self.bindir = bindir or ""

    def with_db(self, dbname):
        c = PgConn(self.host, self.port, self.user, self.password, dbname, self.bindir)
        return c

    def exe(self, prog):
        if self.bindir:
            return os.path.join(self.bindir, prog)
        return prog

    def args(self, dbname=None):
        """common libpq options for psql / pg_dump / pg_restore"""
        a = ["-U", self.user, "-p", str(self.port)]
        if self.host:
            a += ["-h", self.host]
        return a

    def env(self):
        e = dict(os.environ)
        e["PGAPPNAME"] = "pg_arca"
        e.setdefault("PGCONNECT_TIMEOUT", "10")
        if self.password:
            e["PGPASSWORD"] = self.password
        return e

    @classmethod
    def from_dict(cls, d, bindir=""):
        """A delivery address from an operation (`into`): host, port, user, password, dbname only. The binaries are always the agent's own
        (`bindir` argument): an operation must never choose the directory the agent runs executables from."""
        d = d or {}
        port = d.get("port", 5432)
        try:
            port = int(port)
        except (TypeError, ValueError):
            raise EngineError("PGA-SEC-040", "into.port is not a number: %r" % (port,))
        return cls(d.get("host", ""), port, d.get("user", "postgres"), d.get("password"), d.get("dbname", "postgres"), bindir)


def _psql_major(conn):
    try:
        out = subprocess.run([conn.exe("psql"), "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, encoding="utf-8", errors="replace", timeout=10).stdout
        import re
        m = re.search(r"\)\s*(\d+)", out)
        return int(m.group(1)) if m else 0
    except Exception:
        return 0


class PgSession(object):
    SEP = "\x1f"

    def __init__(self, conn, dbname=None, read_only=False):
        self.conn = conn
        self.dbname = dbname or conn.dbname
        self._err = []
        self._cleared = ""
        self._has_warn = _psql_major(conn) >= 13          # \warn (stderr marker) exists since psql 13
        self._cond = threading.Condition()
        self._marks = set()
        opts = "-c statement_timeout=0 -c lock_timeout=0"
        if read_only:
            opts += " -c default_transaction_read_only=on"
        env = conn.env()
        env["PGOPTIONS"] = (env.get("PGOPTIONS", "") + " " + opts).strip()
        # psql over pipes speaks the DATABASE's encoding (LATIN1, WIN1252, EUC_JP...): read as UTF-8 it raised UnicodeDecodeError on the first
        # accented letter (independent review). The server converts to UTF-8 for us; SQL_ASCII (no conversion) keeps its bytes as surrogates
        env["PGCLIENTENCODING"] = "UTF8"
        # over TCP (a remote 'into' server, a recovery host): keepalives after 60 s of silence - a firewall that silently drops an idle
        # connection otherwise left the session waiting on a dead socket for the OS default (hours)
        dbarg = self.dbname
        if conn.host and not conn.host.startswith("/"):
            dbarg = "dbname='%s' keepalives=1 keepalives_idle=60 keepalives_interval=10 keepalives_count=6" % self.dbname.replace("\\", "\\\\").replace("'", "\\'")
        cmd = [conn.exe("psql"), "-X", "-q", "-A", "-t", "-F", self.SEP, "-P", "pager=off", "-v", "ON_ERROR_STOP=0"] + conn.args() + ["-d", dbarg]
        try:
            self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      universal_newlines=True, encoding="utf-8", errors="surrogateescape", bufsize=1, env=env, close_fds=True)
        except OSError as e:
            raise EngineError("PGA-CFG-001", "cannot execute psql (%s)" % e, "install the PostgreSQL client or set pg_bin_dir")
        self._t = threading.Thread(target=self._drain, daemon=True)
        self._t.start()
        try:
            first = self.one("SELECT 1")
            if first != "1":
                raise EngineError("PGA-CFG-002", "cannot connect to %s: %s" % (self.dbname, self._why("no error from the server; first answer was %r, psql %s" % (first, "exited with %s" % self.p.poll() if self.p.poll() is not None else "still running"))),
                                  "check socket/port/user and pg_hba.conf")
            # A backup session sits idle for hours while files are copied: server-side idle timeouts (PG14+ idle_session_timeout, idle_in_transaction_session_timeout)
            # must not kill it. Error detection below needs English messages (superuser only). Each setting is optional: unknown/forbidden ones are ignored.
            self.one("DO $$ BEGIN "
                     "BEGIN PERFORM set_config('idle_session_timeout','0',false); EXCEPTION WHEN OTHERS THEN NULL; END; "
                     "BEGIN PERFORM set_config('idle_in_transaction_session_timeout','0',false); EXCEPTION WHEN OTHERS THEN NULL; END; "
                     "BEGIN PERFORM set_config('transaction_timeout','0',false); EXCEPTION WHEN OTHERS THEN NULL; END; "
                     "BEGIN PERFORM set_config('lc_messages','C',false); EXCEPTION WHEN OTHERS THEN NULL; END; END $$")
            v = self.one("SHOW server_version_num")
            if v is None or not str(v).strip().isdigit():
                # the server went away between the first answer and this one (shutdown, a crash of another process, the end of a
                # recovery that failed): a lost session, said as such - not a TypeError (seen in the matrix on PG 14, 17, 18)
                raise EngineError("PGA-CFG-003", "PostgreSQL session closed unexpectedly: " + self._why("no answer to SHOW server_version_num"),
                                  "the server closed the connection: restart, crash, failover or switchover while the operation was running")
            self.version_num = int(v)
            self.version = self.one("SHOW server_version")
            from pg_arca.pgcompat import Profile
            self.profile = Profile(self.version_num)          # every version difference is answered by this profile
        except BaseException:
            self.close()            # a session that never came up must not leave its psql process and three pipes behind (a long-running agent would run out of them)
            raise

    def _drain(self):
        for line in self.p.stderr:
            line = line.rstrip("\n")
            with self._cond:
                if line.startswith("PGARCAEOQ"):
                    self._marks.add(line)
                elif line.strip():
                    self._err.append(line)
                self._cond.notify_all()

    def _why(self, default="unknown reason"):
        for _ in range(10):                        # the stderr reader is a thread: give it a moment to deliver the server's last words
            e = self.take_errors()
            if e:
                self._cleared = e                  # one() swallows the first failure: remember it for the final message
            if e or self.p.poll() is not None and not self._t.is_alive():
                return e or self._cleared or default
            time.sleep(0.1)
        return self.take_errors() or self._cleared or default

    def take_errors(self):
        with self._cond:
            e, self._err = self._err, []
        return "; ".join(e)

    def query(self, sql):
        """Run one statement; returns rows (lists of str). Raises EngineError if the server reported an error."""
        marker = "PGARCAEOQ" + uuid.uuid4().hex
        cleared = self.take_errors()
        if cleared:
            self._cleared = cleared                # keep it: on a failed connection this IS the reason (FATAL: database ... does not exist), it arrives before the first query
        try:
            self.p.stdin.write(sql.rstrip().rstrip(";") + ";\n")
            self.p.stdin.write("\\echo %s :ERROR :SQLSTATE\n" % marker)     # psql 11+: whether THIS statement failed, whatever the server's language
            if self._has_warn:
                self.p.stdin.write("\\warn %s\n" % marker)
            self.p.stdin.flush()
        except (BrokenPipeError, ValueError, OSError):
            raise EngineError("PGA-CFG-003", "PostgreSQL session lost: " + (self._why("no error text from the server")), "the server closed the connection: restart, crash, failover or switchover while the operation was running. Check the cluster state, then run it again")
        rows = []
        while True:
            line = self.p.stdout.readline()
            if line == "":
                raise EngineError("PGA-CFG-003", "PostgreSQL session closed unexpectedly: " + (self._why("no error text from the server")), "the server closed the connection: restart, crash, failover or switchover while the operation was running. Check the cluster state, then run it again")
            line = line.rstrip("\n")
            if line == marker or line.startswith(marker + " "):
                flags = line[len(marker):].split()
                failed = flags[0] == "true" if flags and flags[0] in ("true", "false") else None
                state = flags[1] if failed and len(flags) > 1 and re.match(r"^[0-9A-Z]{5}$", flags[1]) else ""
                break
            if line == "":
                continue
            rows.append(line.split(self.SEP))
        deadline = time.time() + (10 if self._has_warn else 0.3)
        with self._cond:
            while self._has_warn and marker not in self._marks and time.time() < deadline:
                self._cond.wait(0.2)
            if not self._has_warn:
                self._cond.wait(0.3)
            self._marks.discard(marker)
        err = self.take_errors()
        # the server's own word for the failure: a non-superuser on a localized server writes "FEHLER:" / "ERREUR:" (lc_messages=C needs
        # superuser), which the text test missed - failed statements came back as empty results (independent engine review)
        if failed or "ERROR" in err or "FATAL" in err:
            raise EngineError("PGA-SQL-001", (err or "statement failed")[:600] + ((" (SQLSTATE %s)" % state) if state and state not in err else ""))
        return rows

    def one(self, sql):
        try:
            r = self.query(sql)
        except EngineError:
            return None
        return r[0][0] if r and r[0] else None

    def scalar(self, sql):
        """Like one() but raises on SQL error."""
        r = self.query(sql)
        return r[0][0] if r and r[0] else None

    def close(self):
        try:
            self.p.stdin.write("\\q\n")
            self.p.stdin.flush()
            self.p.wait(timeout=5)
        except Exception:
            try:
                self.p.kill()
                self.p.wait(timeout=5)          # reaped, not left a zombie
            except Exception:
                pass
        for f in (self.p.stdin, self.p.stdout, self.p.stderr):
            try:
                f.close()
            except Exception:
                pass


_DUMP_ZSTD = {}


def run_dump(conn, args, timeout=None, cancel=None, jobs=1):
    """pg_dump -Fc of the recovered data, compressed with zstd level 1 when the tool is PostgreSQL 16+ and was built with it (MEASURED on a 300 MB database: 3.5 s with the former
    -Z 3 -> 1.1 s, and a smaller file), plain -Z 1 otherwise. `args` must not carry -Fc / -Z. The dump is a scratch file read once by pg_restore: speed matters, size does not.
    jobs > 1: directory format with that many pg_dump workers (`-Fd -j`, one table per worker: a whole database dumps several times faster on a
    multi-core host); the `-f` target in `args` is then a directory, which pg_restore -j reads just the same."""
    fmt = ["-Fc"] if jobs <= 1 else ["-Fd", "-j", str(int(jobs))]
    exe = conn.exe("pg_dump") if conn else "pg_dump"
    if exe not in _DUMP_ZSTD:
        ok = False
        try:
            rc, out, _ = run_tool(conn, "pg_dump", ["--version"], timeout=15)
            m = re.search(r"(\d+)(?:\.\d+)?", out or "")
            ok = rc == 0 and bool(m) and int(m.group(1)) >= 16
        except EngineError:
            ok = False
        _DUMP_ZSTD[exe] = ok
    if _DUMP_ZSTD[exe]:
        rc, out, err = run_tool(conn, "pg_dump", fmt + ["--compress=zstd:1"] + list(args), timeout=timeout, cancel=cancel)
        if rc == 0 or not re.search(r"zstd|compress", err or "", re.I):
            return rc, out, err
        _DUMP_ZSTD[exe] = False                       # built without zstd: do not try again
        _rm_dump_target(args)
    return run_tool(conn, "pg_dump", fmt + ["-Z", "1"] + list(args), timeout=timeout, cancel=cancel)


def _rm_dump_target(args):
    """A directory-format dump that failed half-way must not be in the way of the retry (pg_dump -Fd refuses a non-empty directory)."""
    import shutil
    for i, a in enumerate(args):
        if a == "-f" and i + 1 < len(args) and os.path.isdir(args[i + 1]):
            shutil.rmtree(args[i + 1], ignore_errors=True)


def dump_size(path):
    """Bytes of a dump: a file (-Fc) or the directory of a parallel dump (-Fd)."""
    if os.path.isdir(path):
        return sum(os.path.getsize(os.path.join(path, f)) for f in os.listdir(path) if os.path.isfile(os.path.join(path, f)))
    return os.path.getsize(path)


_SERVER_MAJOR = {}


def _server_major(conn):
    """Major version of the server `conn` points at, None when it cannot be asked. Cached for a minute per address (an in-place major upgrade
    reuses the port; a failed probe is never cached)."""
    key = (conn.host, conn.port)
    hit = _SERVER_MAJOR.get(key)
    if hit and time.time() - hit[1] < 60:
        return hit[0]
    if True:
        try:
            r = subprocess.run([conn.exe("psql"), "-X", "-A", "-t", "-c", "SHOW server_version_num"] + conn.args() + ["-d", conn.dbname or "postgres"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, encoding="utf-8", errors="replace",
                               env=conn.env(), timeout=30)
            v = (r.stdout or "").strip()
            if r.returncode == 0 and v.isdigit():
                _SERVER_MAJOR[key] = (int(v) // 10000, time.time())
                return int(v) // 10000
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
        return None


def _restore_exe(conn, exe):
    """pg_restore 17+ always sends SET transaction_timeout, which a server of 16 or older refuses: with --exit-on-error / -1 every restore
    failed when the tools were newer than the destination (a recovery host with PostgreSQL 18 restoring into 16 - independent version review).
    Then the pg_restore of the destination's major, when installed; else a clear refusal."""
    from pg_arca.pgcompat import binary_profile
    prof = binary_profile(exe)
    if prof is None or prof.major < 17:
        return exe
    dest = _server_major(conn)
    if dest is None or dest >= 17:
        return exe
    # any directory with a pg_restore of that major: a client-only package (postgresql-client-16, postgresql16) has no server binary, which
    # the installation scan needs - looked up by the tool itself (regression review)
    import glob
    from pg_arca import pgaccess
    from pg_arca.engine import ephcfg
    dirs = [d for pat in tuple(pgaccess.VENDOR_GLOBS) + tuple(ephcfg.SYSTEM_GLOBS) for d in glob.glob(pat)]
    for d in dirs:
        cand = os.path.join(d, "pg_restore")
        if os.path.isfile(cand):
            p2 = binary_profile(cand)
            if p2 is not None and int(p2.major) == int(dest):
                return cand
    raise EngineError("PGA-VER-010", "pg_restore %s cannot load into PostgreSQL %d (it sets transaction_timeout, unknown before 17) and no pg_restore of %d is installed here"
                      % (prof.label, dest, dest), "install the PostgreSQL %d client tools on this host (or set pg_bin_dir to them)" % dest)


def run_tool(conn, prog, args, timeout=None, input_text=None, extra_env=None, cancel=None):
    """Run a PostgreSQL client tool. Returns (rc, stdout, stderr). With `cancel` (a callable) the tool is killed as soon as it returns True and
    Cancelled is raised: a long pg_dump / pg_restore must stop when the operator presses Annulla, not minutes later."""
    env = conn.env() if conn else dict(os.environ)
    if extra_env:
        env.update(extra_env)
    if prog in ("pg_dump", "pg_restore", "pg_dumpall"):
        # money is written and read with lc_monetary: a database that sets its own (ALTER DATABASE ... SET lc_monetary = 'it_IT') dumps '1.234,56 €',
        # which a session with another lc_monetary refuses (or reads differently). Every dump and every load of the engine uses the same neutral one.
        env["PGOPTIONS"] = (env.get("PGOPTIONS", "") + " -c lc_monetary=C").strip()
    if prog == "psql":
        env["PGCLIENTENCODING"] = "UTF8"             # our text is UTF-8 whatever the database's encoding (see PgSession)
    # text in and out as UTF-8 whatever the agent's locale (a service started with LANG unset is ASCII on Python 3.6); bytes that are not
    # UTF-8 (a SQL_ASCII database, a LATIN1 dump's listing) survive as surrogates instead of failing the whole tool
    txt = {"universal_newlines": True, "encoding": "utf-8", "errors": "surrogateescape"}
    exe = conn.exe(prog) if conn else prog
    if prog == "pg_restore" and conn is not None and "--version" not in args and "-l" not in args:
        exe = _restore_exe(conn, exe)
    if cancel is not None:
        from pg_arca.engine.util import Cancelled
        try:
            p = subprocess.Popen([exe] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL, env=env, **txt)
        except OSError as e:
            raise EngineError("PGA-CFG-004", "cannot execute %s: %s" % (prog, e), "install the PostgreSQL server/client packages or set pg_bin_dir")
        t0, inp = time.time(), input_text
        while True:
            try:
                out, err = p.communicate(input=inp, timeout=1)
                return p.returncode, out, err
            except subprocess.TimeoutExpired:
                inp = None                                     # the input was sent on the first call
                if cancel():
                    p.kill()
                    p.communicate()
                    raise Cancelled()
                if timeout and time.time() - t0 > timeout:
                    p.kill()
                    p.communicate()
                    return 124, "", "%s timed out after %ss" % (prog, timeout)
    try:
        p = subprocess.run([exe] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout, env=env, input=input_text, **txt)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "%s timed out after %ss" % (prog, timeout)
    except OSError as e:
        raise EngineError("PGA-CFG-004", "cannot execute %s: %s" % (prog, e), "install the PostgreSQL server/client packages or set pg_bin_dir")
