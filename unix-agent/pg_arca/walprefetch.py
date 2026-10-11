"""Read-ahead for restore_command.

PostgreSQL asks for the archived WAL one segment at a time and waits for each answer. With the plain `pg-arca-wal get` every answer costs a python start, the
decompression, a sha256 check and an fsync - MEASURED 133 ms per 16 MB segment against 53 ms for the decompression alone - and on a sparse restore (one database out of
many: little to replay) that wait IS the recovery: 14.0 s of the 15.1 s recovery phase of a 105-segment test were the restore_command.

With PG_ARCA_SPOOL=<dir> set (the engine does it for the instances it recovers), `get` first looks in the spool; a small detached prefetcher keeps the next K segments
there, decompressed and verified, by a few parallel workers. Each served segment is MOVED out of the spool (PostgreSQL recycles restored segments: a hard link would let it
rewrite our copy). Everything degrades to the plain behaviour: no spool dir, no space, a prefetcher that died, a segment not ready -> `get` just does the work itself.
The prefetcher exits after `IDLE` seconds without a request or as soon as the spool directory is removed (the engine removes it when the recovery is over).
"""
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

SEG = re.compile(r"^[0-9A-F]{24}$")
IDLE = 90.0                      # seconds without a request after which the prefetcher leaves
WAIT_READY = 8.0                 # how long `get` waits for a segment that a worker is just finishing
DEFAULT_AHEAD = 10


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False


def take(spool, name, dest):
    """Serve `name` from the spool into `dest`. True when served. Waits briefly for a segment whose preparation has just started."""
    if not SEG.match(name) or not spool:
        return False
    src = os.path.join(spool, name)
    deadline = time.time() + WAIT_READY
    while True:
        if os.path.exists(src):
            try:
                os.makedirs(os.path.dirname(os.path.abspath(dest)) or ".", exist_ok=True)
                try:
                    os.rename(src, dest)                       # same filesystem: instant
                except OSError:
                    tmp = dest + ".arca.%d" % os.getpid()
                    shutil.copyfile(src, tmp)
                    os.rename(tmp, dest)
                    os.unlink(src)
                return True
            except FileNotFoundError:
                return False                                   # somebody else took it
            except OSError:
                return False
        try:
            busy = [f for f in os.listdir(spool) if f.startswith(name + ".arca.")]
        except OSError:
            return False
        fresh = False
        for f in busy:
            try:
                fresh = fresh or (time.time() - os.stat(os.path.join(spool, f)).st_mtime) < 15
            except OSError:
                pass
        if not fresh or time.time() > deadline:
            return False
        time.sleep(0.004)


def kick(spool, name, ahead=None):
    """Tell the prefetcher where the recovery is (and start it if it is not running)."""
    if not SEG.match(name) or not spool:
        return
    try:
        os.makedirs(spool, mode=0o700, exist_ok=True)
        cur = os.path.join(spool, ".cursor")
        tmp = cur + ".%d" % os.getpid()
        with open(tmp, "w") as f:
            f.write(name)
        os.rename(tmp, cur)
        lock = os.path.join(spool, ".lock")
        try:
            with open(lock) as f:
                if _pid_alive(int(f.read().strip() or 0)):
                    return
        except (OSError, ValueError):
            pass
        k = int(ahead or os.environ.get("PG_ARCA_PREFETCH") or DEFAULT_AHEAD)
        if k <= 0:
            return
        home = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        code = "import sys; sys.path.insert(0, %r); from pg_arca.wal_archive import main; sys.exit(main(['x', 'prefetch', %r, %r]))" % (home, spool, str(k))
        p = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        with open(lock, "w") as f:
            f.write(str(p.pid))
    except OSError:
        pass                                                   # no spool: plain behaviour


def _next_names(all_names, cur, k):
    try:
        i = all_names.index(cur)
    except ValueError:
        return []
    out = []
    for n in all_names[i + 1:i + 1 + k]:
        if n[:8] != cur[:8]:
            break                                              # another timeline: PostgreSQL will ask for it by name when it needs it
        out.append(n)
    return out


def run(wm, spool, ahead):
    """The prefetcher loop (runs detached, started by kick())."""
    ahead = max(1, int(ahead))
    jobs = max(1, min(int(os.environ.get("PG_ARCA_PREFETCH_JOBS") or 3), (os.cpu_count() or 2) * 2))
    names = wm.list_segments()
    last_req, last_seen, flight, listed = time.time(), None, {}, time.time()
    pool = ThreadPoolExecutor(max_workers=jobs)
    try:
        while os.path.isdir(spool):
            try:
                with open(os.path.join(spool, ".cursor")) as f:
                    cur = f.read().strip()
            except OSError:
                cur = None
            if cur and cur != last_seen:
                last_seen, last_req = cur, time.time()
            if time.time() - last_req > IDLE:
                break
            if cur:
                want = _next_names(names, cur, ahead)
                if (cur not in names or len(want) < ahead) and time.time() - listed > 2.0:
                    names, listed = wm.list_segments(), time.time()      # the archive grew while we were running (a recovery that follows a live primary)
                    want = _next_names(names, cur, ahead)
                try:
                    free = shutil.disk_usage(spool).free
                except OSError:
                    free = 0
                for n in want:
                    if n in flight and not flight[n].done():
                        continue
                    if os.path.exists(os.path.join(spool, n)):
                        continue
                    if free < (ahead + 2) * 2 * wm.segment_size:
                        break                                    # never fill the volume for a convenience
                    flight[n] = pool.submit(_prepare, wm, spool, n)
                for n in [k for k, v in flight.items() if v.done()]:
                    del flight[n]
            time.sleep(0.02)
    finally:
        pool.shutdown(wait=False)
        try:
            for f in os.listdir(spool):
                if f != ".lock":
                    try:
                        os.unlink(os.path.join(spool, f))
                    except OSError:
                        pass
            os.unlink(os.path.join(spool, ".lock"))
            os.rmdir(spool)
        except OSError:
            pass


def _prepare(wm, spool, name):
    try:
        code, _msg = wm.retrieve_segment(name, os.path.join(spool, name))     # decrypt + decompress + sha256 verified, atomically renamed into place
        return code == 0
    except Exception:
        return False
