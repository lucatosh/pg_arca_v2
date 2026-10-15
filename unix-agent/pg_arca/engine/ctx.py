"""Engine context: everything an engine operation needs, built from the agent config."""

import os

from pg_arca.engine.pgsession import PgConn
from pg_arca.engine.repo import Repo
from pg_arca.wal_manager import WalManager


class Ctx(object):
    def __init__(self, conn, pgdata, repo_path, stanza, wal_dir, scratch_dir, process_max=4, compression="zstd", level=3,
                 start_fast=False, retention_full=2, retention_days=0, seg_size=16 * 1024 * 1024, log=None, agent_path=None,
                 protected_extra=None, key_file=None, repo_previous=None, wal_previous=None):
        self.conn = conn
        self.pgdata = os.path.realpath(pgdata) if pgdata else ""
        self.stanza = stanza
        self.scratch_dir = scratch_dir
        self.process_max = max(1, int(process_max or 1))
        self.start_fast = start_fast
        self.retention_full = int(retention_full)
        self.retention_days = int(retention_days or 0)
        self.seg_size = seg_size
        self.wal_dir = wal_dir
        from pg_arca.engine.crypt import from_settings
        self.key_file = key_file or ""
        self.crypto = from_settings(key_file)
        self.wal = WalManager(wal_dir, compression, level, seg_size, crypto=self.crypto, previous=wal_previous)
        algo = "zstd" if compression == "zstd" else ("none" if compression == "none" else "zlib")
        self.repo = Repo(repo_path, stanza, self.wal, algo=algo, level=level, crypto=self.crypto, previous=repo_previous)
        self._log = log
        self.agent_path = agent_path or os.environ.get("PG_ARCA_WAL_BIN", "/usr/local/bin/pg-arca-wal")
        self.protected_extra = protected_extra or []
        self.eph = {}                                              # ephemeral-instance settings (engine/ephcfg.py): scratch dir, binaries, ports, memory

    def set_ephemeral(self, settings):
        """Apply validated ephemeral-instance settings (from the console's global/environment/cluster configuration or agent.conf)."""
        from pg_arca.engine import ephcfg
        self.eph = ephcfg.normalize(settings)
        if self.eph.get("scratch_dir"):
            self.scratch_dir = self.eph["scratch_dir"]
        return self

    def log(self, level, msg):
        if self._log:
            self._log(level, msg)

    @property
    def restore_command(self):
        """restore_command for ephemeral / restored instances (quoted for postgresql.conf by the caller)."""
        import pg_arca
        home = os.path.dirname(os.path.dirname(os.path.realpath(pg_arca.__file__)))      # the directory that contains the pg_arca package (/opt/pg-arca when installed): pg-arca-wal itself may live in /usr/local/bin
        kf = " PG_ARCA_KEY_FILE=%s" % _shq(self.key_file) if self.key_file else ""
        sp = ""
        if int(os.environ.get("PG_ARCA_PREFETCH", "10") or 0) > 0 and self.scratch_dir:       # read-ahead spool (pg_arca/walprefetch.py); PG_ARCA_PREFETCH=0 turns it off
            sp = " PG_ARCA_SPOOL=%s" % _shq(self.spool_dir)
        pv = ""
        if getattr(self.wal, "previous", None):                    # earlier archive locations (destination changed): old segments are found there
            pv = " PG_ARCA_WAL_PREVIOUS=%s" % _shq(os.pathsep.join(self.wal.previous))
        return "env WAL_ARCHIVE_DIR=%s PG_ARCA_HOME=%s PG_ARCA_CONF=/nonexistent%s%s%s %s get %%f %%p" % (_shq(self.wal_dir), _shq(home), kf, sp, pv, _shq(self.agent_path))

    @property
    def spool_dir(self):
        """Where the read-ahead of this operation's recoveries keeps the next WAL segments: unique per Ctx, under the scratch directory."""
        if not getattr(self, "_spool_id", None):
            import uuid
            self._spool_id = uuid.uuid4().hex[:10]
        return os.path.join(self.scratch_dir, "walspool-" + self._spool_id)

    def cleanup_spool(self):
        """The recovery is over: the prefetcher notices the missing directory and leaves."""
        import shutil
        import signal
        import time
        if getattr(self, "_spool_id", None):
            sp = self.spool_dir
            try:                                                # stop the prefetcher first: a worker finishing a segment would re-create the directory behind us
                with open(os.path.join(sp, ".lock")) as f:
                    pid = int(f.read().strip() or 0)
                if pid > 1:
                    os.kill(pid, signal.SIGTERM)
            except (OSError, ValueError):
                pass
            for _ in range(10):
                shutil.rmtree(sp, ignore_errors=True)
                if not os.path.exists(sp):
                    break
                time.sleep(0.05)

    @classmethod
    def from_config(cls, config, runtime=None, log=None):
        inst = (runtime.instance if runtime else None) or {}
        db = runtime.db if runtime else None
        conn = PgConn(host=(getattr(db, "socket_dir", None) or getattr(db, "host", "") or ""), port=getattr(db, "port", 5432) or 5432,
                      user=getattr(db, "user", None) or config.get("pg_user") or "postgres", bindir=config.get("pg_bin_dir", "") or _guess_bindir(inst))
        # explicit stanza (agent.conf) > the one the console assigns to every site of a geo-redundant database (one catalogue per database) > derived
        stanza = config.get("stanza") or config.get("stanza_shared") or _stanza_name(inst) or "main"
        seg = ((inst.get("control") or {}).get("wal_segment_size")) or 16 * 1024 * 1024
        here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        wal_bin = config.get("wal_bin") or (os.path.join(here, "pg-arca-wal") if os.path.exists(os.path.join(here, "pg-arca-wal")) else None)
        # never restore into (or above/below) the repository, the WAL archive, the agent state/config or the key file
        keep = [config.get("repo_path"), config.get("wal_archive_dir"), config.get("state_dir"), os.path.dirname(config.get("credentials_file") or ""), config.get("encryption_key_file")] \
            + list(config.get("repo_previous") or []) + list(config.get("wal_previous") or [])
        ctx = cls(conn, _resolve_pgdata(config, inst, log), config["repo_path"], stanza, config["wal_archive_dir"],
                  config.get("scratch_dir", "/var/tmp/pg_arca_scratch"), config.get("process_max", 4), config.get("compression", "zstd"),
                  config.get("compression_level", 3), bool(config.get("start_fast", False)), config.get("retention_full", 2),
                  config.get("retention_days", 0), seg, log, wal_bin, key_file=config.get("encryption_key_file") or os.environ.get("PG_ARCA_KEY_FILE") or None, protected_extra=[k for k in keep if k],
                  repo_previous=config.get("repo_previous") or None, wal_previous=config.get("wal_previous") or None)
        ctx.has_offsite = bool(config.get("offsite"))                  # restore pre-flight: a missing chunk may be one download away
        return ctx


