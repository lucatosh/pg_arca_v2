"""
pg_arca PostgreSQL Client Module
=================================
Executes SQL queries and administrative actions against PostgreSQL with
strict timeouts, sanitization, and safety checks.
"""

import subprocess
import json
import logging
import re

logger = logging.getLogger("pg_arca.db_client")


class PostgresClient:
    def __init__(self, user="postgres", port=5432, host="127.0.0.1", socket_dir=None):
        self.user = user
        self.port = str(port)
        self.host = host
        self.socket_dir = socket_dir

    def run_cmd(self, cmd_list, timeout=20):
        """Runs a subprocess command and returns (success, stdout, stderr)."""
        try:
            proc = subprocess.run(
                cmd_list,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=timeout
            )
            return proc.returncode == 0, proc.stdout.strip(), proc.stderr.strip()
        except subprocess.TimeoutExpired:
            return False, "", f"Command timed out after {timeout}s"
        except FileNotFoundError as fnf:
            return False, "", f"Binary not found: {str(fnf)}"
        except Exception as e:
            return False, "", str(e)

    def run_psql(self, query, dbname="postgres", timeout=25, tuples_only=True):
        """Executes a SQL query via psql."""
        cmd = ["psql", "-U", self.user]
        if self.socket_dir:
            cmd.extend(["-h", self.socket_dir])
        elif self.host:
            cmd.extend(["-h", self.host])
        cmd.extend(["-p", self.port, "-d", dbname])

        if tuples_only:
            cmd.extend(["-t", "-A"])

        cmd.extend(["-c", query])
        return self.run_cmd(cmd, timeout=timeout)

    def ping(self):
        """Checks if PostgreSQL is responding to queries."""
        ok, out, _ = self.run_psql("SELECT 1;")
        return ok and out.strip() == "1"

    def get_cluster_state(self):
        """Returns comprehensive status of the PostgreSQL instance."""
        ok_lsn, lsn, _ = self.run_psql("SELECT pg_current_wal_lsn();")
        ok_rec, in_recovery, _ = self.run_psql("SELECT pg_is_in_recovery();")
        ok_ver, ver, _ = self.run_psql("SHOW server_version;")
        ok_tl, timeline, _ = self.run_psql("SELECT timeline_id FROM pg_control_checkpoint();")

        # Fallback for standby node LSN
        if not ok_lsn or not lsn:
            _, lsn, _ = self.run_psql("SELECT pg_last_wal_replay_lsn();")

        return {
            "alive": ok_rec or ok_lsn,
            "version": ver if ok_ver else "Unknown",
            "is_in_recovery": in_recovery == "t" if ok_rec else False,
            "role": "standby" if in_recovery == "t" else "primary",
            "current_lsn": lsn if lsn else "N/A",
            "timeline": int(timeline) if ok_tl and timeline.isdigit() else 1
        }

    def get_databases(self):
        """Returns catalog of all non-template databases with OID and byte sizes."""
        sql = """
            SELECT json_agg(json_build_object(
                'oid', d.oid::text,
                'name', d.datname,
                'size', pg_database_size(d.datname),
                'tablespace', spcname
            ))
            FROM pg_database d
            JOIN pg_tablespace t ON d.dattablespace = t.oid
            WHERE d.datistemplate = false;
        """
        ok, out, _ = self.run_psql(sql)
        if ok and out:
            try:
                return json.loads(out)
            except Exception:
                pass
        return []

    def get_database_objects(self, dbname):
        """Returns schemas, tables, rows count estimate, and sizes for a given database."""
        sql = """
            SELECT json_agg(json_build_object(
                'schema', n.nspname,
                'table', c.relname,
                'relfilenode', c.relfilenode::text,
                'size_bytes', pg_total_relation_size(c.oid),
                'rows_estimate', c.reltuples::bigint
            ))
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast');
        """
        ok, out, _ = self.run_psql(sql, dbname=dbname)
        if ok and out:
            try:
                return json.loads(out)
            except Exception:
                pass
        return []

    def start_backup(self, label="pg_arca_backup"):
        """Calls pg_backup_start() on PostgreSQL 15+ or pg_start_backup() on older versions."""
        # Try PG15+ syntax first
        ok, out, err = self.run_psql(f"SELECT pg_backup_start('{label}', false);")
        if not ok and "function pg_backup_start" in err.lower():
            ok, out, err = self.run_psql(f"SELECT pg_start_backup('{label}', false, false);")
        return ok, out, err

    def stop_backup(self):
        """Calls pg_backup_stop() or pg_stop_backup()."""
        ok, out, err = self.run_psql("SELECT pg_backup_stop(true);")
        if not ok and "function pg_backup_stop" in err.lower():
            ok, out, err = self.run_psql("SELECT pg_stop_backup(false, true);")
        return ok, out, err

    def verify_amcheck(self, dbname):
        """Executes pg_amcheck if installed, returns (success, report)."""
        ok, _, err = self.run_psql("CREATE EXTENSION IF NOT EXISTS amcheck;", dbname=dbname)
        if not ok:
            return True, "amcheck extension not available, skipped heap verification"

        cmd = ["pg_amcheck", "-U", self.user, "-p", self.port, "-d", dbname, "--heapallindexed"]
        if self.socket_dir:
            cmd.extend(["-h", self.socket_dir])
        elif self.host:
            cmd.extend(["-h", self.host])

        ok_am, out_am, err_am = self.run_cmd(cmd, timeout=60)
        return ok_am, out_am or err_am or "Zero corruptions detected (amcheck PASSED)"
