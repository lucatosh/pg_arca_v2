"""Ephemeral recovery instance: a disposable, isolated PostgreSQL used to reach a point in time and extract data.

Isolation barriers (all always on): GUC quarantine (allowlist rewrite), no TCP listener, private 0700 socket directory,
read-only, archiving forced off, replication/ssl/logging stripped, tablespaces re-rooted inside the scratch directory,
symlink audit, protected-path refusal, TTL + reaping, never runs as root.
"""

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid

from pg_arca.engine import ENGINE_VERSION, ephcfg
from pg_arca.engine.backup import _check_cancel, build_chain
from pg_arca.engine.pgsession import PgConn, PgSession, run_tool
from pg_arca.pgcompat import Profile, binary_profile, require_same_major, require_supported, set_profile
from pg_arca.engine.restore import (check_wal_for_chain, choose_set, count_targets, estimate, install_external_conf, materialize, merge_chain,
                                    prepare_skeleton, recovery_lines, sparse_filter)
from pg_arca.engine.safety import assert_writable_target, audit_symlinks
from pg_arca.engine.util import EngineError, human, iso, parse_target_time, tail_file

GUC_REMOVE = ["data_directory", "hba_file", "ident_file", "config_file", "external_pid_file", "archive_cleanup_command", "recovery_end_command",
              "primary_conninfo", "primary_slot_name", "recovery_min_apply_delay", "ssl_cert_file", "ssl_key_file", "ssl_ca_file", "ssl_crl_file",
              "stats_temp_directory", "cluster_name", "include", "include_if_exists", "include_dir", "logging_collector", "log_destination",
              "log_directory", "log_filename", "unix_socket_group", "synchronous_standby_names", "archive_command", "archive_library",
              "restore_command", "shared_memory_type", "wal_sender_timeout"]
GUC_BLOCKED_LIBS = {"pg_cron", "pglogical", "pg_partman_bgw", "pgagent", "pg_bulkload", "anon", "pg_background", "pgactive", "bdr", "pg_squeeze"}


class TargetNotReached(EngineError):
    """The archive ends before the requested recovery target. Carries what the instance DID reach, so callers can decide (clamp to the end of the archive, or explain)."""

    def __init__(self, tail, redo_lsn=None, last_xact=None):
        msg = ("the requested recovery target is beyond the last archived WAL%s: PostgreSQL replayed everything available and stopped.\n%s"
               % (" (replayed up to %s)" % redo_lsn if redo_lsn else "", tail))
        EngineError.__init__(self, "PGA-PITR-014", msg, "choose a point inside the recoverable window (the timeline shows it), use 'last available instant', or wait for the next WAL segment to be archived")
        self.redo_lsn, self.last_xact, self.tail = redo_lsn, last_xact, tail


_NOT_REACHED = "recovery ended before configured recovery target was reached"


def death_error(logfile, where):
    """The instance exited while recovering: say WHY in terms the user can act on."""
    tail = tail_file(logfile, 60)
    if _NOT_REACHED in tail:
        m = re.search(r"redo done at ([0-9A-Fa-f]+/[0-9A-Fa-f]+)(?:.*?last completed transaction was at log time ([^\n]+))?", tail, re.S)
        return TargetNotReached(tail_file(logfile, 12), m.group(1) if m else None, m.group(2).strip() if m and m.group(2) else None)
    return EngineError("PGA-PITR-010", "the ephemeral instance stopped %s:\n%s" % (where, tail_file(logfile, 40)),
                       "common causes: WAL gap, target before consistency, missing extension library; see the log tail above")


def free_port():
    return ephcfg.free_port()


