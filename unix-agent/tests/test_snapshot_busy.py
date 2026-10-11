"""A busy server is not a dead server: when the full telemetry query times out (heavy I/O, a bulk load) the agent still reports the node alive and in its
role (the console would otherwise refuse every backup with 'no node with PostgreSQL running' - seen on the lab during a 10 GB load)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca import db_client


class Busy(db_client.PostgresClient):
    def __init__(self, full_ok):
        db_client.PostgresClient.__init__(self)
        self.full_ok = full_ok

    def query_json(self, sql, dbname="postgres", variables=None, timeout=25):
        if sql is db_client.SNAPSHOT_SQL:
            return ({"version": "16.4", "is_in_recovery": False, "databases": [{"oid": 5, "name": "postgres"}]}, "") if self.full_ok else (None, "timeout after 25 s")
        if sql is db_client.LITE_SQL:
            return {"version": "16.4", "is_in_recovery": False, "role": "primary", "current_lsn": "0/1"}, ""
        if sql is db_client.DB_SIZES_SQL:
            return {"5": 8192}, ""
        if sql is db_client.REPLICATION_SQL:
            return [], ""
        return None, "unexpected"


class SnapshotUnderLoad(unittest.TestCase):
    def test_full_snapshot_has_cached_sizes(self):
        s = Busy(True).get_snapshot()
        self.assertTrue(s["alive"])
        self.assertEqual(s["databases"], [{"oid": 5, "name": "postgres", "size": 8192}])

    def test_timeout_keeps_the_node_alive_and_primary(self):
        c = Busy(True); c.get_snapshot()
        c.full_ok = False
        s = c.get_snapshot()
        self.assertTrue(s["alive"]); self.assertTrue(s["partial"]); self.assertFalse(s["is_in_recovery"])
        self.assertIn("timeout", s["telemetry_error"])
        self.assertEqual(s["databases"][0]["size"], 8192)          # last known list kept


if __name__ == "__main__":
    unittest.main()
