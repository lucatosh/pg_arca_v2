"""
pg_arca PostgreSQL client (psql based, Python 3.6+ compatible)
===============================================================
The agent runs as the postgres OS user and talks to the local instance through the unix socket
(peer auth): no password is stored anywhere. Values are never interpolated into SQL text:
user-controlled values go through psql variables (-v name=value + :'name' / :"name"), which
quotes them server-side-safely.
"""

import json
import logging
import os
import re
import subprocess

logger = logging.getLogger("pg_arca.db_client")

SNAPSHOT_SETTINGS = (
    "port", "listen_addresses", "wal_level", "archive_mode", "archive_command", "archive_timeout", "max_wal_senders",
    "max_connections", "wal_log_hints", "data_checksums", "shared_preload_libraries", "hot_standby", "max_wal_size",
    "shared_buffers", "work_mem", "maintenance_work_mem", "effective_cache_size", "checkpoint_timeout",
    "checkpoint_completion_target", "synchronous_standby_names", "synchronous_commit", "wal_compression",
    "wal_keep_size", "autovacuum", "cluster_name", "data_directory", "unix_socket_directories",
)

SNAPSHOT_SQL = """
SELECT json_build_object(
  'version', current_setting('server_version'),
  'is_in_recovery', pg_is_in_recovery(),
  'role', CASE WHEN pg_is_in_recovery() THEN 'standby' ELSE 'primary' END,
  'current_lsn', CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()::text ELSE pg_current_wal_lsn()::text END,
  'timeline', (SELECT timeline_id FROM pg_control_checkpoint()),
  'system_identifier', (SELECT system_identifier::text FROM pg_control_system()),
  'port', current_setting('port')::int,
  'databases', (SELECT COALESCE(json_agg(json_build_object('oid', oid::int, 'name', datname, 'size', pg_database_size(oid)) ORDER BY datname), '[]'::json)
                  FROM pg_database WHERE NOT datistemplate AND datallowconn),
  'connections', json_build_object('used', (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'),
                                   'max', current_setting('max_connections')::int),
  'xact_total', (SELECT COALESCE(sum(xact_commit + xact_rollback), 0) FROM pg_stat_database),
  'archiver', (SELECT row_to_json(a) FROM (SELECT archived_count, failed_count, last_archived_wal, last_archived_time,
                                                  last_failed_wal, last_failed_time FROM pg_stat_archiver) a),
  'settings', (SELECT json_object_agg(name, setting) FROM pg_settings WHERE name = ANY(string_to_array(:'keys', ','))),
  'pending_restart', (SELECT COALESCE(json_agg(name), '[]'::json) FROM pg_settings WHERE pending_restart)
);
"""

REPLICATION_SQL = """
SELECT COALESCE(json_agg(json_build_object(
  'application_name', application_name, 'client_addr', client_addr::text, 'state', state, 'sync_state', sync_state,
  'sent_lsn', sent_lsn::text, 'replay_lsn', replay_lsn::text,
  'replay_lag_bytes', COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0)::bigint,
  'replay_lag_ms', COALESCE(EXTRACT(EPOCH FROM replay_lag) * 1000, 0)::bigint)), '[]'::json)
FROM pg_stat_replication;
"""


