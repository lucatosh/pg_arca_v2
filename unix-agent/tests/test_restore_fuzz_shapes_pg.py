"""Randomised restore of tables whose foreign keys have the shapes real schemas use and the simple fuzz does not:
  - a SELF-referencing table (accounts.parent_id, ON DELETE SET NULL)
  - a COMPOSITE key, DEFERRABLE INITIALLY DEFERRED (stores -> regions (country, code))
  - a PARTITIONED table (sales, by range) referencing a plain one (ON DELETE CASCADE), with a partition added during the workload
  - a foreign key TO the partitioned table, on a quoted column name with a space (refunds."Sale Id", sale_at -> sales (id, at))
  - ON DELETE SET NULL from a plain table (stores.account_id)
A seeded workload changes them; random groups are restored at random instants and promoted (replace / missing_only). After every promotion, or refusal:
  - every foreign key that existed still exists, is VALID, and no row breaks it (checked generically from the catalog, any shape)
  - restored tables equal the instant (replace), the others are untouched; a refused promotion changed nothing
Seeded: PG_ARCA_FUZZ_SEED.   as root: su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_restore_fuzz_shapes_pg -v'
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

DB = "fzshape"
SEED = int(os.environ.get("PG_ARCA_FUZZ_SEED") or random.SystemRandom().randint(1, 10 ** 9))
STEPS = int(os.environ.get("PG_ARCA_FUZZ_STEPS") or 30)
ROUNDS = int(os.environ.get("PG_ARCA_FUZZ_RESTORES") or 4)
TABLES = ["accounts", "regions", "stores", "sales", "refunds"]
KEYS = {"accounts": "id", "regions": "country, code", "stores": "id", "sales": "id, at", "refunds": "id"}
DDL = """
CREATE TABLE accounts (id int PRIMARY KEY, parent_id int REFERENCES accounts(id) ON DELETE SET NULL, name text);
CREATE TABLE regions (country char(2), code int, label text, PRIMARY KEY (country, code));
CREATE TABLE stores (id int PRIMARY KEY, country char(2), region int, account_id int REFERENCES accounts(id) ON DELETE SET NULL, title text,
                     FOREIGN KEY (country, region) REFERENCES regions (country, code) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE sales (id int, at date, store_id int REFERENCES stores(id) ON DELETE CASCADE, amount numeric(12,2), PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE sales_2025 PARTITION OF sales FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE sales_2026 PARTITION OF sales FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE refunds (id int PRIMARY KEY, "Sale Id" int, sale_at date, reason text, FOREIGN KEY ("Sale Id", sale_at) REFERENCES sales (id, at) ON DELETE CASCADE);
"""

FK_SQL = """
SELECT k.conname, k.conrelid::regclass::text, k.confrelid::regclass::text, k.convalidated,
       (SELECT string_agg(quote_ident(a.attname), ',' ORDER BY x.n) FROM unnest(k.conkey) WITH ORDINALITY x(att, n) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.att),
       (SELECT string_agg(quote_ident(a.attname), ',' ORDER BY x.n) FROM unnest(k.confkey) WITH ORDINALITY x(att, n) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.att)
FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE k.contype = 'f' AND k.conparentid = 0 AND n.nspname = 'public' AND c.relname NOT LIKE '%%\\_old\\_%%' AND c.relname NOT LIKE '%%\\_pitr\\_%%'
ORDER BY 1"""


def fp(db=DB):
    out = {}
    for t in TABLES:
        if q(db, "SELECT to_regclass('public.%s') IS NOT NULL" % t)[0][0] == "t":
            out[t] = q(db, "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY %s), '')) || ':' || count(*) FROM %s x" % (KEYS[t], t))[0][0]
    return out


def fks(db=DB):
    """(child, parent, child cols, parent cols) -> validated, for every top-level foreign key of the public tables (partition clones excluded)"""
    return {(r[1], r[2], r[4], r[5]): r[3] for r in q(db, FK_SQL)}


class FuzzShapes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base.setUpModule()
        cls.rng = random.Random(SEED)
        cls.log, cls.points, cls.nid = [], [], 0
        sys.stderr.write("\n[fuzz-shapes] seed=%d steps=%d (replay: PG_ARCA_FUZZ_SEED=%d)\n" % (SEED, STEPS, SEED))
        q("postgres", "CREATE DATABASE %s" % DB)
        q(DB, DDL)
        cls._fill(cls)
        cls.fk0 = fks()
        assert len(cls.fk0) == 5, cls.fk0
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
        a = self._next(self, 20)
        q(DB, "INSERT INTO accounts SELECT %d + g, NULL, 'a' || g FROM generate_series(0, 19) g; UPDATE accounts SET parent_id = id - 1 WHERE id > %d AND id %% 3 <> 0" % (a, a))
        q(DB, "INSERT INTO regions SELECT c, g, c || g FROM unnest(ARRAY['IT','CH','DE']) c, generate_series(1, 4) g")
        self._stores(self, 12)
        self._sales(self, 60)

    def _stores(self, n):
        s = self._next(self, n)
        q(DB, "INSERT INTO stores SELECT %d + g, r.country, r.code, (SELECT id FROM accounts ORDER BY random() LIMIT 1), 's' || g "
              "FROM generate_series(0, %d) g CROSS JOIN LATERAL (SELECT country, code FROM regions WHERE g >= 0 ORDER BY random() LIMIT 1) r" % (s, n - 1))

    def _sales(self, n):
        s = self._next(self, n)
        q(DB, "INSERT INTO sales SELECT %d + g, DATE '2025-03-01' + ((g * 37) %% 600), (SELECT id FROM stores WHERE g >= 0 ORDER BY random() LIMIT 1), (g %% 90) + 0.5 "
              "FROM generate_series(0, %d) g WHERE EXISTS (SELECT 1 FROM stores)" % (s, n - 1))
        r = self._next(self, n // 3 + 1)
        q(DB, "INSERT INTO refunds SELECT %d + row_number() OVER (), id, at, 'r' FROM (SELECT id, at FROM sales ORDER BY random() LIMIT %d) x" % (r - 1, n // 3 + 1))

    def _step(self, step):
        r = self.rng
        act = r.choices(["stores", "sales", "update", "reparent", "delete_account", "delete_store", "delete_region", "delete_sales_2025", "add_partition",
                         "truncate_refunds", "switch", "incr", "full"], weights=[8, 18, 12, 6, 5, 5, 3, 2, 1, 2, 6, 6, 2])[0]
        if act == "stores":
            self._stores(self, r.randint(1, 4))
        elif act == "sales":
            self._sales(self, r.randint(3, 30))
        elif act == "update":
            q(DB, "UPDATE %s" % r.choice(["accounts SET name = name || '+' WHERE id % 4 = 0", "stores SET title = 'renamed' WHERE id % 3 = 0",
                                          "sales SET amount = amount + 1 WHERE id % 5 = 0", "regions SET label = 'L' || code WHERE code % 2 = 0",
                                          "refunds SET reason = 'changed' WHERE id % 2 = 0"]))
        elif act == "reparent":
            q(DB, "UPDATE accounts SET parent_id = (SELECT id FROM accounts a2 WHERE a2.id < accounts.id ORDER BY random() LIMIT 1) WHERE id % 5 = 1")
        elif act == "delete_account":
            q(DB, "DELETE FROM accounts WHERE id = (SELECT min(id) FROM accounts)")                      # children and stores keep their row, the link becomes NULL
        elif act == "delete_store":
            q(DB, "DELETE FROM stores WHERE id = (SELECT id FROM stores ORDER BY random() LIMIT 1)")       # cascades to sales and their refunds
        elif act == "delete_region":
            # the deferred composite key is checked at COMMIT: stores move to IT-1 (never deleted) in the same transaction that deletes their region
            c, n = r.choice(["IT", "CH", "DE"]), r.randint(2, 4)
            q(DB, "BEGIN; DELETE FROM regions WHERE (country, code) = ('%s', %d); UPDATE stores SET country = 'IT', region = 1 WHERE (country, region) = ('%s', %d); COMMIT" % (c, n, c, n))
        elif act == "delete_sales_2025":
            q(DB, "DELETE FROM sales WHERE at < '2025-07-01'")
        elif act == "add_partition":
            if q(DB, "SELECT to_regclass('public.sales_2027') IS NULL")[0][0] == "t":
                q(DB, "CREATE TABLE sales_2027 PARTITION OF sales FOR VALUES FROM ('2027-01-01') TO ('2028-01-01')")
            s = self._next(self, 5)
            q(DB, "INSERT INTO sales SELECT %d + g, DATE '2027-02-01' + g, (SELECT min(id) FROM stores), 1 FROM generate_series(0, 4) g WHERE EXISTS (SELECT 1 FROM stores)" % s)
        elif act == "truncate_refunds":
            q(DB, "TRUNCATE refunds")
        elif act == "switch":
            q("postgres", "SELECT pg_switch_wal()")
        else:
            run_backup(F.ctx, act)
        self.log.append("%d %s" % (step, act))

    def _integrity(self, label):
        bad = []
        now = fks()
        for k, valid in self.fk0.items():
            if k not in now:
                bad.append("FK %s -> %s (%s) is gone" % (k[0], k[1], k[2]))
        for (child, parent, cc, pc), valid in now.items():
            if valid != "t":
                bad.append("FK %s -> %s (%s) is NOT VALID" % (child, parent, cc))
            ccs, pcs = cc.split(","), pc.split(",")
            n = q(DB, "SELECT count(*) FROM %s c WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)" % (
                child, " AND ".join("c.%s IS NOT NULL" % x for x in ccs), parent, " AND ".join("p.%s = c.%s" % (b, a) for a, b in zip(ccs, pcs))))[0][0]
            if n != "0":
                bad.append("%s orphan rows in %s (%s) -> %s" % (n, child, cc, parent))
        self.assertFalse(bad, "%s broke the schema: %s\n  seed %d - replay with PG_ARCA_FUZZ_SEED=%d\n  history: %s" % (label, bad, SEED, SEED, "; ".join(self.log)))

    def test_group_restores_keep_every_key_shape_whole(self):
        r = self.rng
        refused = 0
        for i in range(ROUNDS):
            p = r.choice(self.points)
            group = sorted(r.sample(TABLES, r.randint(1, len(TABLES))), key=TABLES.index)
            mode = r.choice(["replace", "replace", "missing_only"])
            before = fp()
            stage = "pgarca_stage_fzs%d" % i
            restore_object(F.ctx, DB, objects=["%s.public.%s" % (DB, t) for t in group], target_time=p[0], stage_db=stage)
            label = "%s of %s at step %d" % (mode, group, p[2])
            try:
                res = promote_object(F.ctx, stage, DB, mode=mode, drop_stage=True)
            except Exception as e:
                refused += 1
                self.assertIn("PGA-GEN-096", str(e), "%s: refused for another reason (seed %d): %s\n  history: %s" % (label, SEED, e, "; ".join(self.log)))
                self.assertEqual(fp(), before, "a refused promotion changed data (%s): %s" % (e, "; ".join(self.log)))
                self._integrity("refused " + label)
                q("postgres", "DROP DATABASE IF EXISTS %s" % stage)
                continue
            after = fp()
            for t in TABLES:
                if t in group and mode == "replace" and t in p[1]:
                    self.assertEqual(after.get(t), p[1][t], "%s: %s differs from the instant (seed %d; %s)" % (label, t, SEED, res.get("plan", {}).get("warnings")))
                elif t not in group:
                    self.assertEqual(after.get(t), before.get(t), "%s changed %s (seed %d)" % (label, t, SEED))
            self._integrity(label)
        sys.stderr.write("[fuzz-shapes] seed=%d: %d promotions, %d refused for orphans\n" % (SEED, ROUNDS, refused))


if __name__ == "__main__":
    unittest.main()
