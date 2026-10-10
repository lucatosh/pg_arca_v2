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
import shutil
import logging
import os
import re
import threading
import time

from pg_arca.config import atomic_write_json
from pg_arca.engine.util import Cancelled, EngineError

logger = logging.getLogger("pg_arca.executor")

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
        r("checkpoint", self.h_checkpoint, True)
        r("wal_switch", self.h_wal_switch, False)           # switching twice would create two segments
        r("discovery_scan", self.h_discovery, True)
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
        # backup / restore / PITR (engine)
        r("backup_run", self.h_backup_run, False)
        r("backup_info", self.h_backup_info, True)
        r("backup_verify", self.h_backup_verify, True)
        r("backup_expire", self.h_backup_expire, True)
        r("backup_catalog", self.h_backup_catalog, True)
        r("restore_plan", self.h_restore_plan, True)
        r("restore_instance", self.h_restore_instance, False)
        r("restore_database", self.h_restore_database, False)
        r("restore_object", self.h_restore_object, False)
        r("restore_promote", self.h_restore_promote, False)
        r("hba_expire", self.h_hba_expire, False)
        r("agent_config_get", self.h_cfg_get, True)
        r("agent_config_set", self.h_cfg_set, True)       # same input -> same file: idempotent
        r("restore_drill", self.h_restore_drill, False)
        r("restore_diff", self.h_restore_diff, False)
        r("restore_apply_rows", self.h_restore_apply_rows, False)
        r("wal_forensics", self.h_forensics, True)
        # pg_hba.conf
        r("hba_read", self.h_hba_read, True)
        r("hba_plan", self.h_hba_plan, True)
        r("hba_apply", self.h_hba_apply, True)           # compare-before-write: re-running is a no-op
        r("hba_rollback", self.h_hba_rollback, False)

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
        try:
            result = fn(params)
            return self._finish(op_id, op_type, "succeeded", result, None)
        except OpError as e:
            return self._finish(op_id, op_type, "failed", None, str(e))
        except Cancelled:
            return self._finish(op_id, op_type, "failed", None, "cancelled by operator")
        except EngineError as e:
            return self._finish(op_id, op_type, "failed", None, e.as_text())
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

    def h_list_objects(self, p):
        self._require_pg()
        try:
            return {"objects": self.db.get_database_objects(str(p.get("database")))}
        except Exception as e:
            raise OpError(str(e))

    def h_set_param(self, p):
        name, value = str(p.get("name", "")), p.get("value")
        if name in DENY_PARAMS or not re.match(r"^[a-z_][a-z0-9_.]{0,62}$", name):
            raise OpError("parameter '%s' cannot be changed from the console" % name)
        if self.patroni.configured and self._patroni_accessible():
            # Under Patroni the DCS owns parameters: ALTER SYSTEM would silently diverge / be reverted.
            st, d = self.patroni.patch_config({"postgresql": {"parameters": {name: (None if value is None else str(value))}}})
            if st >= 300:
                raise OpError("Patroni rejected the change (%s): %s" % (st, json.dumps(d)[:300]))
            st2, cfg = self.patroni.get_config()
            applied = ((cfg.get("postgresql") or {}).get("parameters") or {}).get(name) if st2 == 200 else None
            _, node = self.patroni.get_node_status()
            ok = (str(applied) == str(value)) if value is not None else (applied is None)
            if not ok:
                raise OpError("verification failed: DCS has %r after patch" % (applied,))
            return {"via": "patroni", "applied": True, "restart_required": bool(node.get("pending_restart")) if isinstance(node, dict) else None}
        self._require_pg()
        try:
            r = self.db.alter_system(name, value)
        except (ValueError, RuntimeError) as e:
            raise OpError(str(e))
        r["via"] = "alter_system"
        return r

    def h_archive_enable(self, p):
        """One step to continuous WAL archiving for PITR: archive_mode=on, archive_command = this agent's own tool, wal_level>=replica, wal_log_hints when
        checksums are off (needed by incremental backups). The command is built HERE, never taken from the console. Under Patroni the change goes through the DCS
        (every member gets it); otherwise ALTER SYSTEM. archive_mode/wal_level need a restart: it is reported, never done silently."""
        self._require_pg()
        tool = shutil.which("pg-arca-wal") or "/usr/local/bin/pg-arca-wal"
        want = {"archive_mode": "on", "archive_command": "%s archive %%p %%f" % tool, "archive_timeout": str(int(p.get("archive_timeout") or 60))}
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
        if self.patroni.configured and self._patroni_accessible():
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
        return Ctx.from_config(self.config, self.runtime, log=lambda lv, m: logger.log({"warn": logging.WARNING, "error": logging.ERROR}.get(lv, logging.INFO), "[engine] %s", m))

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
                          owner=getattr(self._tl, "op_id", ""), note=str(p.get("note", ""))[:200])
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
        return Ctx.from_config(self.config, self.runtime)

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
            return restore_instance(ctx, p.get("set"), p.get("destination") or "/nonexistent-plan-only", dry_run=True, **{k: v for k, v in t.items()})
        from pg_arca.engine import granular
        if scope == "database":
            return granular.restore_database(ctx, str(p.get("database")), p.get("set"), dry_run=True, new_name=p.get("new_name"), **t)
        return granular.restore_object(ctx, str(p.get("object")), p.get("set"), dry_run=True, stage_db=p.get("stage_db"), **t)

    def h_restore_instance(self, p):
        from pg_arca.engine.restore import restore_instance
        ctx = self._ctx_ro()
        return restore_instance(ctx, p.get("set"), p.get("destination"), action=p.get("action", "promote"), delta=bool(p.get("delta")),
                                tablespace_remap=p.get("tablespace_remap"), progress=self._progress, cancel=self._cancelled, **self._targets(p))

    def h_restore_database(self, p):
        from pg_arca.engine import granular
        ctx = self._ctx() if not p.get("into") else self._ctx_ro()
        return granular.restore_database(ctx, str(p.get("database")), p.get("set"), into=p.get("into"), new_name=p.get("new_name"),
                                         jobs=int(p.get("jobs", 2)), progress=self._progress, cancel=self._cancelled, **self._targets(p))

    def h_restore_object(self, p):
        from pg_arca.engine import granular
        ctx = self._ctx() if not p.get("into") else self._ctx_ro()
        return granular.restore_object(ctx, str(p.get("object")), p.get("set"), into=p.get("into"), stage_db=p.get("stage_db"),
                                       data_only=bool(p.get("data_only")), progress=self._progress, cancel=self._cancelled, **self._targets(p))

    def h_restore_promote(self, p):
        from pg_arca.engine import granular
        ctx = self._ctx() if not p.get("into") else self._ctx_ro()
        return granular.promote_object(ctx, str(p.get("stage_db")), str(p.get("object")), mode=p.get("mode", "as_new"), drop_stage=bool(p.get("drop_stage", True)), into=p.get("into"))

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
                                   into=p.get("into"), dry_run=bool(p.get("dry_run")))

    def h_forensics(self, p):
        from pg_arca.engine.maintenance import forensics
        return forensics(self._ctx_ro(), int(p.get("limit", 20)), p.get("since"), p.get("until"))

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
        for k in ch:
            if k in fresh:
                self.config[k] = fresh[k]
        if self.runtime:
            self.runtime.refresh()
        return {"settings": overrides.describe(self.config, self.runtime), "applied": sorted(ch)}

    def h_hba_expire(self, p):
        from pg_arca import hba_ops
        return hba_ops.expire(self, p, OpError)

    def h_hba_rollback(self, p):
        from pg_arca import hba_ops
        return hba_ops.rollback(self, p, OpError)

    def h_backup_catalog(self, p):
        from pg_arca.engine.maintenance import catalog_browse
        return catalog_browse(self._ctx_ro(), p.get("set"), p.get("database") or None, str(p.get("search", "")), int(p.get("limit", 2000)))
