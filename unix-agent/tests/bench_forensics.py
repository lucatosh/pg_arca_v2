"""Measures the WAL forensics (search for DROP / TRUNCATE) on a real PostgreSQL with N archived segments, a third of them busy and the rest nearly empty (the archive_timeout
segments of an idle database), with a TRUNCATE in the middle and a DROP at the end.  Not a unit test: prints times.
   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m tests.bench_forensics [segments]'"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests import test_engine_pg as base
from tests.test_engine_pg import F, q
from pg_arca.engine.maintenance import forensics, forensics_legacy


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    base.setUpModule()
    try:
        q("postgres", "CREATE TABLE bench_t(id serial, v text); CREATE TABLE bench_x(id int)")
        for i in range(n):
            if i % 3 == 0:
                q("postgres", "INSERT INTO bench_t(v) SELECT repeat(md5(g::text), 4) FROM generate_series(1, 60000) g")
            else:
                q("postgres", "INSERT INTO bench_x VALUES (%d)" % i)                      # a few records: the segment is almost empty but it exists
            if i == n // 2:
                q("postgres", "TRUNCATE bench_x")
            q("postgres", "SELECT pg_switch_wal()")
        q("postgres", "DROP TABLE bench_t")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(7)
        segs = F.ctx.wal.list_segments()
        size = sum(os.path.getsize(os.path.join(F.wal, f)) for f in os.listdir(F.wal) if os.path.isfile(os.path.join(F.wal, f)))
        print("segments archived: %d (compressed on disk: %.1f MB)" % (len(segs), size / 1048576.0))
        for label in ("legacy", "new first", "new second"):
            t0 = time.time()
            r = forensics_legacy(F.ctx, limit=50) if label == "legacy" else forensics(F.ctx, limit=50, cache_dir=os.path.join(F.wal, "..", "fx-cache"))
            print("%-11s %6.2f s   events=%s kinds=%s scanned=%s %s" % (label, time.time() - t0, len(r["events"]), sorted(set(e["kind"] for e in r["events"])), r.get("segments_scanned"),
                  {k: v for k, v in r.items() if k not in ("events", "segments_scanned", "suggestion")}))
    finally:
        base.tearDownModule()


if __name__ == "__main__":
    main()
