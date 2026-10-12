"""Randomised restore of RELATED tables: customers / products / orders / order_lines with foreign keys (one ON DELETE CASCADE), views and a materialized view.
A seeded workload (inserts, updates, deletes, TRUNCATE ... CASCADE, a DROP ... CASCADE that is then re-created) with fingerprints at every step; then
random GROUPS of tables are restored at random instants and promoted with mode replace or missing_only. After every promotion:
  - the restored tables equal the instant, the others are unchanged
  - every foreign key of the schema exists, is VALID, and really holds (no orphan rows)
  - every view and the materialized view still exist and can be queried
Seeded: PG_ARCA_FUZZ_SEED.   as root: su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_restore_fuzz_rel_pg -v'
"""
import os
import random
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import promote_object, restore_object

DB = "fzrel"
SEED = int(os.environ.get("PG_ARCA_FUZZ_SEED") or random.SystemRandom().randint(1, 10 ** 9))
STEPS = int(os.environ.get("PG_ARCA_FUZZ_STEPS") or 30)
TABLES = ["customers", "products", "orders", "order_lines"]
DDL = """
CREATE TABLE customers (id int PRIMARY KEY, name text, city text);
CREATE TABLE products (id int PRIMARY KEY, title text, price numeric(10,2));
CREATE TABLE orders (id int PRIMARY KEY, customer_id int REFERENCES customers(id), at timestamptz DEFAULT clock_timestamp(), note text);
CREATE TABLE order_lines (id int PRIMARY KEY, order_id int REFERENCES orders(id) ON DELETE CASCADE, product_id int REFERENCES products(id), qty int);
CREATE VIEW v_order_totals AS SELECT o.id, o.customer_id, sum(l.qty * p.price) AS total FROM orders o JOIN order_lines l ON l.order_id = o.id JOIN products p ON p.id = l.product_id GROUP BY 1, 2;
CREATE VIEW v_customer_orders AS SELECT c.id, c.name, count(o.id) AS n FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY 1, 2;
CREATE MATERIALIZED VIEW mv_products AS SELECT p.id, count(l.id) AS lines FROM products p LEFT JOIN order_lines l ON l.product_id = p.id GROUP BY 1;
"""
FKS = [("orders", "customer_id", "customers"), ("order_lines", "order_id", "orders"), ("order_lines", "product_id", "products")]


def fp(db=DB):
    out = {}
    for t in TABLES:
        if q(db, "SELECT to_regclass('public.%s') IS NOT NULL" % t)[0][0] == "t":
            out[t] = q(db, "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) || ':' || count(*) FROM %s x" % t)[0][0]
    return out


