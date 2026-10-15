"""Asynchronous WAL archiving: archive_command parks the segment in a local spool and returns at once; the agent pushes the spool into the
archive in the background, in parallel. For servers whose WAL rate is higher than what the synchronous archive_command sustains (slow network
share, no zstd), and for keeping PostgreSQL's archiver from waiting on the archive's latency.

The trade-off, stated plainly: a segment in the spool is NOT in the archive yet. If this host is lost before the pusher gets to it, that WAL is
lost (PostgreSQL has already recycled it). The console shows the spool depth and the recovery point accounts for it. Off by default
(agent setting `wal_archive_async`).

Safety valves: the spool accepts a segment only while the pusher is alive (heartbeat file) and below SPOOL_MAX segments; otherwise
archive_command archives synchronously as before, so a dead pusher or a dead archive never let WAL pile up silently in a local directory.
The pusher reuses WalManager.archive_segment: every check (owner system id, divergent content quarantine, write-once publish) applies.
"""

import json
import os
import shutil
import threading
import time

SPOOL_MAX = 512                              # segments (8 GiB of 16 MiB segments) the spool may hold before archive_command goes synchronous
PUSHER_STALE_SEC = 120
HEARTBEAT = ".pusher"
STATUS = ".status.json"
RETRY_SEC = 15                               # a segment the archive refused is retried this often (its reason is reported meanwhile)


def spool_dir(state_dir):
    return os.path.join(state_dir or "/var/lib/pgarca/state", "walspool")


def pusher_alive(spool):
    try:
        return time.time() - os.stat(os.path.join(spool, HEARTBEAT)).st_mtime < PUSHER_STALE_SEC
    except OSError:
        return False


def pending(spool):
    """Segment files waiting in the spool, oldest first (by name: WAL names sort chronologically within a timeline)."""
    try:
        return sorted(n for n in os.listdir(spool) if not n.startswith("."))
    except OSError:
        return []


def accept(spool, src_path, name, max_segments=SPOOL_MAX):
    """Park `src_path` as `name` in the spool. False (= archive synchronously) when the pusher is not alive, the spool is full, or the copy fails."""
    try:
        if not pusher_alive(spool):
            return False
        if len(pending(spool)) >= max_segments:
            return False
        tmp = os.path.join(spool, ".%s.tmp.%d" % (name, os.getpid()))
        final = os.path.join(spool, name)
        with open(src_path, "rb") as fi, open(tmp, "wb") as fo:
            shutil.copyfileobj(fi, fo, 1048576)
            fo.flush()
            os.fsync(fo.fileno())
        os.rename(tmp, final)
        fd = os.open(spool, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return True
    except OSError:
        try:
            os.unlink(tmp)
        except Exception:
            pass
        return False


def status(spool):
    try:
        with open(os.path.join(spool, STATUS), "r", encoding="utf-8") as f:
            st = json.load(f)
    except (IOError, OSError, ValueError):
        st = {}
    names = pending(spool)
    oldest = None
    if names:
        try:
            oldest = time.time() - os.stat(os.path.join(spool, names[0])).st_mtime
        except OSError:
            oldest = None
    st.update(pending=len(names), oldest_age_sec=int(oldest) if oldest is not None else None, alive=pusher_alive(spool))
    return st


class Pusher(object):
    """Background thread of the agent: pushes the spool into the WAL archive with `workers` parallel archive_segment calls."""

    def __init__(self, wm, spool, workers=2, log=None, on_error=None):
        self.wm, self.spool, self.workers = wm, spool, max(1, int(workers))
        self.log = log or (lambda lv, m: None)
        self.on_error = on_error                               # callable(name, message or None): mirrors .last_archive_error.json for the console
        self._stop = threading.Event()
        self._retry_at = {}
        self.pushed = 0
        self.failed = 0
        self.last_push = None
        self.last_error = None

    def heartbeat(self):
        os.makedirs(self.spool, mode=0o750, exist_ok=True)
        p = os.path.join(self.spool, HEARTBEAT)
        with open(p, "a"):
            pass
        os.utime(p, None)

    def _one(self, name):
        from pg_arca.wal_manager import WalArchiveError
        path = os.path.join(self.spool, name)
        try:
            self.wm.archive_segment(path, name)
            os.unlink(path)
            self.pushed += 1
            self.last_push = time.time()
            if self.last_error and self.last_error.get("segment") == name:
                self.last_error = None
                if self.on_error:
                    self.on_error(None, None)
            return True
        except WalArchiveError as e:
            msg = str(e)
        except OSError as e:
            msg = "PGA-WAL-099 %s" % e
        except Exception as e:
            msg = "PGA-WAL-099 %s" % e
        self.failed += 1
        self.last_error = {"segment": name, "error": msg[:600], "at": time.time()}
        self._retry_at[name] = time.time() + RETRY_SEC
        if self.on_error:
            self.on_error(name, msg)
        self.log("warn", "WAL spool: %s not archived: %s" % (name, msg))
        return False

    def cycle(self):
        """One pass over the spool. Returns the number of segments archived."""
        self.heartbeat()
        now = time.time()
        names = [n for n in pending(self.spool) if self._retry_at.get(n, 0) <= now]
        if not names:
            self._write_status()
            return 0
        done = [0]
        lock = threading.Lock()
        it = iter(names)

        def worker():
            while not self._stop.is_set():
                with lock:
                    n = next(it, None)
                if n is None:
                    return
                if self._one(n):
                    with lock:
                        done[0] += 1
        ts = [threading.Thread(target=worker, daemon=True) for _ in range(min(self.workers, len(names)))]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self._write_status()
        return done[0]

    def _write_status(self):
        st = {"pushed": self.pushed, "failed": self.failed, "last_push": self.last_push, "last_error": self.last_error, "workers": self.workers, "at": time.time()}
        p = os.path.join(self.spool, STATUS)
        try:
            with open(p + ".tmp", "w", encoding="utf-8") as f:
                json.dump(st, f)
            os.rename(p + ".tmp", p)
        except OSError:
            pass

    def start(self, interval=1.0):
        def loop():
            while not self._stop.is_set():
                try:
                    n = self.cycle()
                except Exception as e:                         # never let the pusher die: a dead pusher makes archive_command synchronous again
                    self.log("warn", "WAL spool pusher: %s" % e)
                    n = 0
                self._stop.wait(0.2 if n else interval)
        t = threading.Thread(target=loop, name="wal-spool", daemon=True)
        t.start()
        return t

    def stop(self):
        self._stop.set()
