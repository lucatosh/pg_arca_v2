"""Which backup is the base of a restore: with a transaction-id target and the transaction's position known (WAL analysis), the newest set that ends
before it - incremental / differential included - instead of the last FULL one (days of WAL to replay otherwise)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.engine import restore
from pg_arca.engine.util import EngineError


class Repo(object):
    def __init__(self, sets):
        self.sets = sets

    def complete_sets(self):
        return self.sets

    def resolve_set(self, spec):
        return [s for s in self.sets if s["id"] == spec][0]


SETS = [{"id": "F1", "type": "full", "stop_lsn": "0/1000000", "stop_time": "2026-10-11 10:00:00+00"},
        {"id": "F1_D1", "type": "diff", "stop_lsn": "0/5000000", "stop_time": "2026-10-12 10:00:00+00"},
        {"id": "F1_I1", "type": "incr", "stop_lsn": "0/9000000", "stop_time": "2026-10-13 10:00:00+00"}]


class ChooseSet(unittest.TestCase):
    def tearDown(self):
        restore.set_xid_lsn_hint(None)

    def test_xid_without_position_takes_the_last_full(self):
        self.assertEqual(restore.choose_set(Repo(SETS), target_xid="900")["id"], "F1")

    def test_xid_with_position_takes_the_closest_set(self):
        restore.set_xid_lsn_hint("0/9500000")
        self.assertEqual(restore.choose_set(Repo(SETS), target_xid="900")["id"], "F1_I1")
        restore.set_xid_lsn_hint("0/6000000")
        self.assertEqual(restore.choose_set(Repo(SETS), target_xid="900")["id"], "F1_D1")

    def test_explicit_incremental_accepted_only_when_it_ends_before_the_transaction(self):
        restore.set_xid_lsn_hint("0/9500000")
        self.assertEqual(restore.choose_set(Repo(SETS), "F1_I1", target_xid="900")["id"], "F1_I1")
        restore.set_xid_lsn_hint("0/6000000")
        with self.assertRaises(EngineError):
            restore.choose_set(Repo(SETS), "F1_I1", target_xid="900")

    def test_hint_ignored_without_xid(self):
        restore.set_xid_lsn_hint("0/6000000")
        self.assertEqual(restore.choose_set(Repo(SETS))["id"], "F1_I1")


if __name__ == "__main__":
    unittest.main()
