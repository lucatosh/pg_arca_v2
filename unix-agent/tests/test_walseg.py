import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.engine.util import last_wal_segno

SEG = 16 * 1024 * 1024


class LastSegment(unittest.TestCase):
    def test_standby_stop_on_segment_boundary_does_not_need_the_empty_next_segment(self):
        # start 0/4C000028, stop 0/4D000000 (standby: end of the last record, exclusive) -> segment 0x4C is the last one needed
        self.assertEqual(last_wal_segno({"stop_lsn": "0/4D000000", "from_standby": True}, SEG), 0x4C)

    def test_primary_stop_on_boundary_is_that_segment(self):
        # on a primary the stop LSN is the START of the end-of-backup record: that record is IN the segment that starts there
        self.assertEqual(last_wal_segno({"stop_lsn": "0/4D000000", "from_standby": False}, SEG), 0x4D)

    def test_inside_a_segment_is_unchanged(self):
        self.assertEqual(last_wal_segno({"stop_lsn": "0/4D000138", "from_standby": True}, SEG), 0x4D)
        self.assertEqual(last_wal_segno({"stop_lsn": "1/00000000", "from_standby": True}, SEG), 0xFF)


if __name__ == "__main__":
    unittest.main()
