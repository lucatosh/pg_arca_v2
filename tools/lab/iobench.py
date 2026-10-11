#!/usr/bin/env python3
"""Lab micro-benchmark of what a backup does per 64 KiB chunk, on the real files of a node: read, blake2b, zlib/zstd, write a CAS file. usage: python3 iobench.py <data dir> [MB]"""
import hashlib, os, sys, time, zlib, tempfile, threading
from concurrent.futures import ThreadPoolExecutor
root = sys.argv[1]; limit = int(sys.argv[2] if len(sys.argv) > 2 else 600) << 20
files = []
for dp, _, fs in os.walk(root):
    for f in fs:
        p = os.path.join(dp, f)
        try:
            if os.path.getsize(p) > 8 << 20: files.append(p)
        except OSError: pass
files.sort(key=os.path.getsize, reverse=True)
chunks, total = [], 0
t = time.time()
for p in files:
    with open(p, "rb") as f:
        while total < limit:
            b = f.read(65536)
            if not b: break
            chunks.append(b); total += len(b)
    if total >= limit: break
rd = time.time() - t
print("read   %.0f MB in %.1f s = %.0f MB/s (page cache may help)" % (total / 1e6, rd, total / 1e6 / rd))
def bench(name, fn, workers):
    t = time.time()
    with ThreadPoolExecutor(workers) as ex: list(ex.map(fn, chunks))
    d = time.time() - t; print("%-28s x%d threads: %.0f MB/s" % (name, workers, total / 1e6 / d))
for w in (1, 4):
    bench("blake2b", lambda b: hashlib.blake2b(b, digest_size=32).digest(), w)
    bench("zlib level 3", lambda b: zlib.compress(b, 3), w)
    bench("zlib level 1", lambda b: zlib.compress(b, 1), w)
    try:
        import zstandard
        bench("zstd level 3", lambda b: zstandard.ZstdCompressor(level=3).compress(b), w)
    except ImportError:
        pass
d = tempfile.mkdtemp(dir=os.environ.get("BENCH_DIR", "/var/lib/pgarca"))
cnt = [0]
def write(b):
    i = threading.get_ident() * 1000003 + len(b) + cnt.__len__(); cnt[0] += 1
    p = os.path.join(d, "%02x" % (cnt[0] % 256)); os.makedirs(p, exist_ok=True)
    fn = os.path.join(p, "%d.%d" % (cnt[0], threading.get_ident()))
    with open(fn + ".tmp", "wb") as f: f.write(b)
    os.rename(fn + ".tmp", fn)
r3 = sum(len(zlib.compress(b, 3)) for b in chunks[:2000]) / sum(len(b) for b in chunks[:2000]); r1 = sum(len(zlib.compress(b, 1)) for b in chunks[:2000]) / sum(len(b) for b in chunks[:2000])
print("ratio zlib3 %.2f zlib1 %.2f" % (r3, r1))
for w in (1, 4):
    bench("write file per chunk", write, w)
t = time.time(); os.sync(); print("sync %.1f s" % (time.time() - t))
import shutil; shutil.rmtree(d, ignore_errors=True)
