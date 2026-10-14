"""_wait_for_wal: the backup's WAL phase. On a standby, a shared archive receives the primary's segments and the wait ends; an
archive that receives NOTHING is diagnosed early as not shared (PGA-WAL-021 path) instead of a blind two-minute timeout."""
import time
import unittest

from pg_arca.engine import backup as B


class FakeWal(object):
    def __init__(self, arriving_at=None, active=False):
        self.wal_dir = "/x/wal"
        self.t0 = time.time()
        self.arriving_at = arriving_at          # seconds after start when every needed segment "lands"
        self.active = active                    # archive receives *something* (other segments)

    def has_segment(self, name, anywhere=True):
        return self.arriving_at is not None and time.time() - self.t0 >= self.arriving_at

    def activity_since(self, ts):
        return self.active or (self.arriving_at is not None and time.time() - self.t0 >= self.arriving_at)


class Ctx(object):
    def __init__(self, wal):
        self.wal = wal
        self.logged = []

    def log(self, level, msg):
        self.logged.append((level, msg))


class Sess(object):
    def __init__(self, fail=False):
        self.queries = []
        self.fail = fail

    def query(self, q):
        self.queries.append(q)
        if self.fail:
            raise B.EngineError("PGA-X", "switch failed", "")
        return []


ARGS = dict(tli=1, start_lsn="0/1000000", stop_lsn="0/1000100", seg_size=16 * 1024 * 1024)


class WaitForWal(unittest.TestCase):
    def test_primary_switches_and_completes(self):
        sess = Sess()
        ok, missing, diag = B._wait_for_wal(Ctx(FakeWal(arriving_at=0.2)), sess, in_recovery=False, timeout=5, cancel=None, **ARGS)
        self.assertTrue(ok); self.assertEqual(missing, []); self.assertEqual(diag, "")
        self.assertTrue(any("pg_switch_wal" in q for q in sess.queries), "the primary closes its own segment")

    def test_standby_shared_archive_completes_without_local_switch(self):
        sess = Sess()
        ok, missing, diag = B._wait_for_wal(Ctx(FakeWal(arriving_at=0.2)), sess, in_recovery=True, timeout=5, cancel=None, **ARGS)
        self.assertTrue(ok)
        self.assertEqual(sess.queries, [], "a standby never runs pg_switch_wal (the console asks the primary)")

    def test_standby_archive_not_shared_fails_fast_with_diag(self):
        t0 = time.time()
        ok, missing, diag = B._wait_for_wal(Ctx(FakeWal(arriving_at=None, active=False)), Sess(), in_recovery=True, timeout=30, cancel=None, **ARGS)
        self.assertFalse(ok); self.assertEqual(diag, "stale"); self.assertTrue(missing)
        self.assertLess(time.time() - t0, 20, "diagnosed well before the timeout")

    def test_standby_active_archive_waits_full_timeout(self):
        ok, missing, diag = B._wait_for_wal(Ctx(FakeWal(arriving_at=None, active=True)), Sess(), in_recovery=True, timeout=2, cancel=None, **ARGS)
        self.assertFalse(ok); self.assertEqual(diag, "", "segments flow but ours are missing: plain timeout, not 'not shared'")

    def test_primary_switch_failure_is_reported(self):
        ok, missing, diag = B._wait_for_wal(Ctx(FakeWal(arriving_at=None, active=True)), Sess(fail=True), in_recovery=False, timeout=1, cancel=None, **ARGS)
        self.assertFalse(ok); self.assertEqual(diag, "switch_failed")


if __name__ == "__main__":
    unittest.main()
