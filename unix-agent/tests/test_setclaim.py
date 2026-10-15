"""Claiming the directory of a new backup set (Repo.claim_set_dir) and cleaning the ones left without a meta (Repo.stale_set_dirs).
On NFS a retransmitted MKDIR answers EEXIST for a directory the agent itself just created (seen on the lab, NFSv4 under load): the
exclusive-create marker decides who owns it. No PostgreSQL needed."""
import os
import shutil
import tempfile
import time
import unittest

from pg_arca.engine.repo import Repo


class SetClaim(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="pgarca-claim-")
        self.repo = Repo(os.path.join(self.d, "repo"), "main", algo="zlib")
        self.repo.init()
        self.bdir = self.repo.own_path("backup")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_fresh_id_is_claimed(self):
        self.assertTrue(self.repo.claim_set_dir("20261015-181127F"))
        self.assertTrue(os.path.exists(os.path.join(self.bdir, "20261015-181127F", ".claim")))

    def test_directory_left_by_our_own_retransmitted_mkdir_is_still_ours(self):
        os.makedirs(os.path.join(self.bdir, "20261015-181127F"))                 # the MKDIR that succeeded; its reply was lost
        self.assertTrue(self.repo.claim_set_dir("20261015-181127F"))

    def test_only_one_writer_wins(self):
        self.assertTrue(self.repo.claim_set_dir("20261015-181127F", "a"))
        self.assertFalse(self.repo.claim_set_dir("20261015-181127F", "b"))

    def test_an_existing_set_is_never_claimed(self):
        d = os.path.join(self.bdir, "20261015-181127F")
        os.makedirs(d)
        with open(os.path.join(d, "meta.json"), "w") as f:
            f.write('{"id": "20261015-181127F", "status": "COMPLETE"}')
        self.assertFalse(self.repo.claim_set_dir("20261015-181127F"))
        self.assertFalse(os.path.exists(os.path.join(d, ".claim")), "no marker left in a real set")

    def test_stale_dirs(self):
        old_empty = os.path.join(self.bdir, "20261014-100000F"); os.makedirs(old_empty)
        old_claim = os.path.join(self.bdir, "20261014-110000F"); os.makedirs(old_claim)
        open(os.path.join(old_claim, ".claim"), "w").close()
        old_set = os.path.join(self.bdir, "20261014-120000F"); os.makedirs(old_set)
        with open(os.path.join(old_set, "meta.json"), "w") as f:
            f.write("{}")
        young = os.path.join(self.bdir, "20261015-100000F"); os.makedirs(young)
        past = time.time() - 2 * 86400
        for p in (old_empty, old_claim, old_set):
            os.utime(p, (past, past))
        self.assertEqual(sorted(self.repo.stale_set_dirs()), ["20261014-100000F", "20261014-110000F"])


if __name__ == "__main__":
    unittest.main()
