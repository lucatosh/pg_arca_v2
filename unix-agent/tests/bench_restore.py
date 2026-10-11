"""Measures where a restore spends its time, on a real PostgreSQL: backup of a database of N MB, M MB of WAL of churn after it, then restore_database / restore_object to the end of the archive.
Prints the phase timeline of each. Not a unit test.
   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m tests.bench_restore [data_mb] [churn_mb]'"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests import test_engine_pg as base
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup
from pg_arca.engine import granular


class Timeline(object):
    def __init__(self):
        self.t0 = time.time()
        self.marks = []

    def __call__(self, d):
        ph = d.get("phase")
        if not self.marks or self.marks[-1][1] != ph:
            self.marks.append((time.time() - self.t0, ph))

    def show(self, label, total):
        print("  %s: total %.1f s" % (label, total))
        for i, (t, ph) in enumerate(self.marks):
            end = self.marks[i + 1][0] if i + 1 < len(self.marks) else total
            print("     %-12s %6.1f s" % (ph, end - t))


def main():
    mb = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    churn = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    base.setUpModule()
    try:
        q("postgres", "CREATE DATABASE bench")
        q("bench", "CREATE TABLE big(id serial PRIMARY KEY, v text, n int)")
        q("bench", "CREATE TABLE small(id serial PRIMARY KEY, v text)")
        q("bench", "INSERT INTO small(v) SELECT md5(g::text) FROM generate_series(1,1000) g")
        rows = mb * 1024 * 1024 // 120
        t = time.time()
        q("bench", "INSERT INTO big(v, n) SELECT repeat(md5(g::text), 3), g FROM generate_series(1, %d) g" % rows)
        q("bench", "CREATE INDEX ON big(n)")
        q("bench", "CHECKPOINT")
        print("data: %d MB loaded in %.1f s" % (q("bench", "SELECT pg_database_size('bench')/1048576")[0][0] if False else mb, time.time() - t))
        t = time.time()
        meta = run_backup(F.ctx, "full")
        print("full backup: %.1f s (%s written)" % (time.time() - t, meta.get("bytes_written")))
        time.sleep(3)
        t_ok = q("postgres", "SELECT now()::text")[0][0]
        t = time.time()
        n = 0
        while n < churn:                                                  # churn: updates produce WAL (full-page images + tuples)
            q("bench", "UPDATE big SET v = repeat(md5((n+%d)::text), 3) WHERE n %% 5 = %d" % (n, n % 5))
            n += 40
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(8)
        segs = F.ctx.wal.list_segments()
        sz = sum(os.path.getsize(os.path.join(F.wal, f)) for f in os.listdir(F.wal) if os.path.isfile(os.path.join(F.wal, f)))
        print("churn: %.1f s, %d segments archived (%.0f MB on disk)" % (time.time() - t, len(segs), sz / 1048576.0))
        import subprocess, tempfile, shutil
        tmpd = tempfile.mkdtemp(prefix="bench-get-")
        t = time.time()
        for sg in segs:
            subprocess.run(F.ctx.restore_command.replace("%f", sg).replace("%p", os.path.join(tmpd, sg)), shell=True, check=True)
        dt = time.time() - t
        print("restore_command alone (sequential, python pg-arca-wal get): %.1f s for %d segments = %.0f ms/segment" % (dt, len(segs), 1000 * dt / len(segs)))
        t = time.time()
        for sg in segs:
            F.ctx.wal.retrieve_segment(sg, os.path.join(tmpd, sg + ".x"), verify=False)
        dt = time.time() - t
        print("in-process retrieve (no sha/fsync): %.1f s = %.0f ms/segment" % (dt, 1000 * dt / len(segs)))
        shutil.rmtree(tmpd, ignore_errors=True)
        for label, fn in (("restore_database", lambda p: granular.restore_database(F.ctx, "bench", new_name="bench_r", progress=p)),
                          ("restore_object (table small)", lambda p: granular.restore_object(F.ctx, "bench.public.small", progress=p, stage_db="pgarca_stage_b1"))):
            tl = Timeline()
            t = time.time()
            r = fn(tl)
            tl.show(label, time.time() - t)
            print("     result keys:", sorted(k for k in r if k in ("extract_bytes", "cluster_bytes", "wal_replayed", "segments", "dump_bytes")), {k: r[k] for k in ("extract_bytes", "dump_bytes") if k in r})
    finally:
        base.tearDownModule()


if __name__ == "__main__":
    main()
