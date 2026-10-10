"""Persistent psql session + connection descriptor.

pg_backup_start() and pg_backup_stop() MUST run in the same session (non-exclusive backup), so a long-lived
psql child is used instead of one process per statement. If the session (or the agent) dies, PostgreSQL
aborts the backup on its own - nothing is left running in the server.
"""

import os
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
        d = d or {}
        return cls(d.get("host", ""), d.get("port", 5432), d.get("user", "postgres"), d.get("password"), d.get("dbname", "postgres"),
                   d.get("bindir", bindir))


def _psql_major(conn):
    try:
        out = subprocess.run([conn.exe("psql"), "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=10).stdout
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
        self._has_warn = _psql_major(conn) >= 13          # \warn (stderr marker) exists since psql 13
        self._cond = threading.Condition()
        self._marks = set()
        opts = "-c statement_timeout=0 -c lock_timeout=0"
        if read_only:
            opts += " -c default_transaction_read_only=on"
        env = conn.env()
        env["PGOPTIONS"] = (env.get("PGOPTIONS", "") + " " + opts).strip()
        cmd = [conn.exe("psql"), "-X", "-q", "-A", "-t", "-F", self.SEP, "-P", "pager=off", "-v", "ON_ERROR_STOP=0"] + conn.args() + ["-d", self.dbname]
        try:
            self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      universal_newlines=True, bufsize=1, env=env, close_fds=True)
        except OSError as e:
            raise EngineError("PGA-CFG-001", "cannot execute psql (%s)" % e, "install the PostgreSQL client or set pg_bin_dir")
        self._t = threading.Thread(target=self._drain, daemon=True)
        self._t.start()
        if self.one("SELECT 1") != "1":
            raise EngineError("PGA-CFG-002", "cannot connect to %s: %s" % (self.dbname, self.take_errors() or "unknown reason"),
                              "check socket/port/user and pg_hba.conf")
        # A backup session sits idle for hours while files are copied: server-side idle timeouts (PG14+ idle_session_timeout, idle_in_transaction_session_timeout)
        # must not kill it. Error detection below needs English messages (superuser only). Each setting is optional: unknown/forbidden ones are ignored.
        self.one("DO $$ BEGIN "
                 "BEGIN PERFORM set_config('idle_session_timeout','0',false); EXCEPTION WHEN OTHERS THEN NULL; END; "
                 "BEGIN PERFORM set_config('idle_in_transaction_session_timeout','0',false); EXCEPTION WHEN OTHERS THEN NULL; END; "
                 "BEGIN PERFORM set_config('lc_messages','C',false); EXCEPTION WHEN OTHERS THEN NULL; END; END $$")
        self.version_num = int(self.one("SHOW server_version_num"))
        self.version = self.one("SHOW server_version")

    def _drain(self):
        for line in self.p.stderr:
            line = line.rstrip("\n")
            with self._cond:
                if line.startswith("PGARCAEOQ"):
                    self._marks.add(line)
                elif line.strip():
                    self._err.append(line)
                self._cond.notify_all()

    def take_errors(self):
        with self._cond:
            e, self._err = self._err, []
        return "; ".join(e)

    def query(self, sql):
        """Run one statement; returns rows (lists of str). Raises EngineError if the server reported an error."""
        marker = "PGARCAEOQ" + uuid.uuid4().hex
        self.take_errors()
        try:
            self.p.stdin.write(sql.rstrip().rstrip(";") + ";\n")
            self.p.stdin.write("\\echo %s\n" % marker)
            if self._has_warn:
                self.p.stdin.write("\\warn %s\n" % marker)
            self.p.stdin.flush()
        except (BrokenPipeError, ValueError, OSError):
            raise EngineError("PGA-CFG-003", "PostgreSQL session lost: " + (self.take_errors() or "no error text from the server"), "the server closed the connection: restart, crash, failover or switchover while the operation was running. Check the cluster state, then run it again")
        rows = []
        while True:
            line = self.p.stdout.readline()
            if line == "":
                raise EngineError("PGA-CFG-003", "PostgreSQL session closed unexpectedly: " + (self.take_errors() or "no error text from the server"), "the server closed the connection: restart, crash, failover or switchover while the operation was running. Check the cluster state, then run it again")
            line = line.rstrip("\n")
            if line == marker:
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
        if "ERROR" in err or "FATAL" in err:
            raise EngineError("PGA-SQL-001", err[:600])
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
            except Exception:
                pass
        for f in (self.p.stdin, self.p.stdout, self.p.stderr):
            try:
                f.close()
            except Exception:
                pass


def run_tool(conn, prog, args, timeout=None, input_text=None, extra_env=None):
    """Run a PostgreSQL client tool. Returns (rc, stdout, stderr)."""
    env = conn.env() if conn else dict(os.environ)
    if extra_env:
        env.update(extra_env)
    try:
        p = subprocess.run([conn.exe(prog) if conn else prog] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=timeout, env=env, input=input_text)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "%s timed out after %ss" % (prog, timeout)
    except OSError as e:
        raise EngineError("PGA-CFG-004", "cannot execute %s: %s" % (prog, e), "install the PostgreSQL server/client packages or set pg_bin_dir")