def _resolve_pgdata(config, inst, log=None):
    """The data directory to back up. The running instance (discovery / SHOW data_directory) is the authority; an explicit pg_data is honoured only if it
    really is a PGDATA, and the generic PGDATA env var is just a last-resort hint (it often points at a parent directory)."""
    def valid(p):
        return bool(p) and os.path.exists(os.path.join(p, "PG_VERSION"))
    explicit, found, hint = config.get("pg_data") or "", inst.get("data_directory") or "", config.get("pg_data_hint") or ""
    if valid(explicit):
        return explicit
    if explicit and log:
        log("warning", "configured pg_data %s is not a PGDATA (no PG_VERSION): using the detected data directory %s" % (explicit, found or "(none)"))
    for cand in (found, hint, explicit):
        if valid(cand):
            return cand
    return found or hint or explicit


def _shq(s):
    return "'" + str(s).replace("'", "'\\''") + "'"


def _stanza_name(inst):
    key = inst.get("cluster_key") or ""
    if not key:
        return ""
    import re
    return re.sub(r"[^A-Za-z0-9_.-]", "_", key.replace(":", "-"))[:60]


def _guess_bindir(inst):
    found = inst.get("bin_dir")                                  # discovery: the directory of the RUNNING postmaster's binary beats any naming convention
    if found and os.path.isfile(os.path.join(found, "psql")) or found and os.path.isfile(os.path.join(found, "pg_ctl")):
        return found
    ver = str(inst.get("version") or inst.get("major_version") or "").split(".")[0]
    for cand in ("/usr/lib/postgresql/%s/bin" % ver, "/usr/pgsql-%s/bin" % ver, "/usr/local/pgsql/bin"):
        if ver and os.path.isdir(cand):
            return cand
    from pg_arca import pgaccess                                 # last resorts: the PATH, then any vendor directory (newest first)
    p = pgaccess.find_tool("pg_ctl", {}, inst)
    return os.path.dirname(p) if os.path.isabs(p) else ""
