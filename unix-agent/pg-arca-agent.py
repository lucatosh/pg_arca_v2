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


def main():
    config = load_config(os.environ.get("PG_ARCA_CONF_FILE"))
    problems = validate(config)
    if problems:
        for p in problems:
            logger.error("configuration: %s", p)
        return 2

    logger.info("pg_arca agent %s starting on %s (mode=%s)", AGENT_VERSION, config["node_name"], config["connection_mode"])
    rt = Runtime(config)
    inst = rt.instance
    if inst:
        logger.info("managing PostgreSQL %s at %s (port %s, %s)", inst.get("major_version"), inst["data_directory"], inst.get("port"), "running" if inst.get("running") else "STOPPED")
    else:
        logger.warning("no PostgreSQL instance found on this host yet; the agent will keep looking")
    if rt.patroni.configured:
        logger.info("Patroni REST: %s", rt.patroni.patroni_url)

    wal = WalManager(config["wal_archive_dir"], config.get("compression", "zstd"), config.get("compression_level", 3),
                     ((inst or {}).get("control") or {}).get("wal_segment_size") or 16 * 1024 * 1024)
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
