"""Engine context: everything an engine operation needs, built from the agent config."""

import os

from pg_arca.engine.pgsession import PgConn
from pg_arca.engine.repo import Repo
from pg_arca.wal_manager import WalManager


class Ctx(object):
    def __init__(self, conn, pgdata, repo_path, stanza, wal_dir, scratch_dir, process_max=4, compression="zstd", level=3,
                 start_fast=False, retention_full=2, retention_days=0, seg_size=16 * 1024 * 1024, log=None, agent_path=None,
                 protected_extra=None):
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
        self.wal = WalManager(wal_dir, compression, level, seg_size)
        algo = "zstd" if compression == "zstd" else ("none" if compression == "none" else "zlib")
        self.repo = Repo(repo_path, stanza, self.wal, algo=algo, level=level)
        self._log = log
        self.agent_path = agent_path or os.environ.get("PG_ARCA_WAL_BIN", "/usr/local/bin/pg-arca-wal")
        self.protected_extra = protected_extra or []

    def log(self, level, msg):
        if self._log:
            self._log(level, msg)

    @property
    def restore_command(self):
        """restore_command for ephemeral / restored instances (quoted for postgresql.conf by the caller)."""
        home = os.path.dirname(os.path.realpath(self.agent_path))
        return "env WAL_ARCHIVE_DIR=%s PG_ARCA_HOME=%s PG_ARCA_CONF=/nonexistent %s get %%f %%p" % (_shq(self.wal_dir), _shq(home), _shq(self.agent_path))

    @classmethod
    def from_config(cls, config, runtime=None, log=None):
        inst = (runtime.instance if runtime else None) or {}
        db = runtime.db if runtime else None
        conn = PgConn(host=(getattr(db, "socket_dir", None) or getattr(db, "host", "") or ""), port=getattr(db, "port", 5432) or 5432,
                      user=config.get("pg_user", "postgres"), bindir=config.get("pg_bin_dir", "") or _guess_bindir(inst))
        stanza = config.get("stanza") or _stanza_name(inst) or "main"
        seg = ((inst.get("control") or {}).get("wal_segment_size")) or 16 * 1024 * 1024
        here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        wal_bin = config.get("wal_bin") or (os.path.join(here, "pg-arca-wal") if os.path.exists(os.path.join(here, "pg-arca-wal")) else None)
        return cls(conn, config.get("pg_data") or inst.get("data_directory") or "", config["repo_path"], stanza, config["wal_archive_dir"],
                   config.get("scratch_dir", "/var/tmp/pg_arca_scratch"), config.get("process_max", 4), config.get("compression", "zstd"),
                   config.get("compression_level", 3), bool(config.get("start_fast", False)), config.get("retention_full", 2),
                   config.get("retention_days", 0), seg, log, wal_bin)


def _shq(s):
    return "'" + str(s).replace("'", "'\\''") + "'"


def _stanza_name(inst):
    key = inst.get("cluster_key") or ""
    if not key:
        return ""
    import re
    return re.sub(r"[^A-Za-z0-9_.-]", "_", key.replace(":", "-"))[:60]


def _guess_bindir(inst):
    ver = str(inst.get("version") or inst.get("major_version") or "").split(".")[0]
    for cand in ("/usr/lib/postgresql/%s/bin" % ver, "/usr/pgsql-%s/bin" % ver, "/usr/local/pgsql/bin"):
        if ver and os.path.isdir(cand):
            return cand
    return ""