def read_pg_control(conn, datadir):
    rc, out, err = run_tool(conn, "pg_controldata", ["-D", datadir], timeout=30, extra_env={"LC_ALL": "C", "LANG": "C"})   # labels are translated otherwise
    if rc != 0:
        raise EngineError("PGA-GEN-050", "pg_controldata failed on %s: %s" % (datadir, err.strip()))
    mapping = {"max_connections setting": "max_connections", "max_worker_processes setting": "max_worker_processes",
               "max_wal_senders setting": "max_wal_senders", "max_prepared_xacts setting": "max_prepared_xacts",
               "max_locks_per_xact setting": "max_locks_per_xact", "wal_level setting": "wal_level", "Database block size": "block_size",
               "Latest checkpoint's TimeLineID": "timeline", "Database cluster state": "state"}
    res = {}
    for line in out.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            if k.strip() in mapping:
                res[mapping[k.strip()]] = v.strip().split()[0] if v.strip() else ""
    return res


def quarantine_config(scratch, pgcontrol, port, sockdir, restore_cmd, sparse=False, shared_buffers="256MB", base_conf_missing=False, profile=None):
    """Rewrite the instance configuration with an allowlist approach. Returns (removed, forced)."""
    removed = []
    for fn in ("postgresql.conf", "postgresql.auto.conf"):
        path = os.path.join(scratch, fn)
        if not os.path.exists(path):
            continue
        out = []
        with open(path, "r", errors="replace") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#"):
                    out.append(line)
                    continue
                key = s.split("=")[0].split()[0].strip("'\"").lower() if "=" in s or s.split() else ""
                if key in GUC_REMOVE or key.startswith("recovery_target"):      # stale recovery targets in the backed-up conf would clash with the one we write
                    removed.append((fn, key))
                    out.append("# [pg_arca quarantine] " + line)
                    continue
                if key == "shared_preload_libraries":
                    val = s.split("=", 1)[1].split("#")[0].strip().strip("'\"") if "=" in s else ""
                    libs = [x.strip() for x in val.split(",") if x.strip()]
                    blocked = [x for x in libs if x in GUC_BLOCKED_LIBS]
                    removed.extend((fn, "lib:" + b) for b in blocked)
                    out.append("# [pg_arca quarantine] " + line)
                    out.append("shared_preload_libraries = '%s'\n" % ",".join(x for x in libs if x not in GUC_BLOCKED_LIBS))
                    continue
                out.append(line)
        with open(path, "w") as f:
            f.writelines(out)
    forced = {"listen_addresses": "''", "port": str(port), "unix_socket_directories": "'%s'" % sockdir, "unix_socket_permissions": "0700",
              "archive_mode": "off", "hot_standby": "on", "default_transaction_read_only": "on", "fsync": "off", "full_page_writes": "off",
              "synchronous_commit": "off", "logging_collector": "off", "log_destination": "'stderr'", "ssl": "off", "autovacuum": "off",
              "restore_command": "'%s'" % restore_cmd.replace("'", "''"), "wal_level": "replica", "shared_buffers": shared_buffers,
              "huge_pages": "off", "log_min_messages": "warning", "hba_file": "'%s'" % os.path.join(scratch, "pg_hba.conf"),
              "ident_file": "'%s'" % os.path.join(scratch, "pg_ident.conf"), "max_wal_senders": "0"}
    if profile is not None and profile.recovery_conf_file:
        forced.pop("restore_command")                  # before 12 restore_command is a recovery.conf setting: as a GUC it would stop the server from starting
    if sparse:
        # missing relation pages are EXPECTED in a sparse extraction: log them instead of PANICing at end of recovery
        forced["ignore_invalid_pages"] = "on"
    # E-02: these must NOT be lower than the source, or hot standby refuses to start. Read from pg_control, never guessed.
    for guc, key in (("max_connections", "max_connections"), ("max_worker_processes", "max_worker_processes"), ("max_wal_senders", "max_wal_senders"),
                     ("max_prepared_transactions", "max_prepared_xacts"), ("max_locks_per_transaction", "max_locks_per_xact")):
        v = pgcontrol.get(key)
        if v not in (None, ""):
            forced[guc] = str(int(v))
    for fn in ("postgresql.conf", "postgresql.auto.conf"):        # auto.conf is read LAST: forcing only postgresql.conf lets a backed-up auto.conf win (port, listen_addresses, archive_mode...)
        with open(os.path.join(scratch, fn), "a") as f:
            f.write("\n# ==== pg_arca: forced configuration of the ephemeral instance (generated %s) ====\n" % iso())
            for k, v in forced.items():
                f.write("%s = %s\n" % (k, v))
    with open(os.path.join(scratch, "pg_hba.conf"), "w") as f:
        f.write("# pg_arca ephemeral: unix socket only, private 0700 directory\nlocal all all trust\n")
    with open(os.path.join(scratch, "pg_ident.conf"), "w") as f:
        f.write("# empty\n")
    return removed, forced