class PostgresClient:
    def __init__(self, user="postgres", port=5432, host="", socket_dir=None, psql_path="psql"):
        self.user = user
        self.port = str(port)
        self.host = host
        self.socket_dir = socket_dir
        self.psql = psql_path

    # -- plumbing ---------------------------------------------------------
    def run_cmd(self, cmd_list, timeout=20, input_text=None, env=None):
        """Run a command. Returns (success, stdout, stderr)."""
        try:
            proc = subprocess.run(cmd_list, stdout=subprocess.PIPE, stderr=subprocess.PIPE, input=input_text,
                                  universal_newlines=True, timeout=timeout, env=env)
            return proc.returncode == 0, proc.stdout.strip(), proc.stderr.strip()
        except subprocess.TimeoutExpired:
            return False, "", "Command timed out after %ss" % timeout
        except FileNotFoundError as e:
            return False, "", "Binary not found: %s" % e
        except Exception as e:  # pragma: no cover
            return False, "", str(e)

    def _conn_args(self, dbname):
        cmd = [self.psql, "-X", "-q", "-U", self.user]
        target = self.socket_dir or self.host
        if target:
            cmd += ["-h", target]
        cmd += ["-p", self.port, "-d", dbname]
        return cmd

    def _env(self):
        env = dict(os.environ)
        env.setdefault("PGCONNECT_TIMEOUT", "5")
        env["PGAPPNAME"] = "pg_arca_agent"
        env["PGOPTIONS"] = "-c statement_timeout=20000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000"
        return env

    def run_psql(self, query, dbname="postgres", timeout=25, variables=None, read_only=False):
        """
        Execute SQL (script via stdin so psql variables/\\gexec work). Returns (ok, stdout, stderr).
        `variables` are bound with -v and referenced as :'name' (literal) or :"name" (identifier).
        """
        cmd = self._conn_args(dbname) + ["-At", "-v", "ON_ERROR_STOP=1"]
        for k, v in (variables or {}).items():
            if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", k):
                raise ValueError("bad psql variable name %r" % k)
            cmd += ["-v", "%s=%s" % (k, v)]
        env = self._env()
        if read_only:
            env["PGOPTIONS"] += " -c default_transaction_read_only=on"
        return self.run_cmd(cmd + ["-f", "-"], timeout=timeout, input_text=query, env=env)

    def query_json(self, sql, dbname="postgres", variables=None, timeout=25):
        ok, out, err = self.run_psql(sql, dbname=dbname, variables=variables, timeout=timeout, read_only=True)
        if not ok:
            return None, err
        try:
            return json.loads(out) if out else None, ""
        except ValueError as e:
            return None, "unparseable psql output: %s" % e

    def ping(self):
        ok, out, _ = self.run_psql("SELECT 1;", read_only=True)
        return ok and out.strip() == "1"

    # -- telemetry --------------------------------------------------------
    def get_snapshot(self):
        """Full telemetry for the console. Never raises; on failure returns {'alive': False, 'error': ...}."""
        snap, err = self.query_json(SNAPSHOT_SQL, variables={"keys": ",".join(SNAPSHOT_SETTINGS)})
        if not isinstance(snap, dict):
            return {"alive": False, "error": err or "no data"}
        snap["alive"] = True
        snap["replication"] = []
        if not snap.get("is_in_recovery"):
            rep, _ = self.query_json(REPLICATION_SQL)
            snap["replication"] = rep if isinstance(rep, list) else []
        return snap

    def get_cluster_state(self):  # backwards-compatible light view
        s = self.get_snapshot()
        return {"alive": s.get("alive", False), "version": s.get("version"), "is_in_recovery": s.get("is_in_recovery"),
                "role": s.get("role"), "current_lsn": s.get("current_lsn"), "timeline": s.get("timeline"),
                "system_identifier": s.get("system_identifier")}

    def get_databases(self):
        s, _ = self.query_json("SELECT COALESCE(json_agg(json_build_object('oid', d.oid::int, 'name', d.datname, "
                               "'size', pg_database_size(d.oid), 'tablespace', t.spcname)), '[]'::json) "
                               "FROM pg_database d JOIN pg_tablespace t ON t.oid = d.dattablespace WHERE NOT d.datistemplate;")
        return s or []

    def get_database_objects(self, dbname):
        s, err = self.query_json(
            "SELECT COALESCE(json_agg(json_build_object('schema', n.nspname, 'table', c.relname, 'kind', c.relkind::text, "
            "'relfilenode', pg_relation_filenode(c.oid)::text, 'size_bytes', pg_total_relation_size(c.oid), "
            "'rows_estimate', c.reltuples::bigint)), '[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE c.relkind IN ('r','p','m') AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast');", dbname=dbname)
        if s is None:
            raise RuntimeError(err or "query failed")
        return s

    # -- parameters -------------------------------------------------------
    def alter_system(self, name, value):
        """Idempotent ALTER SYSTEM + reload. Returns dict(before, after, changed, restart_required)."""
        if not re.match(r"^[a-z_][a-z0-9_.]{0,62}$", name):
            raise ValueError("invalid parameter name")
        info, err = self.query_json("SELECT json_build_object('setting', setting, 'context', context) FROM pg_settings WHERE name = :'pname';",
                                    variables={"pname": name})
        if not info:
            raise RuntimeError("unknown parameter %s" % name)
        if value is None:
            sql = "ALTER SYSTEM RESET :\"pname\"; SELECT pg_reload_conf();"
            variables = {"pname": name}
        else:
            sql = "ALTER SYSTEM SET :\"pname\" = :'pval'; SELECT pg_reload_conf();"
            variables = {"pname": name, "pval": str(value)}
        ok, out, e = self.run_psql(sql, variables=variables)
        if not ok:
            raise RuntimeError(e or "ALTER SYSTEM failed")
        after, _ = self.query_json("SELECT json_build_object('setting', setting, 'pending', pending_restart) FROM pg_settings WHERE name = :'pname';",
                                   variables={"pname": name})
        after = after or {}
        return {"before": info.get("setting"), "after": after.get("setting"),
                "restart_required": bool(after.get("pending")) or info.get("context") == "postmaster",
                "changed": info.get("setting") != after.get("setting") or bool(after.get("pending"))}

    # -- integrity --------------------------------------------------------
    def verify_amcheck(self, dbname):
        """Returns (status, report): status True=clean, False=corruption, None=could not run (reported, never silently 'passed')."""
        ok, _, err = self.run_psql("CREATE EXTENSION IF NOT EXISTS amcheck;", dbname=dbname)
        if not ok:
            return None, "amcheck unavailable: %s" % (err or "extension missing")
        cmd = ["pg_amcheck", "-U", self.user, "-p", self.port, "-d", dbname, "--heapallindexed"]
        target = self.socket_dir or self.host
        if target:
            cmd += ["-h", target]
        ok_am, out_am, err_am = self.run_cmd(cmd, timeout=3600)
        return ok_am, (out_am or err_am or "no corruption detected")
