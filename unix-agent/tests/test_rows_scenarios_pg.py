"""Row recovery scenarios beyond the plain table: a PARTITIONED table (the mass DELETE touches every partition), a composite key, a mass UPDATE.
The WAL search must name the table the DBA knows (the partitioned parent, not only its leaves) and finish=rows_all must bring the rows back.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_rows_scenarios_pg'"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine import walscan
from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_object, apply_rows, _drop_db, _dest_conn

DB = "arca_rows"
S = {}


def setUpModule():
    T.setUpModule()
    q("postgres", "CREATE DATABASE %s" % DB)
    q(DB, "CREATE TABLE sales(id int, d date, amount numeric, PRIMARY KEY (id, d)) PARTITION BY RANGE (d);"
          "CREATE TABLE sales_a PARTITION OF sales FOR VALUES FROM ('2026-01-01') TO ('2026-07-01');"
          "CREATE TABLE sales_b PARTITION OF sales FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');"
          "INSERT INTO sales SELECT g, '2026-01-01'::date + (g % 360), g FROM generate_series(1, 6000) g;"
          "CREATE TABLE stock(sku text, wh int, qty int, PRIMARY KEY (sku, wh)); INSERT INTO stock SELECT 'sku' || g, g % 3, 10 FROM generate_series(1, 3000) g")
    parts = "".join("CREATE TABLE hp_%d PARTITION OF hp FOR VALUES WITH (MODULUS 64, REMAINDER %d);" % (i, i) for i in range(64))
    q(DB, "CREATE TABLE hp(id int PRIMARY KEY, v text) PARTITION BY HASH (id);" + parts + "INSERT INTO hp SELECT g, 'v' FROM generate_series(1, 2000) g")
    run_backup(F.ctx, "full")
    S["sales"] = q(DB, "SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM sales t")[0][0]
    S["stock"] = q(DB, "SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM stock t")[0][0]
    time.sleep(1.2)
    q(DB, "DELETE FROM sales WHERE amount > 100")                     # across both partitions
    q(DB, "UPDATE stock SET qty = 0")                                 # composite key, every row
    q(DB, "DELETE FROM hp WHERE id <= 1100")                          # ~17 rows in each of 64 partitions: every partition alone is below the floor
    seg = q("postgres", "SELECT pg_walfile_name(pg_switch_wal())")[0][0]
    for _ in range(120):
        if (q("postgres", "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")[0][0] or "") >= seg:
            break
        time.sleep(0.5)


def tearDownModule():
    T.tearDownModule()


class Rows(unittest.TestCase):
    def test_01_the_search_names_the_partitioned_table(self):
        r = walscan.scan(F.ctx, mode="dml", hours=1, min_rows=1000, cache_dir=os.path.join(F.scratch, "fxr"))
        dels = [e for e in r["events"] if e["kind"] == "DELETE" and any(".public.sales" in n for n in e["names"])]
        self.assertTrue(dels, r["events"])
        names = dels[-1]["names"]
        self.assertIn("%s.public.sales" % DB, names, "the DBA looks for 'sales', not its partitions: %s" % names)
        S["del"] = dels[-1]
        upd = [e for e in r["events"] if e["kind"] == "UPDATE" and "%s.public.stock" % DB in e["names"]]
        self.assertTrue(upd, r["events"])
        S["upd"] = upd[-1]

    def test_01b_many_small_partitions_add_up(self):
        r = walscan.scan(F.ctx, mode="dml", hours=1, min_rows=1000, cache_dir=os.path.join(F.scratch, "fxr2"))
        hp = [e for e in r["events"] if "%s.public.hp" % DB in e["names"]]
        self.assertTrue(hp and hp[-1]["rows"] == 1100, [(e["names"][0], e["rows"]) for e in r["events"]])

    def test_02_rows_of_the_partitioned_table_come_back(self):
        e = S["del"]
        r = restore_object(F.ctx, DB, objects=["%s.public.sales" % DB], target_xid=str(e["xid"]), inclusive=False, stage_db="pgarca_stage_rows1")
        apply_rows(F.ctx, "pgarca_stage_rows1", "%s.public.sales" % DB, restore_all=["missing", "changed"])
        self.assertEqual(q(DB, "SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM sales t")[0][0], S["sales"])

    def test_03_a_mass_update_on_a_composite_key_is_reverted(self):
        e = S["upd"]
        restore_object(F.ctx, DB, objects=["%s.public.stock" % DB], target_xid=str(e["xid"]), inclusive=False, stage_db="pgarca_stage_rows2")
        apply_rows(F.ctx, "pgarca_stage_rows2", "%s.public.stock" % DB, restore_all=["missing", "changed"])
        self.assertEqual(q(DB, "SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM stock t")[0][0], S["stock"])


if __name__ == "__main__":
    unittest.main()