class FuzzRel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base.setUpModule()
        cls.rng = random.Random(SEED)
        cls.log, cls.points, cls.nid = [], [], 0
        sys.stderr.write("\n[fuzz-rel] seed=%d steps=%d (replay: PG_ARCA_FUZZ_SEED=%d)\n" % (SEED, STEPS, SEED))
        q("postgres", "CREATE DATABASE %s" % DB)
        q(DB, DDL)
        cls._fill(cls)
        run_backup(F.ctx, "full")
        for step in range(STEPS):
            cls._step(cls, step)
            time.sleep(0.6)
            cls.points.append((q("postgres", "SELECT to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0], fp(), step))
            time.sleep(0.6)
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)

    @classmethod
    def tearDownClass(cls):
        base.tearDownModule()

    def _next(self, n):
        a = self.nid + 1
        self.nid += n
        return a

    def _fill(self):
        c, p = self._next(self, 30), self._next(self, 20)
        q(DB, "INSERT INTO customers SELECT %d + g, 'c' || g, (ARRAY['Roma','Milano','Zurigo'])[1 + g %% 3] FROM generate_series(0, 29) g" % c)
        q(DB, "INSERT INTO products SELECT %d + g, 'p' || g, (1 + g) * 1.5 FROM generate_series(0, 19) g" % p)
        self._orders(self, 40)

    def _orders(self, n):
        o = self._next(self, n)
        q(DB, "INSERT INTO orders (id, customer_id, note) SELECT %d + g, (SELECT id FROM customers ORDER BY random() LIMIT 1), md5(g::text) FROM generate_series(0, %d) g "
              "WHERE EXISTS (SELECT 1 FROM customers)" % (o, n - 1))
        l = self._next(self, n * 3)
        q(DB, "INSERT INTO order_lines SELECT %d + g, (SELECT id FROM orders ORDER BY random() LIMIT 1), (SELECT id FROM products ORDER BY random() LIMIT 1), 1 + g %% 5 "
              "FROM generate_series(0, %d) g WHERE EXISTS (SELECT 1 FROM orders) AND EXISTS (SELECT 1 FROM products)" % (l, n * 3 - 1))

    def _step(self, step):
        r = self.rng
        act = r.choices(["orders", "update", "delete_orders", "delete_customer", "new_products", "truncate_lines", "truncate_cascade", "drop_recreate_lines",
                         "refresh", "switch", "incr", "full"], weights=[20, 15, 8, 5, 5, 3, 2, 2, 3, 6, 6, 2])[0]
        if act == "orders":
            self._orders(self, r.randint(1, 20))
        elif act == "update":
            q(DB, "UPDATE %s" % r.choice(["customers SET city = 'Lugano' WHERE id % 4 = 0", "products SET price = price + 1 WHERE id % 3 = 0",
                                          "order_lines SET qty = qty + 1 WHERE id % 5 = 0", "orders SET note = 'changed' WHERE id % 6 = 0"]))
        elif act == "delete_orders":
            q(DB, "DELETE FROM orders WHERE id %% %d = 0" % r.randint(3, 9))            # cascades to their lines
        elif act == "delete_customer":
            q(DB, "DELETE FROM order_lines WHERE order_id IN (SELECT id FROM orders WHERE customer_id = (SELECT min(id) FROM customers)); "
                  "DELETE FROM orders WHERE customer_id = (SELECT min(id) FROM customers); DELETE FROM customers WHERE id = (SELECT min(id) FROM customers)")
        elif act == "new_products":
            p = self._next(self, 5)
            q(DB, "INSERT INTO products SELECT %d + g, 'np' || g, 9.99 FROM generate_series(0, 4) g" % p)
        elif act == "truncate_lines":
            q(DB, "TRUNCATE order_lines")
        elif act == "truncate_cascade":
            q(DB, "TRUNCATE customers CASCADE")                                          # empties orders and lines too
            c = self._next(self, 10)
            q(DB, "INSERT INTO customers SELECT %d + g, 'nc' || g, 'Roma' FROM generate_series(0, 9) g" % c)
        elif act == "drop_recreate_lines":
            q(DB, "DROP TABLE order_lines CASCADE")                                      # the views using it go too, re-created right after
            q(DB, "CREATE TABLE order_lines (id int PRIMARY KEY, order_id int REFERENCES orders(id) ON DELETE CASCADE, product_id int REFERENCES products(id), qty int);"
                  "CREATE OR REPLACE VIEW v_order_totals AS SELECT o.id, o.customer_id, sum(l.qty * p.price) AS total FROM orders o JOIN order_lines l ON l.order_id = o.id "
                  "JOIN products p ON p.id = l.product_id GROUP BY 1, 2;"
                  "CREATE MATERIALIZED VIEW mv_products AS SELECT p.id, count(l.id) AS lines FROM products p LEFT JOIN order_lines l ON l.product_id = p.id GROUP BY 1")
            self._orders(self, 5)
        elif act == "refresh":
            q(DB, "REFRESH MATERIALIZED VIEW mv_products")
        elif act == "switch":
            q("postgres", "SELECT pg_switch_wal()")
        else:
            run_backup(F.ctx, act)
        self.log.append("%d %s" % (step, act))

    def _integrity(self, label):
        bad = []
        for child, col, parent in FKS:
            n = q(DB, "SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND conrelid = '%s'::regclass AND confrelid = '%s'::regclass AND convalidated" % (child, parent))[0][0]
            if n != "1":
                bad.append("FK %s.%s -> %s: %s valid constraint(s)" % (child, col, parent, n))
            orph = q(DB, "SELECT count(*) FROM %s c WHERE c.%s IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %s p WHERE p.id = c.%s)" % (child, col, parent, col))[0][0]
            if orph != "0":
                bad.append("%s orphan rows in %s.%s" % (orph, child, col))
        for v in ("v_order_totals", "v_customer_orders", "mv_products"):
            try:
                q(DB, "SELECT count(*) FROM %s" % v)
            except Exception as e:
                bad.append("%s: %s" % (v, str(e)[:120]))
        self.assertFalse(bad, "%s broke the schema: %s\n  seed %d - replay with PG_ARCA_FUZZ_SEED=%d\n  history: %s" % (label, bad, SEED, SEED, "; ".join(self.log)))

    def test_group_restores_keep_the_schema_whole(self):
        r = self.rng
        for i in range(4):
            p = r.choice(self.points)
            group = sorted(r.sample(TABLES, r.randint(1, 4)), key=TABLES.index)
            mode = r.choice(["replace", "replace", "missing_only"])
            before = fp()
            stage = "pgarca_stage_fzr%d" % i
            restore_object(F.ctx, DB, objects=["%s.public.%s" % (DB, t) for t in group], target_time=p[0], stage_db=stage)
            try:
                res = promote_object(F.ctx, stage, DB, mode=mode, drop_stage=True)
            except Exception as e:
                # a promotion may REFUSE (e.g. rows of the restored parent would orphan live children): then nothing may have changed
                self.assertEqual(fp(), before, "a refused promotion changed data (%s): %s" % (e, "; ".join(self.log)))
                self._integrity("refused promotion of %s" % group)
                q("postgres", "DROP DATABASE IF EXISTS %s" % stage)
                continue
            after = fp()
            label = "%s of %s at step %d" % (mode, group, p[2])
            for t in TABLES:
                if t in group and mode == "replace" and t in p[1]:
                    self.assertEqual(after.get(t), p[1][t], "%s: %s differs from the instant (seed %d; %s)" % (label, t, SEED, res.get("plan", {}).get("warnings")))
                elif t not in group:
                    self.assertEqual(after.get(t), before.get(t), "%s changed %s (seed %d)" % (label, t, SEED))
            self._integrity(label)


if __name__ == "__main__":
    unittest.main()