class Ephemeral(object):
    def __init__(self, ctx, name=None, shared_buffers="256MB"):
        if os.geteuid() == 0:
            raise EngineError("PGA-SEC-002", "refusing to start PostgreSQL as root", "run the agent as the postgres OS user")
        self.ctx = ctx
        self.name = name or ("eph-" + uuid.uuid4().hex[:8])
        if not re.match(r"^[A-Za-z0-9_.-]{1,64}$", self.name):
            raise EngineError("PGA-GEN-064", "invalid ephemeral instance name")
        root = ctx.scratch_dir
        try:
            os.makedirs(root, mode=0o700, exist_ok=True)
        except OSError as e:
            raise EngineError("PGA-SEC-020", "cannot create scratch directory %s: %s" % (root, e), "set scratch_dir to a writable path with enough space")
        self.dir = os.path.join(root, self.name)
        if os.path.exists(self.dir):
            raise EngineError("PGA-SEC-021", "scratch directory exists: %s" % self.dir, "the engine never reuses a directory")
        os.makedirs(self.dir, mode=0o700)
        self.sock = os.path.join(self.dir, ".s")
        os.makedirs(self.sock, mode=0o700)
        eph = getattr(ctx, "eph", None) or {}
        self.port = ephcfg.free_port(eph)
        self.bindir = ctx.conn.bindir                              # re-chosen in build() once the major version of the backup is known
        self.bin_source = "node"
        self.keep_on_failure = bool(eph.get("keep_on_failure"))
        if shared_buffers == "256MB" and eph.get("shared_buffers_mb"):
            shared_buffers = "%dMB" % eph["shared_buffers_mb"]
        self.proc = None
        self.logf = None
        self.shared_buffers = shared_buffers
        with open(os.path.join(self.dir, ".pgarca-scratch"), "w") as f:
            json.dump({"name": self.name, "pid": os.getpid(), "created": iso(), "stanza": ctx.stanza, "engine": ENGINE_VERSION}, f)

    # ------------------------------------------------------------------ build
    def conn(self, dbname="postgres"):
        return PgConn(host=self.sock, port=self.port, user=self.ctx.conn.user, dbname=dbname, bindir=self.bindir)

    def build(self, chain, keep_oids=None, target_time=None, target_lsn=None, target_xid=None, target_name=None, inclusive=True, immediate=False,
              progress=None, cancel=None):
        repo = self.ctx.repo
        prof = set_profile(chain[0]) or Profile(160000)
        require_supported(prof, "recovering this backup")
        self.bindir, self.bin_source = ephcfg.pick_bindir(int(prof.major), getattr(self.ctx, "eph", None), self.ctx.conn.bindir)
        require_same_major(prof, binary_profile(os.path.join(self.bindir, "postgres") if self.bindir else "postgres"), "starting a recovery instance for this backup")
        cat = repo.load_catalog(chain[-1])
        sparse = keep_oids is not None
        include = None
        if sparse:
            keep = set(keep_oids) | {1, 5}                 # template1 (oid 1) and postgres (oid 5) are always needed: connections + CREATE DATABASE
            include = sparse_filter(keep)
        merged, tbs = merge_chain(repo, chain, include)
        full_size = estimate(merge_chain(repo, chain)[0]) if sparse else estimate(merged)
        # tablespaces always re-rooted inside the scratch directory
        remap = {str(oid): os.path.join(self.dir, "tblspc", str(oid)) for oid in tbs}
        os.makedirs(os.path.join(self.dir, "pg_tblspc"), mode=0o700, exist_ok=True)
        for oid, tgt in remap.items():
            os.makedirs(tgt, mode=0o700, exist_ok=True)
            os.symlink(tgt, os.path.join(self.dir, "pg_tblspc", oid))
        stats = materialize(self.ctx, merged, self.dir, False, progress, cancel)
        stats["selected_bytes"], stats["cluster_bytes"] = estimate(merged), full_size
        prepare_skeleton(self.dir, cat)
        install_external_conf(self.dir, merged)
        shutil.copy2(repo.sp("backup", chain[0]["id"], "backup_label"), os.path.join(self.dir, "backup_label"))   # ALWAYS the base full's label
        for junk in ("standby.signal", "postmaster.pid", "tablespace_map"):
            p = os.path.join(self.dir, junk)
            if os.path.exists(p):
                os.remove(p)
        ctl = read_pg_control(self.conn(), self.dir)
        removed, forced = quarantine_config(self.dir, ctl, self.port, self.sock, self.ctx.restore_command, sparse, self.shared_buffers, profile=prof)
        from pg_arca.engine.restore import effective_targets
        t_lsn, t_imm = effective_targets(chain, target_lsn, immediate, self.ctx)
        prof.install_recovery(self.dir, recovery_lines(self.ctx.restore_command, target_time, t_lsn, target_xid, target_name, t_imm, "pause", inclusive))
        # recovery_lines wrote restore_command again into auto.conf: harmless and identical, but keep the quarantine invariant
        bad = [b for b in audit_symlinks(self.dir)]
        if bad:
            self.cleanup()
            raise EngineError("PGA-SEC-011", "symlink audit failed: %s" % "; ".join("%s -> %s" % b for b in bad[:3]),
                              "an ephemeral instance could otherwise write into production tablespaces; operation aborted")
        os.chmod(self.dir, 0o700)
        stats["guc_removed"], stats["guc_forced"] = len(removed), len(forced)
        return stats

    # ------------------------------------------------------------------ run
    def start(self, wait=900, cancel=None):
        logfile = os.path.join(self.dir, "pg_arca-ephemeral.log")
        self.logf = open(logfile, "ab")
        cmd = [os.path.join(self.bindir, "postgres") if self.bindir else "postgres", "-D", self.dir]
        try:
            self.proc = subprocess.Popen(cmd, stdout=self.logf, stderr=self.logf, preexec_fn=os.setsid, close_fds=True)
        except OSError as e:
            self.cleanup()
            raise EngineError("PGA-CFG-004", "cannot execute postgres: %s" % e)
        t0 = time.time()
        sockpath = os.path.join(self.sock, ".s.PGSQL.%d" % self.port)
        while time.time() - t0 < wait:
            _check_cancel(cancel)
            if self.proc.poll() is not None:
                err = death_error(logfile, "during recovery")
                self.cleanup()
                raise err
            if os.path.exists(sockpath):
                try:
                    s = PgSession(self.conn("postgres"), read_only=True)
                    s.close()
                    return time.time() - t0
                except EngineError:
                    pass
            time.sleep(0.4)
        self.cleanup()
        raise EngineError("PGA-PITR-011", "timeout starting the ephemeral instance (%ds)" % wait, "see %s" % logfile)

    def wait_target(self, timeout=3600, cancel=None, progress=None):
        s = PgSession(self.conn("postgres"), read_only=True)
        t0 = time.time()
        try:
            while time.time() - t0 < timeout:
                _check_cancel(cancel)
                if self.proc is not None and self.proc.poll() is not None:
                    raise death_error(os.path.join(self.dir, "pg_arca-ephemeral.log"), "while recovering")
                inrec = s.scalar("SELECT pg_is_in_recovery()")
                lsn = s.scalar("SELECT COALESCE(pg_last_wal_replay_lsn()::text,'-')")
                try:
                    paused = inrec != "f" and s.scalar(s.profile.replay_paused_sql()) == "1"
                except EngineError as e:
                    # with no target the instance finishes recovery and promotes ITSELF between the two queries above: the pause-state function then
                    # raises "recovery is not in progress". That is the success path, not an error: look again.
                    if "not in progress" in (e.message or ""):
                        continue
                    raise
                if progress:
                    progress({"phase": "recovery", "replay_lsn": lsn})
                if paused or inrec == "f":
                    last_xact = s.scalar("SELECT COALESCE(pg_last_xact_replay_timestamp()::text,'')")
                    if paused and inrec != "f":
                        self._promote(s, deadline=t0 + timeout)
                    return time.time() - t0, lsn, last_xact
                time.sleep(1)
        finally:
            s.close()
        raise EngineError("PGA-PITR-012", "recovery did not reach the target within %ds" % timeout, "check WAL availability in the archive")

    def _promote(self, s, deadline):
        """End recovery at the target. Stopping at the target leaves every transaction that was still open there 'in progress', and its locks too: a DROP / TRUNCATE /
        ALTER TABLE that committed just AFTER the target holds an ACCESS EXCLUSIVE lock on the table in the paused standby, so reading exactly the table we want to
        recover (the usual reason for a restore) would block forever. Promoting aborts those transactions and releases the locks. The instance is a throw-away copy
        with archiving and replication stripped (quarantine_config), so nothing leaves it."""
        s.scalar("SELECT pg_wal_replay_resume()")
        while time.time() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                raise death_error(os.path.join(self.dir, "pg_arca-ephemeral.log"), "while ending recovery")
            if s.scalar("SELECT pg_is_in_recovery()") == "f":
                return
            time.sleep(0.5)
        raise EngineError("PGA-PITR-013", "the ephemeral instance did not leave recovery in time")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGINT)
                self.proc.wait(timeout=60)
            except Exception:
                try:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                    self.proc.wait(timeout=10)
                except Exception:
                    pass

    def cleanup(self, keep=False):
        self.stop()
        try:
            if self.logf:
                self.logf.close()
        except Exception:
            pass
        if not keep and self.keep_on_failure and sys.exc_info()[0] is not None:
            keep = True
            self.ctx.log("warn", "ephemeral instance kept for inspection (keep_on_failure): %s" % self.dir)
        if keep:
            return
        shutil.rmtree(self.dir, ignore_errors=True)


def reap_stale(ctx, ttl=4 * 3600):
    """Remove scratch dirs whose creator process is gone and whose age exceeds ttl; kill leftover postmasters."""
    root, n = ctx.scratch_dir, 0
    if not os.path.isdir(root):
        return 0
    for d in sorted(os.listdir(root)):
        p = os.path.join(root, d)
        m = os.path.join(p, ".pgarca-scratch")
        if not os.path.exists(m):
            continue
        try:
            info = json.load(open(m))
            os.kill(info.get("pid", -1), 0)
            continue
        except (ValueError, IOError, OSError):
            pass
        if time.time() - os.path.getmtime(m) < ttl:
            continue
        pidf = os.path.join(p, "postmaster.pid")
        if os.path.exists(pidf):
            try:
                pid = int(open(pidf).readline().strip())
                os.kill(pid, signal.SIGINT)
                time.sleep(2)
                os.kill(pid, signal.SIGKILL)
            except (ValueError, OSError):
                pass
        shutil.rmtree(p, ignore_errors=True)
        n += 1
    return n
