"""WAL forensics for the most common accident after DROP/TRUNCATE: a DELETE or UPDATE without WHERE. Mode "dml" sums row changes per transaction and
table, keeps the mass ones, drops the rolled-back ones, gives the exact commit time and the xid to stop just before it.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_forensics_dml_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine import walscan
from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_object
from pg_arca.engine.pgsession import PgSession

DB = "arca_dml"
S = {}


def setUpModule():
    base.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, "CREATE TABLE orders (id int PRIMARY KEY, status text, amount numeric); INSERT INTO orders SELECT g, 'open', g FROM generate_series(1, 5000) g;"
          "CREATE TABLE prices (id int PRIMARY KEY, p numeric); INSERT INTO prices SELECT g, g FROM generate_series(1, 3000) g")
    run_backup(F.ctx, "full")
    q(DB, "DELETE FROM orders WHERE id <= 10")                         # small: not a mass change
    s = PgSession(F.conn.with_db(DB))
    try:                                                                # a big UPDATE that is ROLLED BACK: nothing was lost, never reported
        s.query("BEGIN")
        s.query("UPDATE prices SET p = 0")
        s.query("ROLLBACK")
    finally:
        s.close()
    q(DB, "UPDATE prices SET p = p * 100 WHERE id <= 2500")           # big committed UPDATE
    time.sleep(1.2)
    q(DB, "DELETE FROM orders")                                        # the accident
    S["after"] = time.time()
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    base.tearDownModule()


class Dml(unittest.TestCase):
    def test_01_finds_the_mass_changes_only(self):
        r = walscan.scan(F.ctx, mode="dml", hours=1, min_rows=1000, cache_dir=os.path.join(F.scratch, "fxd"))
        ev = [(e["kind"], e["names"][0], e["rows"], e["committed"]) for e in r["events"]]
        self.assertIn(("DELETE", "%s.public.orders" % DB, 4990, True), ev, ev)
        self.assertIn(("UPDATE", "%s.public.prices" % DB, 2500, True), ev, ev)
        self.assertFalse(any(e["rows"] == 3000 for e in r["events"]), "the rolled-back UPDATE must not appear: %s" % ev)
        d = [e for e in r["events"] if e["kind"] == "DELETE"][0]
        self.assertTrue(d["time_exact"], d)
        S["xid"] = d["xid"]
        self.assertEqual(r["suggestion"]["target_xid"], d["xid"])
        r2 = walscan.scan(F.ctx, mode="dml", hours=1, min_rows=1000, cache_dir=os.path.join(F.scratch, "fxd"))
        self.assertEqual(r2["segments_cached"], r2["window"]["segments"])
        self.assertEqual([e["xid"] for e in r2["events"]], [e["xid"] for e in r["events"]])

    def test_02_restore_just_before_the_delete(self):
        restore_object(F.ctx, DB, objects=["%s.public.orders" % DB], target_xid=S["xid"], inclusive=False, stage_db="pgarca_stage_dml")
        promote_object(F.ctx, "pgarca_stage_dml", DB, mode="replace", drop_stage=True)
        self.assertEqual(q(DB, "SELECT count(*) FROM orders")[0][0], "4990")


if __name__ == "__main__":
    unittest.main()
