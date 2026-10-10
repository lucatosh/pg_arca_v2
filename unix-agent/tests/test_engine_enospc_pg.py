"""A full repository volume must fail a backup CLEANLY (clear error, no half-written 'successful' set, nothing poisoned) and the next backup must work once there is room.
Needs PG_ARCA_TEST_REPO to be a tiny mounted volume (the harness script mounts a tmpfs) and PG_ARCA_ENOSPC_STEP=full|room.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as T
from pg_arca.engine.backup import run_backup
from pg_arca.engine.util import EngineError

SKIP = T.SKIP or (None if os.environ.get("PG_ARCA_TEST_REPO") else "needs PG_ARCA_TEST_REPO on a small volume")
setUpModule = T.setUpModule
tearDownModule = T.tearDownModule


class EnospcTests(unittest.TestCase):
    def test_01_load(self):
        T.q("postgres", "CREATE DATABASE bulk")
        T.q("bulk", "CREATE TABLE b(x text); INSERT INTO b SELECT (SELECT string_agg(md5(random()::text || g || i), '') FROM generate_series(1,20) i) FROM generate_series(1,60000) g")

    def test_02_step(self):
        step = os.environ.get("PG_ARCA_ENOSPC_STEP", "full")
        if step == "full":
            with self.assertRaises(EngineError) as cm:
                run_backup(T.F.ctx, "full")
            sys.stderr.write("ENOSPC error: %s | %s\n" % (cm.exception.code if hasattr(cm.exception, "code") else "?", str(cm.exception)[:300]))
            sets = T.F.ctx.repo.complete_sets()
            self.assertEqual(sets, [], "a failed backup must not leave a COMPLETE set")
            running = [d for d in os.listdir(os.path.join(T.F.repo, "main", "backup")) if not d.startswith(".")] if os.path.isdir(os.path.join(T.F.repo, "main", "backup")) else []
            sys.stderr.write("leftover set dirs after failure: %s\n" % running)
            self.assertEqual(running, [], "no leftover set directory")
            # and PostgreSQL is not left in backup mode
            self.assertEqual(T.q("postgres", "SELECT count(*) FROM pg_stat_activity WHERE query ILIKE '%pg_backup_start%' AND state <> 'idle' AND pid <> pg_backend_pid()")[0][0], "0")
        else:
            m = run_backup(T.F.ctx, "full")
            self.assertEqual(m["status"], "COMPLETE")


if __name__ == "__main__":
    unittest.main()
