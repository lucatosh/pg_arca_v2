"""Randomised, reproducible restore torture test: what a hand-written case does not think of.

A seeded generator runs a random workload on a database with varied tables (types, partitions, foreign keys, TOAST, sequences): inserts, updates,
deletes, TRUNCATE, ALTER TABLE, DROP + re-CREATE, VACUUM FULL, index builds, WAL switches, and backups (full / incr / diff) at random moments. After
every step it records a fingerprint of every table (md5 over the rows in key order) and the instant. Then it restores at random recorded instants:
  - the whole database (restore_database) -> every table must match the fingerprint of that instant (tables that did not exist must not exist)
  - one table (restore_object into quarantine) -> that table must match
Any mismatch prints the seed and the step log: the same seed replays the same history.

  PG_ARCA_FUZZ_SEED=<n> (default: random)  PG_ARCA_FUZZ_STEPS (default 30)  PG_ARCA_FUZZ_RESTORES (default 6)
  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_restore_fuzz_pg -v'
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
from pg_arca.engine.granular import restore_database, restore_object

DB = "fz"
SEED = int(os.environ.get("PG_ARCA_FUZZ_SEED") or random.SystemRandom().randint(1, 10 ** 9))
STEPS = int(os.environ.get("PG_ARCA_FUZZ_STEPS") or 30)
RESTORES = int(os.environ.get("PG_ARCA_FUZZ_RESTORES") or 6)

KINDS = [
    ("plain", "CREATE TABLE {t} (id bigint PRIMARY KEY, a int, b text, c numeric(12,2), d timestamptz, e jsonb, f bytea, g int[])"),
    ("toast", "CREATE TABLE {t} (id bigint PRIMARY KEY, big text, doc jsonb)"),
    ("part", "CREATE TABLE {t} (id bigint, k int NOT NULL, v text, PRIMARY KEY (id, k)) PARTITION BY RANGE (k);"
             "CREATE TABLE {t}_p0 PARTITION OF {t} FOR VALUES FROM (0) TO (50); CREATE TABLE {t}_p1 PARTITION OF {t} FOR VALUES FROM (50) TO (100)"),
    ("serial", "CREATE TABLE {t} (id bigserial PRIMARY KEY, v text, ts timestamptz DEFAULT clock_timestamp())"),
]


def fingerprint():
    """{table: md5 | None}: every user table of the database, rows in primary-key order."""
    out = {}
    tabs = q(DB, "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') "
                 "AND NOT c.relispartition ORDER BY 1")
    for (t,) in tabs:
        out[t] = q(DB, "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) || ':' || count(*) FROM %s x" % t)[0][0]
    return out


def fingerprint_in(db):
    tabs = q(db, "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') "
                 "AND NOT c.relispartition ORDER BY 1")
    return {t: q(db, "SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) || ':' || count(*) FROM %s x" % t)[0][0] for (t,) in tabs}


class Fuzz(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base.setUpModule()
        cls.rng = random.Random(SEED)
        cls.log = []
        cls.points = []                                   # (instant, fingerprint, step)
        cls.tables = {}                                   # name -> kind
        cls.nid = 0
        sys.stderr.write("\n[fuzz] seed=%d steps=%d restores=%d  (replay: PG_ARCA_FUZZ_SEED=%d)\n" % (SEED, STEPS, RESTORES, SEED))
        q("postgres", "CREATE DATABASE %s" % DB)
        for i in range(4):
            cls._create(cls)
        run_backup(F.ctx, "full")
        cls.log.append("full backup")
        for step in range(STEPS):
            cls._step(cls, step)
            time.sleep(0.6)
            now = q("postgres", "SELECT to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]
            cls.points.append((now, fingerprint(), step))
            time.sleep(0.6)
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)

    @classmethod
    def tearDownClass(cls):
        base.tearDownModule()

    def _create(self):
        kind, ddl = self.rng.choice(KINDS)
        self.nid += 1
        t = "t%d_%s" % (self.nid, kind)
        q(DB, ddl.format(t=t))
        self.tables[t] = kind
        self._insert(self, t, self.rng.randint(5, 60))
        self.log.append("create %s" % t)

    def _insert(self, t, n):
        kind = self.tables[t]
        base_id = int(q(DB, "SELECT coalesce(max(id), 0) FROM %s" % t)[0][0]) if kind != "serial" else 0
        if kind == "plain":
            q(DB, "INSERT INTO %s SELECT %d + g, (random()*1000)::int, md5(g::text), round((random()*1e6)::numeric, 2), clock_timestamp(), "
                  "jsonb_build_object('g', g, 'r', random()), decode(md5(g::text), 'hex'), ARRAY[g, g * 2] FROM generate_series(1, %d) g" % (t, base_id, n))
        elif kind == "toast":
            q(DB, "INSERT INTO %s SELECT %d + g, repeat(md5(random()::text), 400), jsonb_build_object('pad', repeat('x', 3000)) FROM generate_series(1, %d) g" % (t, base_id, n))
        elif kind == "part":
            q(DB, "INSERT INTO %s SELECT %d + g, (g * 7) %% 100, md5(g::text) FROM generate_series(1, %d) g" % (t, base_id, n))
        else:
            q(DB, "INSERT INTO %s (v) SELECT md5(g::text) FROM generate_series(1, %d) g" % (t, n))

    def _step(self, step):
        r = self.rng
        live = list(self.tables)
        t = r.choice(live) if live else None
        act = r.choices(["insert", "update", "delete", "truncate", "alter", "drop", "create", "vacuum_full", "index", "switch", "full", "incr", "diff"],
                        weights=[18, 14, 10, 3, 4, 3, 4, 3, 3, 6, 2, 6, 2])[0]
        if act in ("drop", "truncate", "alter") and len(live) < 2:
            act = "insert"
        if act == "insert":
            self._insert(self, t, r.randint(1, 80))
        elif act == "update":
            col = {"plain": "b = md5(random()::text), a = a + 1", "toast": "big = repeat(md5(random()::text), 300)", "part": "v = md5(random()::text)",
                   "serial": "v = md5(random()::text)"}[self.tables[t]]
            q(DB, "UPDATE %s SET %s WHERE id %% %d = 0" % (t, col, r.randint(2, 5)))
        elif act == "delete":
            q(DB, "DELETE FROM %s WHERE id %% %d = %d" % (t, r.randint(3, 7), r.randint(0, 2)))
        elif act == "truncate":
            q(DB, "TRUNCATE %s" % t)
        elif act == "alter":
            q(DB, "ALTER TABLE %s ADD COLUMN x%d int DEFAULT %d" % (t, step, step))
        elif act == "drop":
            q(DB, "DROP TABLE %s CASCADE" % t)
            del self.tables[t]
        elif act == "create":
            self._create(self)
        elif act == "vacuum_full":
            q(DB, "VACUUM FULL %s" % t)
        elif act == "index":
            q(DB, "CREATE INDEX ON %s ((id %% 10))" % t)
        elif act == "switch":
            q("postgres", "SELECT pg_switch_wal()")
        else:
            run_backup(F.ctx, act)
        self.log.append("%d %s %s" % (step, act, t or ""))

    def _explain(self, what, want, got, point):
        return "%s at step %d (%s) differs.\n  expected %s\n  got      %s\n  seed %d - replay with PG_ARCA_FUZZ_SEED=%d\n  history:\n    %s" % (
            what, point[2], point[0], want, got, SEED, SEED, "\n    ".join(self.log))

    def test_database_restores_match_every_recorded_instant(self):
        pts = self.rng.sample(self.points, min(RESTORES, len(self.points)))
        for i, p in enumerate(sorted(pts, key=lambda x: x[2])):
            name = "fz_r%d" % i
            restore_database(F.ctx, DB, target_time=p[0], new_name=name)
            got = fingerprint_in(name)
            self.assertEqual(got, p[1], self._explain("database restore", p[1], got, p))
            q("postgres", "DROP DATABASE %s" % name)

    def test_table_restores_match(self):
        cands = [(p, t) for p in self.points for t in p[1]]
        for i, (p, t) in enumerate(self.rng.sample(cands, min(RESTORES, len(cands)))):
            stage = "pgarca_stage_fz%d" % i
            restore_object(F.ctx, DB, objects=["%s.public.%s" % (DB, t)], target_time=p[0], stage_db=stage)
            got = fingerprint_in(stage).get(t)
            self.assertEqual(got, p[1][t], self._explain("table %s restore" % t, p[1][t], got, p))
            q("postgres", "DROP DATABASE %s" % stage)


if __name__ == "__main__":
    unittest.main()
