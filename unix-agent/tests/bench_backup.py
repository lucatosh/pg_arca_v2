"""Where a FULL backup spends its time, on a real PostgreSQL with the mixed-type data of tools/lab/big.sql (frac of a ~0.9 GB unit). Not a unit test.
   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m tests.bench_backup [frac] [process_max]'
Prints throughput and the top functions (cProfile, cumulative) of the backup itself."""
import cProfile
import os
import pstats
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests import test_engine_pg as base
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup

BIG_SQL = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tools", "lab", "big.sql")


def main():
    frac = float(sys.argv[1]) if len(sys.argv) > 1 else 0.5
    if len(sys.argv) > 2:
        F_pm = int(sys.argv[2])
    else:
        F_pm = None
    base.setUpModule()
    try:
        if F_pm:
            F.ctx.process_max = F_pm
        q("postgres", "CREATE DATABASE bigb")
        import subprocess
        psql = [os.path.join(base.BIN, "psql"), "-X", "-q", "-h", F.sock, "-p", str(F.port), "-d", "bigb", "-v", "ts=", "-v", "ON_ERROR_STOP=1"]
        subprocess.run(psql + ["-f", BIG_SQL], check=True, stdout=subprocess.DEVNULL)
        t = time.time()
        subprocess.run(psql + ["-c", "CALL big_load(1, %s)" % frac, "-c", "CALL big_finish()"], check=True)
        q("bigb", "CHECKPOINT")
        size = int(q("postgres", "SELECT pg_database_size('bigb')")[0][0])
        print("data: %.0f MB loaded in %.0f s (process_max=%d)" % (size / 1048576.0, time.time() - t, F.ctx.process_max))
        pr = cProfile.Profile()
        t = time.time()
        pr.enable()
        marks = []
        def prog(d):
            if not marks or marks[-1][1] != d.get("phase"):
                marks.append((time.time(), d.get("phase")))
        meta = run_backup(F.ctx, "full", progress=prog)
        pr.disable()
        end = time.time()
        for i, (t0, ph) in enumerate(marks):
            print("   phase %-12s %6.1f s" % (ph, (marks[i + 1][0] if i + 1 < len(marks) else end) - t0))
        dt = time.time() - t
        st = meta.get("stats") or {}
        print("full backup: %.1f s, %.0f MB/s of database, stats %s" % (dt, size / 1048576.0 / dt, {k: st.get(k) for k in ("bytes_read", "bytes_written", "chunks", "chunks_dedup", "files")}))
        pstats.Stats(pr).sort_stats("cumulative").print_stats(25)
    finally:
        base.tearDownModule()


if __name__ == "__main__":
    main()
