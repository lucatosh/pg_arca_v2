"""
Operation executor: effectively-once execution of console-issued operations.

The console delivers operations AT-LEAST-ONCE (lease + redelivery). Safety comes from here:
  * every operation id is journaled on disk BEFORE it runs (atomic write + fsync);
  * a finished operation is never executed again - the stored outcome is re-reported;
  * an operation found 'running' after an agent crash is re-run only if its handler is
    declared retry-safe (idempotent); otherwise it is failed with an explicit
    "interrupted, state unknown - verify" message (a human decides, nothing is repeated blindly);
  * every mutating handler checks preconditions first and VERIFIES the effect afterwards.
"""

import json
import shlex
import shutil
import subprocess
import logging
import os
import re
import threading
import time

from pg_arca.config import atomic_write_json
from pg_arca.engine.util import Cancelled, EngineError

logger = logging.getLogger("pg_arca.executor")

PATRONI_LOCAL_PARAMS = {"listen_addresses", "port"}
DENY_PARAMS = {"data_directory", "config_file", "hba_file", "ident_file", "external_pid_file", "include", "include_dir", "include_if_exists"}


class OpError(Exception):
    """A clean, user-presentable operation failure."""


class OperationExecutor:
    def __init__(self, config, db, patroni, discovery=None, runtime=None):
        self.config = config
        self.runtime = runtime               # needed by backup / restore operations (PGDATA, socket)
        self._db, self._patroni = db, patroni
        self.discovery = discovery           # callable -> dict
        self._tl = threading.local()
        self._live = {}                      # op_id -> latest progress dict (in memory; reported with every keep-alive)
        self._cancel = set()                 # op ids with a cooperative cancel request
        self.dir = os.path.join(config.get("state_dir", "/var/lib/pgarca/state"), "ops")
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        self.handlers = {}                   # type -> (fn, retry_safe)
        self._register_builtin()
        self.prune()

    # Runtime.refresh() REPLACES its db/patroni clients (new socket, port, Patroni URL): follow it, never keep the ones from agent start.
    @property
    def db(self):
        return self.runtime.db if self.runtime is not None else self._db

    @db.setter
    def db(self, v):
        self._db = v

    @property
    def patroni(self):
        return self.runtime.patroni if self.runtime is not None else self._patroni

    @patroni.setter
    def patroni(self, v):
        self._patroni = v

    # ------------------------------------------------------------------ registry
    def register(self, op_type, fn, retry_safe):
        self.handlers[op_type] = (fn, retry_safe)

    def _register_builtin(self):
        r = self.register
        r("pg_reload", self.h_pg_reload, True)
        r("pg_restart", self.h_pg_restart, False)          # never repeated blindly after an agent restart
        r("checkpoint", self.h_checkpoint, True)
        r("wal_switch", self.h_wal_switch, False)           # switching twice would create two segments
        r("discovery_scan", self.h_discovery, True)
        r("compat_check", self.h_compat_check, True)
        r("list_objects", self.h_list_objects, True)
        r("pg_set_param", self.h_set_param, True)           # compare-before-set: idempotent
        r("patroni_switchover", self.h_switchover, False)
        r("patroni_failover", self.h_failover, False)
        r("archive_enable", self.h_archive_enable, True)       # idempotent: compares before it sets
        r("patroni_restart", self.h_restart, False)
        r("patroni_reinit", self.h_reinit, False)
        r("patroni_reload", self.h_patroni_reload, True)
        r("patroni_pause", self.h_pause, True)
        r("patroni_config_patch", self.h_config_patch, True)
        r("geo_promote", self.h_geo_promote, True)
        r("geo_demote", self.h_geo_demote, True)
        # backup / restore / PITR (engine)
        r("backup_run", self.h_backup_run, False)
        r("backup_info", self.h_backup_info, True)
        r("backup_verify", self.h_backup_verify, True)
        r("backup_expire", self.h_backup_expire, True)
        r("backup_catalog", self.h_backup_catalog, True)
        r("restore_plan", self.h_restore_plan, True)
        r("restore_instance", self.h_restore_instance, False)
        r("restored_list", self.h_restored_list, True)
        r("restored_stop", self.h_restored_stop, True)
        r("restored_start", self.h_restored_start, True)
        r("restored_resume", self.h_restored_resume, True)
        r("restored_keep", self.h_restored_keep, True)
        r("restored_drop", self.h_restored_drop, True)
        r("restore_database", self.h_restore_database, False)
        r("restore_object", self.h_restore_object, False)
        r("restore_promote", self.h_restore_promote, False)
        r("hba_expire", self.h_hba_expire, False)
        r("agent_config_get", self.h_cfg_get, True)
        r("agent_config_set", self.h_cfg_set, True)       # same input -> same file: idempotent
        r("destination_check", self.h_destination_check, True)
        r("destination_migrate", self.h_destination_migrate, True)      # resumable: running it again continues where it stopped
        r("destination_drop_old", self.h_destination_drop_old, False)
        r("ephemeral_preflight", self.h_ephemeral_preflight, True)
        r("ephemeral_install", self.h_ephemeral_install, False)
        r("restore_drill", self.h_restore_drill, False)
        r("restore_diff", self.h_restore_diff, False)
        r("restore_apply_rows", self.h_restore_apply_rows, False)
        r("wal_forensics", self.h_forensics, True)
        # pg_hba.conf
        r("hba_read", self.h_hba_read, True)
        r("hba_plan", self.h_hba_plan, True)
        r("hba_apply", self.h_hba_apply, True)           # compare-before-write: re-running is a no-op
        r("hba_rollback", self.h_hba_rollback, False)
        r("hba_restore", self.h_hba_restore, True)
        r("geo_archive_fallback", self.h_geo_archive_fallback, True)        # Patroni: a previous DCS list, compare-before-write

    # ------------------------------------------------------------------ journal
    def _path(self, op_id):
        if not re.match(r"^op-[0-9a-f]{12}$", op_id):
            raise OpError("invalid operation id")
        return os.path.join(self.dir, op_id + ".json")

    def _load(self, op_id):
        try:
            with open(self._path(op_id), "r", encoding="utf-8") as f:
                return json.load(f)
        except (IOError, OSError, ValueError):
            return None

    def prune(self, keep_days=30):
        cutoff = time.time() - keep_days * 86400
        for n in os.listdir(self.dir):
            p = os.path.join(self.dir, n)
            try:
                if n.endswith(".json") and os.path.getmtime(p) < cutoff:
                    os.unlink(p)
            except OSError:
                pass

    # ------------------------------------------------------------------ execute
    def execute(self, op):
        """op = {id,type,params}. Returns (status, result, error) where status in succeeded|failed."""
        op_id, op_type, params = op.get("id", ""), op.get("type", ""), op.get("params") or {}
        try:
            prior = self._load(op_id)
        except OpError as e:
            return "failed", None, str(e)
        if prior and prior.get("status") in ("succeeded", "failed"):
            logger.info("op %s already finished locally (%s): re-reporting stored outcome", op_id, prior["status"])
            return prior["status"], prior.get("result"), prior.get("error")

        handler = self.handlers.get(op_type)
        if not handler:
            return self._finish(op_id, op_type, "failed", None, "operation '%s' is not supported by this agent version" % op_type)
        fn, retry_safe = handler
        if prior and prior.get("status") == "running" and not retry_safe:
            return self._finish(op_id, op_type, "failed", None,
                                "interrupted: the agent restarted while '%s' was running; the outcome is unknown and the "
                                "operation was NOT repeated automatically. Check the cluster state, then resubmit if needed." % op_type)

        atomic_write_json(self._path(op_id), {"id": op_id, "type": op_type, "status": "running", "started": time.time(), "attempt": (prior or {}).get("attempt", 0) + 1})
        self._tl.op_id = op_id
        self._tl.eph = params.get("ephemeral") if isinstance(params.get("ephemeral"), dict) else None
        # an operational machine (backup server / recovery host) serves many clusters: the console says whose backup catalogue (stanza) an operation is about
        st_ = params.get("stanza")
        self._tl.stanza = st_ if isinstance(st_, str) and re.match(r"^[A-Za-z0-9_.-]{1,60}$", st_) else None
        try:
            result = fn(params)
            return self._finish(op_id, op_type, "succeeded", result, None)
        except OpError as e:
            return self._finish(op_id, op_type, "failed", None, str(e))
        except Cancelled:
            return self._finish(op_id, op_type, "failed", None, "cancelled by operator")
        except EngineError as e:
            return self._finish(op_id, op_type, "failed", None, e.as_text())
        except (IOError, OSError) as e:
            import errno as _errno
            logger.exception("operation %s failed on the file system", op_id)
            if getattr(e, "errno", None) in (_errno.EACCES, _errno.EPERM, _errno.EROFS):
                try:
                    import getpass
                    me = getpass.getuser()
                except Exception:
                    me = str(os.getuid())
                where = getattr(e, "filename", None) or "?"
                return self._finish(op_id, op_type, "failed", None, "PGA-SYS-013: permission denied on %s: the agent runs as %s and cannot %s there. Fix: give %s access "
                                    "(chown %s: %s) or choose another path" % (where, me, "write" if e.errno != _errno.EROFS else "write (read-only file system)", me, me, where))
            if getattr(e, "errno", None) == _errno.ENOSPC:
                return self._finish(op_id, op_type, "failed", None, "PGA-SYS-014: no space left on device%s" % (" (%s)" % e.filename if getattr(e, "filename", None) else ""))
            return self._finish(op_id, op_type, "failed", None, "internal error: %s" % e)
        except Exception as e:  # unexpected: still a clean failure, with detail in the log
            logger.exception("operation %s crashed", op_id)
            return self._finish(op_id, op_type, "failed", None, "internal error: %s" % e)
        finally:
            self._live.pop(op_id, None)
            self._cancel.discard(op_id)
            self._tl.op_id = None

    # ------------------------------------------------------------------ progress / cancel (used by the console client)
    def progress_of(self, op_id):
        return self._live.get(op_id)

    def request_cancel(self, op_id):
        self._cancel.add(op_id)

    def _progress(self, data):
        op_id = getattr(self._tl, "op_id", None)
        if op_id:
            data = dict(data)
            data["at"] = time.time()
            self._live[op_id] = data

    def _cancelled(self):
        return getattr(self._tl, "op_id", None) in self._cancel

    def _finish(self, op_id, op_type, status, result, error):
        try:
            atomic_write_json(self._path(op_id), {"id": op_id, "type": op_type, "status": status, "result": result, "error": error, "finished": time.time()})
        except Exception:
            logger.exception("cannot journal result of %s", op_id)
        return status, result, error

    # ------------------------------------------------------------------ helpers
    def _require_pg(self):
        if not self.db.ping():
            raise OpError("PostgreSQL is not reachable from the agent (peer auth / socket / port?)")

    def _require_patroni(self):
        if not self.patroni.configured:
            raise OpError("Patroni is not configured on this node")
        st, d = self.patroni.get_node_status()
        if st not in (200, 503) or not isinstance(d, dict) or "state" not in d:
            raise OpError("Patroni REST API not reachable: %s" % (d.get("error") if isinstance(d, dict) else d))
        return d

    # ------------------------------------------------------------------ handlers: PostgreSQL
    def h_pg_reload(self, p):
        self._require_pg()
        ok, out, err = self.db.run_psql("SELECT pg_reload_conf();")
        if not ok or out.strip() != "t":
            raise OpError("pg_reload_conf failed: %s" % (err or out))
        return {"reloaded": True}

    def h_checkpoint(self, p):
        self._require_pg()
        ok, _, err = self.db.run_psql("CHECKPOINT;", timeout=600)
        if not ok:
            raise OpError("CHECKPOINT failed: %s" % err)
        return {"done": True}

    def h_wal_switch(self, p):
        self._require_pg()
        ok, out, err = self.db.run_psql("SELECT CASE WHEN pg_is_in_recovery() THEN NULL ELSE pg_walfile_name(pg_switch_wal()) END;")
        if not ok:
            raise OpError("pg_switch_wal failed: %s" % err)
        if not out.strip():
            raise OpError("refused: this node is a standby (in recovery); run it on the primary")
        return {"segment": out.strip()}

    def h_discovery(self, p):
        if not self.discovery:
            raise OpError("discovery not available")
        return self.discovery()

    def h_compat_check(self, p):
        """Which PostgreSQL this node runs, how well this product handles it, and whether the binaries in use belong to it."""
        rt = self.runtime
        if rt is None or not rt.instance:
            raise OpError("no PostgreSQL instance found on this host")
        from pg_arca.pgcompat import binary_profile
        inst = rt.instance
        snap = rt.db.get_snapshot()
        comp = rt.compat(snap, inst)
        bindir = self.config.get("pg_bin_dir") or inst.get("bin_dir") or ""
        tools = {}
        for t in ("postgres", "psql", "pg_ctl", "pg_controldata", "pg_waldump", "pg_basebackup", "pg_amcheck", "pg_checksums"):
            path = os.path.join(bindir, t) if bindir else None
            pr = binary_profile(path) if path and os.path.exists(path) else None
            tools[t] = {"path": path if pr else None, "version": pr.label if pr else None}
        return {"compat": comp, "bindir": bindir or None, "tools": tools, "server_version": snap.get("version"), "data_directory": inst.get("data_directory")}

    def h_list_objects(self, p):
        self._require_pg()
        try:
            dbname = str(p.get("database"))
            sch, _ = self.db.query_json("SELECT COALESCE(json_agg(nspname ORDER BY nspname), '[]'::json) FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'", dbname=dbname)
            return {"objects": self.db.get_database_objects(dbname), "schemas": sch or []}
        except Exception as e:
            raise OpError(str(e))

    def h_set_param(self, p):
        name, value = str(p.get("name", "")), p.get("value")
        if name in DENY_PARAMS or not re.match(r"^[a-z_][a-z0-9_.]{0,62}$", name):
            raise OpError("parameter '%s' cannot be changed from the console" % name)
        if self._patroni_managed():
            # Under Patroni the DCS owns parameters: ALTER SYSTEM would silently diverge / be reverted.
            if name in PATRONI_LOCAL_PARAMS:
                raise OpError("'%s' is taken from this node's own Patroni configuration (postgresql.listen / connect_address), not from the DCS: Patroni ignores the DCS value" % name)
            self._require_pg()
            _, why = self.db.validate_param(name, value)         # an unknown / out-of-range value in the DCS would reach EVERY member
            if why:
                raise OpError("refused before touching the DCS: %s" % why)
            before, _ = self.db.query_json("SELECT json_build_object('setting', setting, 'unit', unit, 'context', context) FROM pg_settings WHERE name = :'pname';", variables={"pname": name})
            st, d = self.patroni.patch_config({"postgresql": {"parameters": {name: (None if value is None else str(value))}}})
            if st >= 300:
                raise OpError("Patroni rejected the change (%s): %s" % (st, json.dumps(d)[:300]))
            st2, cfg = self.patroni.get_config()
            applied = ((cfg.get("postgresql") or {}).get("parameters") or {}).get(name) if st2 == 200 else None
            _, node = self.patroni.get_node_status()
            ok = (str(applied) == str(value)) if value is not None else (applied is None)
            if not ok:
                raise OpError("verification failed: DCS has %r after patch" % (applied,))
            res = {"via": "patroni", "applied": True, "restart_required": bool(node.get("pending_restart")) if isinstance(node, dict) else None}
            # Did PostgreSQL take it? Patroni applies the DCS on its next cycle; a value set in this node's own patroni.yml (postgresql.parameters) wins over the
            # DCS and the change would silently do nothing here. Watch pg_settings for a change (or a pending restart) for up to ~25 s; say it when nothing moves.
            if isinstance(before, dict) and before.get("context") not in ("internal",):
                deadline = time.time() + min(60.0, max(0.0, float(p.get("settle_seconds", 25) or 0)))
                now_v = None
                while time.time() < deadline:
                    now_v, _ = self.db.query_json("SELECT json_build_object('setting', setting, 'pending', pending_restart) FROM pg_settings WHERE name = :'pname';", variables={"pname": name})
                    if isinstance(now_v, dict) and (now_v.get("setting") != before.get("setting") or now_v.get("pending")):
                        res["effective"] = now_v.get("setting")
                        res["pending_restart"] = bool(now_v.get("pending"))
                        break
                    time.sleep(1.5)
                else:
                    res["effective"] = (now_v or {}).get("setting") if isinstance(now_v, dict) else None
                    res["warning"] = ("PostgreSQL on this node still reports %s = %s%s: either it already had that value, or a setting in this node's own Patroni "
                                      "configuration (patroni.yml postgresql.parameters) overrides the DCS" % (name, res["effective"], (" " + before.get("unit")) if before.get("unit") else ""))
            return res
        self._require_pg()
        try:
            r = self.db.alter_system(name, value)
        except (ValueError, RuntimeError) as e:
            raise OpError(str(e))
        r["via"] = "alter_system"
        return r

    def _wal_tool(self):
        """Absolute path of pg-arca-wal as PostgreSQL's archiver must call it (it runs with the server's PATH, not the agent's). First that exists and is executable: the configured
        wal_bin / PG_ARCA_WAL_BIN, the PATH, next to the installed package, /usr/local/bin. Raises when none exists: an archive_command that points nowhere fails on every segment."""
        import pg_arca
        home = os.path.dirname(os.path.dirname(os.path.realpath(pg_arca.__file__)))
        cands = [self.config.get("wal_bin"), os.environ.get("PG_ARCA_WAL_BIN"), shutil.which("pg-arca-wal"), os.path.join(home, "pg-arca-wal"), "/usr/local/bin/pg-arca-wal"]
        for c in cands:
            if c and os.path.isfile(c) and os.access(c, os.X_OK):
                return os.path.abspath(c)
        raise OpError("pg-arca-wal not found (looked in: %s): install the agent completely or set wal_bin; archive_command would fail on every segment" % ", ".join(c for c in cands if c))

    def _archive_env(self):
        """`env PG_ARCA_CONF=... PG_ARCA_HOME=... ` when the agent does not use the default config file / install directory, so archive_command (run by PostgreSQL, with its own
        environment) reads the same settings. Empty for the standard layout, which keeps the command short and readable."""
        import pg_arca
        parts = []
        conf = self.config.get("_conf_path")
        if conf and conf != "/etc/pg-arca/agent.conf":
            parts.append("PG_ARCA_CONF=%s" % shlex.quote(conf))
        if os.environ.get("PG_ARCA_HOME"):
            parts.append("PG_ARCA_HOME=%s" % shlex.quote(os.environ["PG_ARCA_HOME"]))
        return ("env " + " ".join(parts) + " ") if parts else ""

    def h_archive_enable(self, p):
        """One step to continuous WAL archiving for PITR: archive_mode=on, archive_command = this agent's own tool, wal_level>=replica, wal_log_hints when
        checksums are off (needed by incremental backups). The command is built HERE, never taken from the console. Under Patroni the change goes through the DCS
        (every member gets it); otherwise ALTER SYSTEM. archive_mode/wal_level need a restart: it is reported, never done silently."""
        self._require_pg()
        tool = self._wal_tool()
        want = {"archive_mode": "on", "archive_command": "%s%s archive %%p %%f" % (self._archive_env(), shlex.quote(tool)), "archive_timeout": str(int(p.get("archive_timeout") or 60))}
        cur, err = self.db.query_json("SELECT json_object_agg(name, setting) FROM pg_settings WHERE name IN ('archive_mode','archive_command','archive_timeout','wal_level','wal_log_hints','data_checksums')")
        if not isinstance(cur, dict):
            raise OpError("cannot read the current settings: %s" % err)
        if cur.get("wal_level") == "minimal":
            want["wal_level"] = "replica"
        if cur.get("data_checksums") == "off" and cur.get("wal_log_hints") != "on":
            want["wal_log_hints"] = "on"
        existing = cur.get("archive_command") or ""
        if existing.strip() in ("(disabled)", "false", ":", "/bin/true", "true"):
            existing = ""   # unset / no-op placeholder, not a foreign tool
        if existing and "pg-arca-wal" not in existing and "pg_arca" not in existing and not p.get("replace_foreign"):
            raise OpError("archive_command is already set to another tool (%s). Replacing it would break that tool's archive; confirm with replace_foreign=true if that is intended." % existing[:120])
        todo = {k: v for k, v in want.items() if str(cur.get(k)) != v}
        if not todo:
            return {"changed": {}, "restart_required": False, "already_enabled": True}
        restart = False
        if self._patroni_managed():
            st, d = self.patroni.patch_config({"postgresql": {"parameters": todo}})
            if st >= 300:
                raise OpError("Patroni rejected the change (%s): %s" % (st, json.dumps(d)[:300]))
            st2, cfg = self.patroni.get_config()
            got = ((cfg.get("postgresql") or {}).get("parameters") or {}) if st2 == 200 else {}
            bad = {k: got.get(k) for k, v in todo.items() if str(got.get(k)) != v}
            if bad:
                raise OpError("verification failed: the DCS does not hold %s" % bad)
            restart = any(k in ("archive_mode", "wal_level") for k in todo)
            via = "patroni"
        else:
            for k, v in todo.items():
                try:
                    r = self.db.alter_system(k, v)
                except (ValueError, RuntimeError) as e:
                    raise OpError("%s: %s" % (k, e))
                restart = restart or bool(r.get("restart_required"))
            via = "alter_system"
        return {"changed": todo, "via": via, "restart_required": restart,
                "next": ("Restart each member (Patroni: replicas first, then the leader) for archive_mode/wal_level to take effect." if via == "patroni" and restart else
                         "Restart PostgreSQL (systemctl restart <service>, or pg_ctl restart) for archive_mode/wal_level to take effect." if restart else "Applied with a reload; archiving is active.")}

    def h_pg_restart(self, p):
        """Restart a STANDALONE PostgreSQL (Patroni members: patroni_restart). How depends on how the server is managed: see pgrestart.py."""
        from pg_arca import pgrestart
        if self.patroni.configured:
            raise OpError("this node is managed by Patroni: restart it with Patroni (HA tab -> Restart), never behind its back")
        inst = (self.runtime.instance if self.runtime else None) or {}
        data = self.config.get("pg_data") or inst.get("data_directory")
        if not data:
            raise OpError("no PostgreSQL instance found on this host")
        plan = pgrestart.plan(data)
        # a configuration file with an error makes PostgreSQL refuse to START (a reload only logs it): never restart into that
        bad = None
        try:
            bad, _ = self.db.query_json("SELECT COALESCE(json_agg(json_build_object('file', sourcefile, 'line', sourceline, 'name', name, 'error', error)), '[]'::json) "
                                        "FROM pg_file_settings f WHERE error IS NOT NULL "
                                        "AND NOT (f.name IS NOT NULL AND EXISTS (SELECT 1 FROM pg_settings s WHERE s.name = f.name AND s.pending_restart));")
        except Exception:
            bad = None
        if bad:
            plan = dict(plan, method="refuse", config_errors=bad,
                        why="the configuration has errors PostgreSQL would refuse at start: %s" % "; ".join(
                            "%s line %s%s: %s" % (b.get("file"), b.get("line"), (" (%s)" % b["name"]) if b.get("name") else "", b.get("error")) for b in bad[:5]))
        if p.get("dry_run"):
            return {"dry_run": True, "plan": plan}
        if plan["method"] == "refuse":
            raise OpError(plan["why"])
        if plan.get("allowed") is False:
            raise OpError("%s. Nothing was restarted. Command to run on the server: %s" % (plan["why"], plan.get("manual")))
        before = None
        try:
            before, _ = self.db.query_json("SELECT COALESCE(json_agg(name), '[]'::json) FROM pg_settings WHERE pending_restart;")
        except Exception:
            pass
        bindir = self.config.get("pg_bin_dir") or inst.get("bin_dir") or ""
        import getpass
        try:
            how = pgrestart.run(plan, data, bindir, getpass.getuser(), log_dir=self.config.get("log_dir") or self.config.get("state_dir"))
        except RuntimeError as e:
            raise OpError(str(e))
        deadline = time.time() + 180
        while time.time() < deadline:
            time.sleep(2)
            if self.db.ping():
                break
        else:
            diag = ""
            try:
                if plan.get("unit"):
                    r = subprocess.run(["systemctl", "status", "--no-pager", "-n", "15", plan["unit"]], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       universal_newlines=True, timeout=20)
                    diag = r.stdout[-1500:]
                else:
                    lg = os.path.join(self.config.get("log_dir") or self.config.get("state_dir") or "/tmp", "postgresql-restarted-by-pg_arca.log")
                    with open(lg, "rb") as f:
                        f.seek(max(0, os.path.getsize(lg) - 1500))
                        diag = f.read().decode("utf-8", "replace")
            except Exception:
                pass
            raise OpError("restarted (%s) but PostgreSQL does not answer after 180 s - it may have refused to start (a parameter it cannot use?).%s"
                          % (how, ("\nLast lines:\n" + diag.strip()) if diag.strip() else " Look at its log."))
        after, _ = self.db.query_json("SELECT COALESCE(json_agg(name), '[]'::json) FROM pg_settings WHERE pending_restart;")
        return {"restarted": True, "how": how, "unit": plan.get("unit"), "pending_before": before or [], "pending_restart": after or []}

    def _patroni_managed(self):
        """True when this node is managed by Patroni. Then parameters live in the DCS (same call as `patronictl edit-config`) and ONLY there: ALTER SYSTEM,
        postgresql.conf, postgresql.auto.conf and patroni.yml are never touched. If the Patroni API cannot be reached we refuse instead of falling back."""
        if not self.patroni.configured:
            return False
        if not self._patroni_accessible():
            raise OpError("this node is managed by Patroni but its REST API is not reachable: parameters are only changed through the DCS (patronictl edit-config), "
                          "never through postgresql.conf / ALTER SYSTEM / patroni.yml. Restore the Patroni API access and retry")
        return True

    def _patroni_accessible(self):
        st, d = self.patroni.get_node_status()
        return st in (200, 503) and isinstance(d, dict) and "state" in d

    # ------------------------------------------------------------------ handlers: Patroni
    def h_switchover(self, p):
        self._require_patroni()
        old, members = self.patroni.leader()
        if not old:
            raise OpError("cluster has no leader right now; refusing switchover (use failover only if you understand the data-loss risk)")
        if old != p.get("leader"):
            raise OpError("stale request: current leader is '%s', not '%s'. Reload the cluster view." % (old, p.get("leader")))
        cand = p.get("candidate")
        if cand:
            m = next((x for x in members if x.get("name") == cand), None)
            if not m:
                raise OpError("candidate '%s' is not a member of this cluster" % cand)
            if m.get("state") not in ("running", "streaming"):
                raise OpError("candidate '%s' is not healthy (state=%s)" % (cand, m.get("state")))
        else:
            if not [x for x in members if x.get("name") != old and x.get("state") in ("running", "streaming")]:
                raise OpError("no healthy replica available to take over")
        st, d = self.patroni.switchover(old, cand, p.get("scheduled_at"))
        if st >= 300 and not (st == 504 and isinstance(d, dict) and d.get("timeout")):      # a timeout is verified below, not reported as a refusal
            raise OpError("Patroni refused the switchover (%s): %s" % (st, json.dumps(d)[:300]))
        if p.get("scheduled_at"):
            return {"scheduled": True, "response": d}
        ok, lead, _ = self.patroni.wait_for(lambda l, ms: l is not None and l != old and (not cand or l == cand), timeout=90)
        if not ok:
            raise OpError("switchover requested but NOT confirmed within 90s (leader is '%s'). Check Patroni logs." % lead)
        return {"old_leader": old, "new_leader": lead, "confirmed": True}

    def h_failover(self, p):
        self._require_patroni()
        cand = p.get("candidate")
        old, members = self.patroni.leader()
        if not any(x.get("name") == cand for x in members):
            raise OpError("candidate '%s' is not a member of this cluster" % cand)
        st, d = self.patroni.failover(cand)
        if st >= 300 and not (st == 504 and isinstance(d, dict) and d.get("timeout")):      # a timeout is verified below, not reported as a refusal
            raise OpError("Patroni refused the failover (%s): %s" % (st, json.dumps(d)[:300]))
        ok, lead, _ = self.patroni.wait_for(lambda l, ms: l == cand, timeout=90)
        if not ok:
            raise OpError("failover requested but NOT confirmed within 90s (leader is '%s')" % lead)
        return {"old_leader": old, "new_leader": lead, "confirmed": True}

    def _bridge_for(self, member):
        """(bridge, member_record) for the named member. The local Patroni when it is this node, else the member's own REST API from the DCS list:
        so a member can be handled from any node with an agent, and also when the member itself has no agent."""
        st, cl = self.patroni.get_cluster_topology()
        members = cl.get("members", []) if st == 200 and isinstance(cl, dict) else []
        if not member:
            return self.patroni, None
        m = next((x for x in members if x.get("name") == member), None)
        if not m:
            raise OpError("member '%s' is not part of this Patroni cluster (members: %s)" % (member, ", ".join(str(x.get("name")) for x in members) or "unknown"))
        local = ((self.runtime.patroni_info or {}).get("node_name") if self.runtime else None)
        if member == local or not m.get("api_url"):
            return self.patroni, m
        return self.patroni.for_member(m["api_url"]), m

    def h_restart(self, p):
        self._require_patroni()
        bridge, m = self._bridge_for(p.get("member"))
        st, resp = bridge.restart(p.get("role"))
        if st >= 300 and not (st == 504 and isinstance(resp, dict) and resp.get("timeout")):
            raise OpError("Patroni refused the restart of %s (%s): %s" % (p.get("member") or "this node", st, json.dumps(resp)[:300]))
        deadline = time.time() + 120
        while time.time() < deadline:
            time.sleep(2)
            s2, n = bridge.get_node_status()
            if s2 in (200, 503) and isinstance(n, dict) and n.get("state") == "running" and not n.get("pending_restart"):
                return {"restarted": True, "member": p.get("member"), "state": n.get("state")}
        raise OpError("restart requested but the node did not return to 'running' within 120s")

    def h_reinit(self, p):
        """Rebuild a replica from the leader (Patroni 'reinitialize'). Destroys the replica's data directory: never on the leader."""
        self._require_patroni()
        member = p.get("member")
        if not member:
            raise OpError("member required")
        lead, members = self.patroni.leader()
        if member == lead:
            raise OpError("'%s' is the leader: reinitialize would destroy the primary's data. Refused." % member)
        bridge, m = self._bridge_for(member)
        st, resp = bridge.reinitialize(bool(p.get("force")))
        if st >= 300 and not (st == 504 and isinstance(resp, dict) and resp.get("timeout")):
            raise OpError("Patroni refused to reinitialize %s (%s): %s" % (member, st, json.dumps(resp)[:300]))
        time.sleep(3)
        s2, n = bridge.get_node_status()
        return {"requested": True, "member": member, "state": (n or {}).get("state") if isinstance(n, dict) else None,
                "note": "Patroni is re-cloning the replica from the leader; follow the state in the cluster view"}

    def h_patroni_reload(self, p):
        self._require_patroni()
        st, d = self.patroni.reload()
        if st >= 300:
            raise OpError("Patroni reload failed (%s): %s" % (st, json.dumps(d)[:300]))
        return {"reloaded": True}

    def h_pause(self, p):
        self._require_patroni()
        want = bool(p.get("enable"))
        st, d = self.patroni.patch_config({"pause": want})
        if st >= 300:
            raise OpError("Patroni rejected pause=%s (%s): %s" % (want, st, json.dumps(d)[:300]))
        st2, cl = self.patroni.get_cluster_topology()
        if st2 == 200 and bool(cl.get("pause", False)) != want:
            raise OpError("verification failed: cluster pause flag is %r" % cl.get("pause"))
        return {"paused": want}

    def h_config_patch(self, p):
        self._require_patroni()
        patch = p.get("patch")
        # never let the console touch settings that can lock operators out of the DB
        forbidden = {"postgresql": {"authentication", "pg_hba", "listen", "connect_address", "data_dir", "bin_dir"}, "restapi": None, "etcd": None, "etcd3": None}
        for k, v in list(patch.items()):
            if k in forbidden and forbidden[k] is None:
                raise OpError("section '%s' cannot be patched from the console" % k)
            if k == "postgresql" and isinstance(v, dict) and (set(v) & forbidden["postgresql"]):
                raise OpError("postgresql.%s cannot be patched from the console" % sorted(set(v) & forbidden["postgresql"])[0])
        st, d = self.patroni.patch_config(patch)
        if st >= 300:
            raise OpError("Patroni rejected the patch (%s): %s" % (st, json.dumps(d)[:300]))
        return {"applied": True, "config": d}


    # ------------------------------------------------------------------ handlers: geo-redundancy (Patroni standby clusters), always through the DCS
    def _wait_role(self, want, timeout):
        ok, lead, members = self.patroni.wait_for(lambda l, m: any(x.get("role") in want and x.get("state") in ("running", "streaming") for x in m), timeout=timeout, interval=2)
        leader = next((x for x in members if x.get("role") in want), None)
        return ok, leader, members

    def h_geo_promote(self, p):
        """This site (a Patroni standby cluster) becomes a normal, writable cluster: standby_cluster is removed from ITS dynamic configuration (PATCH /config, the same
        as `patronictl edit-config`); Patroni promotes the standby leader. Permanent slots for the other site can be declared at the same time, so that it can
        follow this site afterwards. The other site is NOT touched here: the console decides the order (DR: the other site is lost; planned: it was demoted first)."""
        self._require_patroni()
        st, cfg = self.patroni.get_config()
        if st != 200 or not isinstance(cfg, dict):
            raise OpError("cannot read the Patroni configuration (%s)" % st)
        if not cfg.get("standby_cluster"):
            return {"promoted": False, "note": "this cluster is not a standby cluster: nothing to do", "already_primary": True}
        patch = {"standby_cluster": None}
        slot = p.get("slot_for_peer")
        if slot:
            if not re.match(r"^[a-z0-9_]{1,63}$", str(slot)):
                raise OpError("invalid slot name")
            patch["slots"] = dict((cfg.get("slots") or {}), **{str(slot): {"type": "physical"}})
        self._progress({"phase": "geo-promote", "msg": "standby_cluster removed from the DCS: waiting for Patroni to promote the standby leader"})
        st, d = self.patroni.patch_config(patch)
        if st >= 300:
            raise OpError("Patroni rejected the change (%s): %s" % (st, json.dumps(d)[:300]))
        ok, leader, members = self._wait_role(("leader", "master", "primary"), int(p.get("timeout", 120)))
        if not ok:
            raise OpError("Patroni did not promote within %ss (members: %s)" % (p.get("timeout", 120), [(m.get("name"), m.get("role"), m.get("state")) for m in members]))
        return {"promoted": True, "leader": leader.get("name"), "timeline": leader.get("timeline"), "slot_for_peer": slot or None}

    def h_geo_archive_fallback(self, p):
        """Standby site: let it catch up from the shared WAL archive when streaming from the primary site is not possible (slot lost, long WAN outage):
        standby_cluster.restore_command in ITS DCS, built here (never a command coming from the console). enable=false removes it."""
        self._require_patroni()
        st, cfg = self.patroni.get_config()
        if st != 200 or not isinstance(cfg, dict):
            raise OpError("cannot read the Patroni configuration (%s)" % st)
        sc = cfg.get("standby_cluster")
        if not isinstance(sc, dict) or not sc:
            raise OpError("this cluster is not a standby site (no standby_cluster in its DCS)")
        if p.get("enable"):
            exe = shutil.which("pg-arca-wal") or "/usr/local/bin/pg-arca-wal"
            if not os.path.exists(exe):
                raise OpError("pg-arca-wal is not installed on this node: install the agent with the WAL helper first")
            cmd = "%s get %%f %%p" % exe
            if sc.get("restore_command") and sc.get("restore_command") != cmd and not p.get("replace_foreign"):
                raise OpError("standby_cluster already has a different restore_command (%s): not replaced" % sc.get("restore_command")[:120])
            new = dict(sc, restore_command=cmd)
        else:
            new = dict((k, v) for k, v in sc.items() if k != "restore_command")
            new["restore_command"] = None
        st, d = self.patroni.patch_config({"standby_cluster": new})
        if st >= 300:
            raise OpError("Patroni rejected the change (%s): %s" % (st, json.dumps(d)[:300]))
        st2, cfg2 = self.patroni.get_config()
        got = (cfg2.get("standby_cluster") or {}).get("restore_command") if st2 == 200 and isinstance(cfg2, dict) else "?"
        if bool(got) != bool(p.get("enable")):
            raise OpError("verification failed: standby_cluster.restore_command is %r in the DCS" % got)
        return {"restore_command": got, "note": "Patroni applies it to the standby leader (restart of the standby leader may be needed on older Patroni)"}

    def h_geo_demote(self, p):
        """This site becomes a standby cluster of another site: standby_cluster {host, port, primary_slot_name} is written to ITS DCS. Patroni turns the leader into a
        standby leader that replicates from that endpoint (writes stop here at once). Used by the planned site switchover before the other site is promoted."""
        self._require_patroni()
        host, port = str(p.get("host") or ""), int(p.get("port") or 5432)
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$", host):
            raise OpError("invalid host of the other site")
        sc = {"host": host, "port": port, "create_replica_methods": ["basebackup"]}
        if p.get("primary_slot_name"):
            if not re.match(r"^[a-z0-9_]{1,63}$", str(p["primary_slot_name"])):
                raise OpError("invalid slot name")
            sc["primary_slot_name"] = str(p["primary_slot_name"])
        patch = {"standby_cluster": sc}
        drop = [str(x) for x in (p.get("drop_slots") or [])]
        if any(not re.match(r"^[a-z0-9_]{1,63}$", x) for x in drop):
            raise OpError("invalid slot name in drop_slots")
        if drop:                    # permanent slots kept for the site that is becoming primary: a standby site must not retain WAL for it (JSON merge patch: null removes)
            patch["slots"] = dict((x, None) for x in drop)
        self._progress({"phase": "geo-demote", "msg": "standby_cluster written to the DCS: Patroni turns the leader into a standby leader"})
        st, d = self.patroni.patch_config(patch)
        if st >= 300:
            raise OpError("Patroni rejected the change (%s): %s" % (st, json.dumps(d)[:300]))
        ok, leader, members = self._wait_role(("standby_leader",), int(p.get("timeout", 120)))
        if not ok:
            raise OpError("no standby leader within %ss (members: %s)" % (p.get("timeout", 120), [(m.get("name"), m.get("role"), m.get("state")) for m in members]))
        return {"demoted": True, "standby_leader": leader.get("name"), "upstream": "%s:%d" % (host, port), "dropped_slots": drop}

    # ------------------------------------------------------------------ handlers: backup / restore (engine)
    def _ctx(self):
        from pg_arca.engine.ctx import Ctx
        if not self.runtime:
            raise OpError("backup/restore are not available: executor has no runtime binding")
        self.runtime.refresh() if not self.runtime.instance else None
        if not self.runtime.instance:
            raise OpError("no PostgreSQL instance found on this host")
        if not self.runtime.instance.get("running"):
            raise OpError("PostgreSQL is not running on this host (backups need a running instance; restores can still target a directory)")
        return self._with_eph(Ctx.from_config(self._cfg(), self.runtime, log=lambda lv, m: logger.log({"warn": logging.WARNING, "error": logging.ERROR}.get(lv, logging.INFO), "[engine] %s", m)))

    def _with_eph(self, ctx):
        """Ephemeral-instance settings: agent.conf `ephemeral` first, then what the console resolved for this operation (global < environment < folder < cluster)."""
        merged = dict(self.config.get("ephemeral") or {})
        merged.update(getattr(self._tl, "eph", None) or {})
        ctx.forensics_cache = os.path.join(self.config.get("state_dir", "/var/lib/pgarca/state"), "forensics")     # WAL scans of a restore reuse the per-segment cache
        ctx.promote_journal_dir = os.path.join(self.config.get("state_dir", "/var/lib/pgarca/state"), "promotions")   # interrupted promotions are cleaned from here
        return ctx.set_ephemeral(merged) if merged else ctx

    def _engine_refresh_summary(self, ctx):
        try:
            from pg_arca.engine.summary import RepoSummary
            RepoSummary(ctx).refresh_cas()
        except Exception:
            logger.debug("summary refresh failed", exc_info=True)

    def h_backup_run(self, p):
        from pg_arca.engine.backup import run_backup
        ctx = self._ctx()
        meta = run_backup(ctx, str(p.get("type", "incr")), int(p.get("archive_timeout", 120)), self._progress, self._cancelled,
                          owner=getattr(self._tl, "op_id", ""), note=str(p.get("note", ""))[:200],
                          start_fast=(bool(p["start_fast"]) if "start_fast" in p else None))
        self._engine_refresh_summary(ctx)
        st = meta.get("stats") or {}
        return {"set": meta["id"], "type": meta["type"], "parent": meta.get("parent"), "start_lsn": meta["start_lsn"], "stop_lsn": meta["stop_lsn"],
                "duration_sec": meta["duration_sec"], "bytes_logical": st.get("bytes_logical"), "bytes_written": st.get("bytes_written"),
                "files": st.get("files"), "chunks_dedup": st.get("chunks_dedup"), "chunks_new": st.get("chunks_new"),
                "pages_read": st.get("pages_read"), "pages_kept": st.get("pages_kept")}

    def h_backup_info(self, p):
        from pg_arca.engine.maintenance import repo_info
        return repo_info(self._ctx_ro())

    def _ctx_ro(self):
        """Read-only inspection does not need a running PostgreSQL."""
        from pg_arca.engine.ctx import Ctx
        if not self.runtime:
            raise OpError("executor has no runtime binding")
        if not self.runtime.instance:
            self.runtime.refresh()
        return self._with_eph(Ctx.from_config(self._cfg(), self.runtime))

    def _cfg(self):
        """The agent configuration for this operation: on an operational machine the stanza comes from the operation (the cluster it works for);
        on a database node it is always the node's own (a parameter can never point a backup of this database into another catalogue)."""
        stz = getattr(self._tl, "stanza", None)
        if stz and self.runtime is not None and getattr(self.runtime, "worker", False):
            return dict(self.config, stanza=stz)
        return self.config

    def h_backup_verify(self, p):
        from pg_arca.engine.maintenance import verify
        from pg_arca.engine.granular import restore_test
        ctx = self._ctx_ro()
        out = verify(ctx, bool(p.get("deep")), self._progress, self._cancelled)
        if p.get("restore_test"):
            self._progress({"phase": "restore-test"})
            out["restore_test"] = restore_test(ctx, p.get("set"), self._progress, self._cancelled)
        return out

    def h_backup_expire(self, p):
        from pg_arca.engine.maintenance import expire
        ctx = self._ctx_ro()
        out = expire(ctx, bool(p.get("dry_run")), p.get("retention_full"), p.get("retention_days"))
        if not p.get("dry_run"):
            self._engine_refresh_summary(ctx)
        return out

    @staticmethod
    def _targets(p):
        return dict(target_time=p.get("target_time") or None, target_lsn=p.get("target_lsn") or None, target_xid=p.get("target_xid") or None,
                    target_name=p.get("target_name") or None, inclusive=bool(p.get("inclusive", True)))

    def h_restore_plan(self, p):
        ctx = self._ctx_ro()
        t = self._targets(p)
        scope = p.get("scope")
        if scope == "instance":
            from pg_arca.engine.restore import restore_instance
            dest, where = self._instance_dest(ctx, p, t)
            plan = restore_instance(ctx, p.get("set"), dest, dry_run=True, **{k: v for k, v in t.items()})
            plan["destinations"] = where
            plan["destination_auto"] = not p.get("destination")
            return plan
        from pg_arca.engine import granular
        into = p.get("into") if isinstance(p.get("into"), dict) else None      # central recovery host: the plan is checked where the instance will really run
        if scope == "database":
            return granular.restore_database(ctx, str(p.get("database")), p.get("set"), dry_run=True, new_name=p.get("new_name"), into=into,
                                             create_missing_roles=bool(p.get("create_missing_roles")), **t)
        objs = [str(x) for x in p.get("objects")] if isinstance(p.get("objects"), list) and p.get("objects") else None
        return granular.restore_object(ctx, str(p.get("object") or ""), p.get("set"), dry_run=True, stage_db=p.get("stage_db"), objects=objs, into=into, **t)

    def _state_dir(self):
        return self.config.get("state_dir", "/var/lib/pgarca/state")

    def _instance_dest(self, ctx, p, t):
        """The destination of a whole-instance restore: the operator's, or the best volume this host offers (with every candidate, for the console)."""
        from pg_arca.engine import restored
        try:
            need = restored.instance_bytes(ctx, p.get("set"), t)
        except Exception:
            need = 0
        where = restored.suggest(ctx, need, roots=self.config.get("restore_roots") or ())
        dest = p.get("destination") or where.get("recommended")
        if not dest:
            from pg_arca.engine.util import EngineError
            raise EngineError("PGA-RST-031", "no volume on this host has room for the restored copy (about %s needed)" % restored.human(where.get("need") or need),
                              "free space, mount a volume the agent user can write to (e.g. /restore), or restore just a database or a table")
        return dest, where

    def h_restore_instance(self, p):
        from pg_arca.engine.restore import restore_instance
        from pg_arca.engine import restored
        ctx = self._ctx_ro()
        t = self._targets(p)
        dest, where = (p.get("destination"), None) if p.get("destination") else self._instance_dest(ctx, p, t)
        start = p.get("start", True) is not False and not p.get("keep_archiving")       # a copy that REPLACES the original is started by the operator, in its final place
        plan = restore_instance(ctx, p.get("set"), dest, action=p.get("action", "promote"), delta=bool(p.get("delta")), keep_archiving=bool(p.get("keep_archiving")),
                                tablespace_remap=p.get("tablespace_remap"), progress=self._progress, cancel=self._cancelled, resume=bool(p.get("resume")), **t)
        if where:
            plan["destination_auto"] = True
        if not start or plan.get("dry_run"):
            return plan
        plan.pop("start_hint", None)
        self._progress({"phase": "starting", "msg": "starting the restored copy"})
        ttl = p.get("ttl_hours")
        plan["instance"] = restored.register_and_start(ctx, self._state_dir(), plan["destination"], plan, action=p.get("action", "promote"),
                                                       ttl_hours=restored.DEFAULT_TTL_H if ttl is None else float(ttl), op_id=getattr(self._tl, "op_id", ""),
                                                       progress=self._progress, cancel=self._cancelled)
        return plan

    def h_restored_list(self, p):
        from pg_arca.engine import restored
        return {"instances": restored.list_all(self._state_dir())}

    def h_restored_stop(self, p):
        from pg_arca.engine import restored
        return restored.op_stop(self._state_dir(), str(p.get("id")))

    def h_restored_start(self, p):
        from pg_arca.engine import restored
        return restored.op_start(self._state_dir(), str(p.get("id")), progress=self._progress, cancel=self._cancelled)

    def h_restored_resume(self, p):
        from pg_arca.engine import restored
        return restored.op_resume(self._state_dir(), str(p.get("id")), progress=self._progress)

    def h_restored_keep(self, p):
        from pg_arca.engine import restored
        return restored.op_keep(self._state_dir(), str(p.get("id")), p.get("hours"))

    def h_restored_drop(self, p):
        from pg_arca.engine import restored
        try:
            ctx = self._ctx_ro()
        except Exception:
            ctx = None
        return restored.op_drop(ctx, self._state_dir(), str(p.get("id")), confirm=p.get("confirm"))

    def h_restore_database(self, p):
        from pg_arca.engine import granular
        ctx = self._ctx() if not p.get("into") else self._ctx_ro()
        return granular.restore_database(ctx, str(p.get("database")), p.get("set"), into=p.get("into"), new_name=p.get("new_name"),
                                         jobs=int(p.get("jobs", 2)), progress=self._progress, cancel=self._cancelled,
                                         create_missing_roles=bool(p.get("create_missing_roles")), **self._targets(p))

    def h_restore_object(self, p):
        from pg_arca.engine import granular
        ctx = self._ctx() if not p.get("into") else self._ctx_ro()
        objs = [str(x) for x in p.get("objects")] if isinstance(p.get("objects"), list) and p.get("objects") else None
        return granular.restore_object(ctx, str(p.get("object") or ""), p.get("set"), into=p.get("into"), stage_db=p.get("stage_db"), objects=objs,
                                       data_only=bool(p.get("data_only")), dry_run=bool(p.get("dry_run")), progress=self._progress, cancel=self._cancelled, **self._targets(p))

    def h_restore_promote(self, p):
        from pg_arca.engine import granular
        ctx = self._ctx() if not p.get("into") else self._ctx_ro()
        return granular.promote_object(ctx, str(p.get("stage_db")), str(p.get("object") or ""), mode=p.get("mode", "as_new"), drop_stage=bool(p.get("drop_stage", True)), into=p.get("into"),
                                       dry_run=bool(p.get("dry_run")), progress=self._progress, target_schema=p.get("target_schema") or None,
                                       allow_orphans=bool(p.get("allow_orphans")))

    def h_destination_check(self, p):
        """Is the configured backup destination safe to use from THIS node? Mount type, exclusive create + fsync + atomic rename, free space, what already lives there.
        Creates a directory only when the mount looks right, writes and removes one small probe file; with bench=true also measures sequential write/read speed."""
        from pg_arca.engine import destcheck
        from pg_arca.engine.ctx import _stanza_name
        inst = (self.runtime.instance if self.runtime else None) or {}
        prot = [self.config.get("pg_data"), inst.get("data_directory"), self.config.get("state_dir"), os.path.dirname(self.config.get("credentials_file") or "") or None]
        q = dict(p)
        q.setdefault("stanza", self.config.get("stanza") or _stanza_name(inst) or "main")
        sysid = None
        pg_up = False
        try:
            pg_up = bool(self.db and self.db.ping())
            if pg_up:
                ok, out, _ = self.db.run_psql("SELECT system_identifier FROM pg_control_system()")
                sysid = out.strip() if ok else None
        except Exception:
            pg_up = False
        owner = {"system_identifier": sysid, "stanza": q["stanza"], "cluster": self.config.get("cluster_name")} if sysid else None
        res = destcheck.check_destination(q, protected=[x for x in prot if x], current_repo=self.config.get("repo_path"), current_wal=self.config.get("wal_archive_dir"), owner=owner)
        res["agent"] = destcheck.identity()
        # the SERVER's identity too: archive_command runs as the PostgreSQL OS user, which is not always the agent's. Proven through PostgreSQL itself.
        if pg_up and not p.get("skip_server_probe"):
            try:
                tool = self._wal_tool()
            except OpError:
                tool = None
            for x in res["paths"]:
                if not tool or not x.get("ok"):
                    continue
                sp = destcheck.server_probe(lambda sql: self.db.run_psql(sql, timeout=60), tool, os.path.realpath(x["path"]), self._archive_env())
                x["checks"] += sp["checks"]
                if sp.get("server"):
                    x.setdefault("identity", {})["server"] = sp["server"]
                    res["server"] = sp["server"]
                    x["fix_commands"] = destcheck.fix_commands(os.path.realpath(x["path"]), res["agent"], sp["server"],
                                                               network=("nfs" if (x.get("mount") or {}).get("fstype") in ("nfs", "nfs4") else "smb" if (x.get("mount") or {}).get("fstype") in ("cifs", "smb3", "smbfs") else None))
                x["ok"] = not any(c["level"] == "bad" for c in x["checks"])
            res["ok"] = all(x["ok"] for x in res["paths"])
        elif not pg_up:
            res["server_probe"] = "not run: no running PostgreSQL on this node (the agent's own identity was tested)"
        return res

    def h_destination_migrate(self, p):
        """Copy what is still only in the previous backup location (this cluster's sets + WAL) into the current one, verified and resumable.
        dry_run: the plan only (sizes, free space, estimated time). When everything is copied the previous location is dropped from the read list
        (restores no longer need it); it is never deleted here."""
        from pg_arca.engine import migrate
        from pg_arca import overrides
        ctx = self._ctx_ro()
        src_repo, src_wal = p.get("source_repo"), p.get("source_wal")
        if src_repo and src_repo not in (ctx.repo.previous or []):
            raise OpError("%s is not a previous backup location of this cluster" % src_repo)
        if src_wal and src_wal not in (ctx.wal.previous or []):
            raise OpError("%s is not a previous WAL archive location of this cluster" % src_wal)
        if p.get("dry_run"):
            return migrate.plan(ctx, src_repo, src_wal)
        res = migrate.run(ctx, src_repo, src_wal, throttle_mb_s=float(p.get("throttle_mb_s") or 0), progress=self._progress, cancel=self._cancelled)
        if res["complete"]:
            ch = {}
            for key, val in (("repo_previous", res["source"]["repo"]), ("wal_previous", res["source"]["wal"])):
                if val:
                    left = [x for x in (self.config.get(key) or []) if x != val]
                    ch[key] = left or None
            if ch:
                overrides.save(self.config, ch)
                for k, v in ch.items():
                    if v is None:
                        self.config.pop(k, None)
                    else:
                        self.config[k] = v
                res["previous_removed_from_reads"] = True
        return res

    def h_destination_drop_old(self, p):
        """Delete this cluster's content from a previous backup location. Only with confirm == 'ELIMINA'; refused while something exists only there unless
        abandon (that PITR history is lost on purpose). The location leaves the read list."""
        from pg_arca.engine import migrate
        from pg_arca import overrides
        if p.get("confirm") != "ELIMINA":
            raise OpError("type ELIMINA to confirm: this deletes backups and WAL of this cluster from the previous location")
        ctx = self._ctx_ro()
        src_repo, src_wal = p.get("source_repo"), p.get("source_wal")
        if not src_repo and not src_wal:
            raise OpError("say which previous location (source_repo / source_wal)")
        if src_repo and src_repo not in (ctx.repo.previous or []):
            raise OpError("%s is not a previous backup location of this cluster" % src_repo)
        if src_wal and src_wal not in (ctx.wal.previous or []):
            raise OpError("%s is not a previous WAL archive location of this cluster" % src_wal)
        if not ctx.repo.own_complete_sets():
            raise OpError("the current location has no complete backup yet: keep the previous one until a full backup exists here")
        res = migrate.drop_previous(ctx, src_repo, src_wal, abandon=bool(p.get("abandon")))
        ch = {}
        for key, val in (("repo_previous", src_repo), ("wal_previous", src_wal)):
            if val:
                left = [x for x in (self.config.get(key) or []) if x != val]
                ch[key] = left or None
        overrides.save(self.config, ch)
        for k, v in ch.items():
            if v is None:
                self.config.pop(k, None)
            else:
                self.config[k] = v
        return res

    def h_ephemeral_preflight(self, p):
        """Can this host run the ephemeral recovery instance for the cluster's backups? Read-only: reports binaries, scratch, memory, ports, repository access and, when
        binaries for the needed PostgreSQL major are missing, the installation plan with the permissions it needs."""
        from pg_arca.engine import ephcfg
        ctx = self._ctx_ro()
        major = int(p["major"]) if p.get("major") else None
        return ephcfg.preflight(ctx, major, ctx.eph, need_bytes=int(p["need_bytes"]) if p.get("need_bytes") else None)

    def h_ephemeral_install(self, p):
        """Install PostgreSQL server binaries for ephemeral recovery. Only with confirm == 'INSTALL'; mode private (no root, unpacked under pg_arca's directory) or system (packages)."""
        from pg_arca.engine import ephcfg
        if p.get("confirm") != "INSTALL":
            raise OpError("type INSTALL to confirm: this downloads and installs PostgreSQL server binaries on %s" % os.uname().nodename)
        ctx = self._ctx_ro()
        major = int(p["major"])
        return ephcfg.install(major, p.get("mode") or "private", ctx.eph, progress=self._progress)

    def h_restore_drill(self, p):
        from pg_arca.engine import granular
        return granular.restore_drill(self._ctx_ro(), p.get("set"), self._progress, self._cancelled)

    def h_restore_diff(self, p):
        from pg_arca.engine import granular
        ctx = self._ctx_ro()
        return granular.diff_object(ctx, str(p.get("stage_db")), str(p.get("object")), into=p.get("into"), limit=min(int(p.get("limit", 200)), 1000))

    def h_restore_apply_rows(self, p):
        from pg_arca.engine import granular
        ctx = self._ctx() if not p.get("into") else self._ctx_ro()
        return granular.apply_rows(ctx, str(p.get("stage_db")), str(p.get("object")), restore_keys=p.get("restore_keys") or [], delete_keys=p.get("delete_keys") or [],
                                   into=p.get("into"), dry_run=bool(p.get("dry_run")), restore_all=[x for x in (p.get("restore_all") or []) if x in ("missing", "changed")],
                                   delete_all_added=bool(p.get("delete_all_added")))

    def h_forensics(self, p):
        from pg_arca.engine import walscan
        mode = p.get("mode") if p.get("mode") in ("databases", "dml") else "events"
        hours = p.get("hours")
        try:
            hours = float(hours) if hours is not None else (0 if mode == "databases" else 24)
        except (TypeError, ValueError):
            raise OpError("hours must be a number (0 = the whole archive)")
        return walscan.scan(self._ctx_ro(), mode=mode, hours=max(0, hours), since_backup=bool(p.get("since_backup", mode == "databases")), since_iso=p.get("since_iso"),
                            limit=max(1, min(int(p.get("limit", 20)), 200)), since=p.get("since"), until=p.get("until"),
                            cache_dir=os.path.join(self.config.get("state_dir", "/var/lib/pgarca/state"), "forensics"),
                            progress=self._progress, cancel=self._cancelled, budget_sec=max(30, min(int(p.get("budget_sec", 900)), 7200)), detail=bool(p.get("detail")),
                            min_rows=max(1, min(int(p.get("min_rows", 1000)), 100000000)))

    def h_hba_read(self, p):
        from pg_arca import hba_ops
        return hba_ops.read(self, p, OpError)

    def h_hba_plan(self, p):
        from pg_arca import hba_ops
        return hba_ops.plan(self, p, OpError)

    def h_hba_apply(self, p):
        from pg_arca import hba_ops
        return hba_ops.apply(self, p, OpError)

    def h_cfg_get(self, p):
        from pg_arca import overrides
        return {"settings": overrides.describe(self.config, self.runtime), "file": overrides.local_path(self.config)}

    def h_cfg_set(self, p):
        """Save validated overrides, apply them to the running agent and re-run discovery. Nothing is written when any value is invalid."""
        from pg_arca import overrides
        ch = p.get("set")
        if not isinstance(ch, dict) or not ch:
            raise OpError("nothing to change")
        ch = dict(ch)
        # a new repository / WAL archive location: the old one stays READABLE (its backups and WAL keep the PITR history restorable) until its
        # content is migrated (destination_migrate) or it is dropped on purpose. Coming back to an earlier location takes it off the list.
        for key, prev_key in (("repo_path", "repo_previous"), ("wal_archive_dir", "wal_previous")):
            if key not in ch or prev_key in ch:
                continue
            new, old = ch.get(key), self.config.get(key)
            prev = [x for x in (self.config.get(prev_key) or []) if x]
            if old and new and os.path.realpath(str(old)) != os.path.realpath(str(new)) and p.get("keep_previous", True) and os.path.isdir(str(old)):
                prev.append(str(old))
            prev = [x for i, x in enumerate(prev) if x not in prev[:i] and (not new or os.path.realpath(x) != os.path.realpath(str(new)))]
            if prev != list(self.config.get(prev_key) or []):
                ch[prev_key] = prev or None
        try:
            overrides.save(self.config, ch)
        except overrides.OverrideError as e:
            a = e.args[0] if e.args else e
            raise OpError("; ".join("%s: %s" % (overrides.LABELS.get(k, k), m) for k, m in a.items()) if isinstance(a, dict) else str(a))
        from pg_arca.config import load_config                # re-resolve defaults < agent.conf < overrides < env for the changed keys
        try:
            fresh = load_config(os.environ.get("PG_ARCA_CONF_FILE") or None)
        except SystemExit:
            fresh = {}
        old_wal = self.config.get("wal_archive_dir")
        old_prev = list(self.config.get("wal_previous") or [])
        for k in ch:
            if k in fresh:
                self.config[k] = fresh[k]
            elif ch[k] is None:
                self.config.pop(k, None)
        out = {"applied": sorted(ch)}
        if p.get("verify_wal") and "wal_archive_dir" in ch and ch["wal_archive_dir"] and old_wal != self.config.get("wal_archive_dir"):
            # the archive moves NOW (archive_command reads this configuration): prove that the next segment lands in the new directory; if it does not,
            # go back to the old one at once - a WAL archive that silently stopped working is the worst outcome of a destination change
            chk = self._verify_new_wal_dir(self.config["wal_archive_dir"])
            out["wal_check"] = chk
            if chk and not chk.get("archived"):
                overrides.save(self.config, {"wal_archive_dir": old_wal, "wal_previous": old_prev or None})
                self.config["wal_archive_dir"] = old_wal
                if old_prev:
                    self.config["wal_previous"] = old_prev
                else:
                    self.config.pop("wal_previous", None)
                raise OpError("the WAL archive did not work in %s (segment %s not archived within %ss%s): the agent went back to %s, nothing was lost. "
                              "Check the destination from the console (permissions of the PostgreSQL server user) and try again"
                              % (ch["wal_archive_dir"], chk.get("segment"), chk.get("seconds"), ("; last error: " + chk["error"]) if chk.get("error") else "", old_wal))
        if self.runtime:
            self.runtime.refresh()
        out["settings"] = overrides.describe(self.config, self.runtime)
        return out

    def _verify_new_wal_dir(self, wal_dir, wait=60):
        """On a running primary that archives with pg-arca-wal: switch the WAL segment and wait for it in `wal_dir`. None when not applicable here."""
        try:
            if not (self.db and self.db.ping()):
                return None
            ok, out, _ = self.db.run_psql("SELECT CASE WHEN pg_is_in_recovery() THEN '' ELSE current_setting('archive_mode') || '|' || current_setting('archive_command') END")
            if not ok or not out.strip() or "pg-arca-wal" not in out or out.split("|", 1)[0] == "off":
                return None
            ok, out, err = self.db.run_psql("SELECT pg_walfile_name(pg_switch_wal())")
            if not ok:
                return {"archived": False, "error": err.strip()[:200], "seconds": 0}
            name = out.strip()
        except Exception as e:
            return {"archived": False, "error": str(e)[:200], "seconds": 0}
        from pg_arca.wal_manager import WalManager
        wm = WalManager(wal_dir)
        t0 = time.time()
        while time.time() - t0 < wait:
            if wm.has_segment(name, anywhere=False):
                return {"segment": name, "archived": True, "seconds": round(time.time() - t0, 1)}
            time.sleep(1)
        ae = None
        try:
            from pg_arca.runtime import _archive_error
            ae = (_archive_error(wal_dir) or {}).get("error")
        except Exception:
            pass
        return {"segment": name, "archived": False, "seconds": wait, "error": ae}

    def h_hba_expire(self, p):
        from pg_arca import hba_ops
        return hba_ops.expire(self, p, OpError)

    def h_hba_restore(self, p):
        from pg_arca import hba_ops
        return hba_ops.restore_dcs(self, p, OpError)

    def h_hba_rollback(self, p):
        from pg_arca import hba_ops
        return hba_ops.rollback(self, p, OpError)

    def h_backup_catalog(self, p):
        from pg_arca.engine.maintenance import catalog_browse
        return catalog_browse(self._ctx_ro(), p.get("set"), p.get("database") or None, str(p.get("search", "")), int(p.get("limit", 2000)))
