#!/usr/bin/env python3
"""
pg_arca node agent
==================
Runs as the `postgres` OS user on each database host. Outbound-only by default: it enrolls once
with a one-time token, then pushes telemetry to the console and pulls operations to execute.
"""

import logging
import os
import signal
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pg_arca.config import load_config, validate
from pg_arca.runtime import Runtime, LogShipper, AGENT_VERSION
from pg_arca.executor import OperationExecutor
from pg_arca.engine.ctx import Ctx
from pg_arca.engine.summary import RepoSummary
from pg_arca.wal_manager import WalManager
from pg_arca.console_client import ConsoleClient
from pg_arca.api_server import ThreadingSimpleServer, make_agent_handler

logging.basicConfig(level=os.environ.get("PG_ARCA_LOG_LEVEL", "INFO"), format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger("pg_arca_agent")


def _single_instance(state_dir):
    """flock on <state_dir>/agent.lock, held for the life of the process. None when another agent holds it. A directory that cannot be used
    (read-only, missing permissions) does not stop the agent: the console still detects two processes sharing one identity."""
    import fcntl
    try:
        os.makedirs(state_dir, exist_ok=True)
        fd = os.open(os.path.join(state_dir, "agent.lock"), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as e:
        logger.warning("single-instance lock not available (%s): continuing", e)
        return True
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    os.ftruncate(fd, 0)
    os.write(fd, ("%d\n" % os.getpid()).encode())
    return fd


def main():
    config = load_config(os.environ.get("PG_ARCA_CONF_FILE"))
    problems = validate(config)
    if problems:
        for p in problems:
            logger.error("configuration: %s", p)
        return 2

    # one agent per identity: a second copy (started by hand next to the service) would receive and run the same operations
    lock = _single_instance(config.get("state_dir") or os.path.dirname(config.get("credentials_file") or "/var/lib/pgarca/state/x"))
    if lock is None:
        logger.error("another pg_arca agent is already running with this state directory: not starting a second one (stop the other one first)")
        return 3
    logger.info("pg_arca agent %s starting on %s (mode=%s)", AGENT_VERSION, config["node_name"], config["connection_mode"])
    rt = Runtime(config)
    inst = rt.instance
    if inst:
        logger.info("managing PostgreSQL %s at %s (port %s, %s)", inst.get("major_version"), inst["data_directory"], inst.get("port"), "running" if inst.get("running") else "STOPPED")
    else:
        logger.warning("no PostgreSQL instance found on this host yet; the agent will keep looking")
    if rt.patroni.configured:
        logger.info("Patroni REST: %s", rt.patroni.patroni_url)

    from pg_arca.wal_manager import LiveWal
    wal = LiveWal(config, lambda: ((rt.instance or {}).get("control") or {}).get("wal_segment_size") or 16 * 1024 * 1024)
    class _Summary(object):                 # rebuilt lazily (PostgreSQL binding may change); cached 20s so heartbeats stay cheap
        _at, _val = 0.0, None

        def get_stats(self_inner):
            import time as _t
            if self_inner._val is not None and _t.time() - self_inner._at < 20:
                return self_inner._val
            try:
                v = RepoSummary(Ctx.from_config(config, rt)).get_stats()
            except Exception as e:
                v = {"configured": False, "error": str(e)[:200]}
            self_inner._at, self_inner._val = _t.time(), v
            return v
    cas = _Summary()
    if config.get("wal_rescue", True):
        from pg_arca.wal_rescue import WalRescue
        WalRescue(rt, wal, config).start()
    ex = OperationExecutor(config, rt.db, rt.patroni, discovery=lambda: rt.refresh(), runtime=rt)
    from pg_arca.wal_spool import Pusher, spool_dir
    from pg_arca.wal_archive import _last_error as _wal_last_error
    # asynchronous archiving: the pusher runs ALWAYS (a spool left by an earlier configuration must still drain); archive_command spools only when
    # wal_archive_async is set AND this pusher is alive (heartbeat file)
    Pusher(wal, spool_dir(config.get("state_dir")), workers=int(config.get("wal_spool_workers", 2)),
           log=lambda lv, m: logger.log({"warn": logging.WARNING, "error": logging.ERROR}.get(lv, logging.INFO), "%s", m),
           on_error=lambda name, msg: _wal_last_error(config["wal_archive_dir"], name, msg)).start()
    from pg_arca.offsite import Mirror                      # offsite copy on S3-compatible storage: runs only when configured (console -> agent settings)
    Mirror(config, config.get("state_dir", "/var/lib/pgarca/state"), log=lambda lv, m: logger.log({"warn": logging.WARNING, "error": logging.ERROR}.get(lv, logging.INFO), "[offsite] %s", m)).start()
    stop = threading.Event()
    client = None
    mode = config["connection_mode"]
    if mode in ("push", "hybrid"):
        client = ConsoleClient(config, rt, ex, wal, cas, LogShipper(config, rt))
        client.start()
        logger.info("console link -> %s", config["web_server_url"])

    httpd = None
    if mode in ("daemon", "hybrid"):
        httpd = ThreadingSimpleServer((config["listen_host"], int(config["listen_port"])), make_agent_handler(config, rt, ex, wal, cas))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        logger.info("inbound API on %s:%s", config["listen_host"], config["listen_port"])

    def shutdown(signum, frame):
        logger.info("signal %s: shutting down", signum)
        stop.set()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    stop.wait()
    if client:
        client.stop()
    if httpd:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
