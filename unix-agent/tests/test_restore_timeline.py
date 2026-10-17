"""recovery_target_timeline is written as the NUMBER the restore checks chose, never as PostgreSQL's own 'latest': a history gap (a dead branch filed
away into quarantine) must not make the recovery settle on an older timeline, a higher dead branch must not stop it, and a timeline whose history
sits in the previous archive location (destination change) is still followed."""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.wal_manager import WalManager
from pg_arca.engine.restore import concrete_timeline, recovery_lines, _recovery_path


class Ctx:
    def __init__(self, wal):
        self.wal, self.logs = wal, []

    def log(self, level, msg):
        self.logs.append((level, msg))


def hist(d, tli, lines):
    with open(os.path.join(d, "%08X.history" % tli), "w") as f:
        f.write("".join("%d\t%s\tno recovery target specified\n" % x for x in lines))


class ConcreteTimeline(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); self.prev = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.d); self.addCleanup(shutil.rmtree, self.prev)

    def test_gap_in_history_numbers_is_crossed(self):
        # 1 -> 2 -> (3 was a dead branch, filed away) -> 4 forked from 2
        hist(self.d, 2, [(1, "0/3000000")])
        hist(self.d, 4, [(1, "0/3000000"), (2, "0/5000000")])
        ctx = Ctx(WalManager(self.d, compression="none", create=False))
        self.assertEqual(concrete_timeline(ctx, [{"timeline": 1}]), "4", "PostgreSQL's 'latest' would stop at 2 (no 00000003.history)")
        self.assertEqual(concrete_timeline(ctx, [{"timeline": 2}]), "4")
        self.assertIn("recovery_target_timeline = '4'", str(recovery_lines("cmd", timeline=concrete_timeline(ctx, [{"timeline": 1}]))))

    def test_higher_dead_branch_not_descending_from_the_backup_is_ignored(self):
        hist(self.d, 2, [(1, "0/3000000")])
        hist(self.d, 3, [(1, "0/2000000")])            # forked from 1 too: a sibling of 2, not on 2's line
        ctx = Ctx(WalManager(self.d, compression="none", create=False))
        self.assertEqual(concrete_timeline(ctx, [{"timeline": 2}]), "2", "3 is not a child of 2: PostgreSQL would refuse to start with 'latest'")

    def test_explicit_values_are_kept(self):
        ctx = Ctx(WalManager(self.d, compression="none", create=False))
        self.assertEqual(concrete_timeline(ctx, [{"timeline": 1}], "current"), "current")
        self.assertEqual(concrete_timeline(ctx, [{"timeline": 1}], "3"), "3")
        self.assertEqual(concrete_timeline(ctx, [{"timeline": 1}]), "1", "no history at all: the backup's own timeline")
        self.assertEqual(concrete_timeline(ctx, []), "latest")

    def test_history_in_the_previous_location_is_followed(self):
        hist(self.prev, 2, [(1, "0/3000000")])
        ctx = Ctx(WalManager(self.d, compression="none", previous=[self.prev], create=False))
        self.assertEqual(concrete_timeline(ctx, [{"timeline": 1}]), "2")
        self.assertEqual(_recovery_path(ctx, 1, "latest"), [(2, None), (1, 0x3000000)])


    def test_a_dead_branch_set_aside_here_is_not_revived_by_the_previous_location(self):
        hist(self.d, 2, [(1, "0/3000000")])
        hist(self.prev, 2, [(1, "0/3000000")]); hist(self.prev, 3, [(1, "0/3000000"), (2, "0/6000000")])   # 3: retired as dead in the current archive
        os.makedirs(os.path.join(self.d, "conflicts", "dead-branch-00000003"))
        ctx = Ctx(WalManager(self.d, compression="none", previous=[self.prev], create=False))
        self.assertEqual(concrete_timeline(ctx, [{"timeline": 1}]), "2")
        hist(self.d, 3, [(1, "0/3000000"), (2, "0/7000000")])                          # the number reused for real later: followed
        self.assertEqual(concrete_timeline(ctx, [{"timeline": 1}]), "3")


if __name__ == "__main__":
    unittest.main()
