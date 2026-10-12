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
        have = {c for (c,) in q(DB, "SELECT attname FROM pg_attribute WHERE attrelid = '%s'::regclass AND attnum > 0 AND NOT attisdropped" % t)}
        base_id = int(float(q(DB, "SELECT coalesce(max(id), 0) FROM %s" % t)[0][0])) if kind != "serial" else 0
        exprs = {"plain": [("id", "%d + g" % base_id), ("a", "(random()*1000)::int"), ("b", "md5(g::text)"), ("c", "round((random()*1e6)::numeric, 2)"),
                           ("d", "clock_timestamp()"), ("e", "jsonb_build_object('g', g, 'r', random())"), ("f", "decode(md5(g::text), 'hex')"), ("g", "ARRAY[g, g * 2]")],
                 "toast": [("id", "%d + g" % base_id), ("big", "repeat(md5(random()::text), 400)"), ("doc", "jsonb_build_object('pad', repeat('x', 3000))")],
                 "part": [("id", "%d + g" % base_id), ("k", "(g * 7) % 100"), ("v", "md5(g::text)")],
                 "serial": [("v", "md5(g::text)")]}[kind]
        cols = [(c, e) for c, e in exprs if c in have]
        if not cols:                                      # only the serial key is left: rows made of defaults
            cols = [("id", "nextval(pg_get_serial_sequence('%s', 'id'))" % t)]
        q(DB, "INSERT INTO %s (%s) SELECT %s FROM generate_series(1, %d) g" % (t, ", ".join(c for c, _ in cols), ", ".join(e for _, e in cols), n))

    def _step(self, step):
        r = self.rng
        live = list(self.tables)
        t = r.choice(live) if live else None
        act = r.choices(["insert", "update", "delete", "truncate", "alter", "drop", "create", "vacuum_full", "index", "switch", "full", "incr", "diff",
                         "alter_type", "drop_column", "rename", "incr_under_load", "big_txn", "checkpoint", "expire"],
                        weights=[18, 14, 10, 3, 4, 3, 4, 3, 3, 6, 2, 6, 2, 2, 2, 2, 4, 2, 2, 2])[0]
        if act in ("drop", "truncate", "alter", "alter_type", "drop_column", "rename") and len(live) < 2:
            act = "insert"
        if act == "insert":
            self._insert(self, t, r.randint(1, 80))
        elif act == "update":
            have = {c for (c,) in q(DB, "SELECT attname FROM pg_attribute WHERE attrelid = '%s'::regclass AND attnum > 0 AND NOT attisdropped" % t)}
            sets = [x for c, x in (("b", "b = md5(random()::text)"), ("a", "a = a + 1"), ("big", "big = repeat(md5(random()::text), 300)"), ("v", "v = md5(random()::text)"))
                    if c in have] or ["id = id"]
            q(DB, "UPDATE %s SET %s WHERE id::bigint %% %d = 0" % (t, ", ".join(sets), r.randint(2, 5)))
        elif act == "delete":
            q(DB, "DELETE FROM %s WHERE id::bigint %% %d = %d" % (t, r.randint(3, 7), r.randint(0, 2)))
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
            q(DB, "CREATE INDEX ON %s ((id::bigint %% 10))" % t)
        elif act == "switch":
            q("postgres", "SELECT pg_switch_wal()")
        elif act == "checkpoint":
            q("postgres", "CHECKPOINT")
        elif act == "expire":                             # retention: whatever it deletes, every instant after the oldest kept full must stay restorable
            from pg_arca.engine.maintenance import expire
            keep = r.randint(1, 3)
            res = expire(F.ctx, retention_full=keep)
            fulls = [m for m in F.ctx.repo.complete_sets() if m["type"] == "full"]
            if fulls:
                self.floor = max(getattr(self, "floor", ""), fulls[0].get("stop_time") or "")
            self.log.append("   expire keep=%d deleted %s" % (keep, res.get("delete_sets")))
        elif act == "alter_type":                         # a table rewrite (new relfilenode) under the same name
            col = {"plain": "a", "part": "k", "serial": "id", "toast": "id"}[self.tables[t]]
            if self.tables[t] == "part":
                q(DB, "ALTER TABLE %s ALTER COLUMN v TYPE varchar(100)" % t)
            elif col == "a":
                q(DB, "ALTER TABLE %s ALTER COLUMN a TYPE bigint" % t)
            else:
                q(DB, "ALTER TABLE %s ALTER COLUMN id TYPE numeric(20,0)" % t)
        elif act == "drop_column":
            cols = [c for (c,) in q(DB, "SELECT attname FROM pg_attribute WHERE attrelid = '%s'::regclass AND attnum > 1 AND NOT attisdropped "
                                         "AND attname NOT IN ('k')" % t)]
            if cols:
                q(DB, "ALTER TABLE %s DROP COLUMN %s" % (t, r.choice(cols)))
        elif act == "rename":
            n = "%s_r%d" % (t.split("_r")[0], step)
            q(DB, "ALTER TABLE %s RENAME TO %s" % (t, n))
            self.tables[n] = self.tables.pop(t)
            t = n
        elif act == "big_txn":                            # one transaction with many changes across tables (spans WAL segments)
            others = r.sample(live, min(3, len(live)))
            sql = ["BEGIN"]
            for o in others:
                sql.append("DELETE FROM %s WHERE id::bigint %% 4 = 1" % o)
            sql.append("COMMIT")
            q(DB, "; ".join(sql))
            for o in others:
                self._insert(self, o, r.randint(20, 120))
        elif act == "incr_under_load":                    # a backup while another session writes: the backup must still restore exactly
            import threading
            stop = threading.Event()

            def load():
                while not stop.is_set():
                    try:
                        self._insert(self, t, 5)
                    except Exception:
                        pass
                    time.sleep(0.05)
            th = threading.Thread(target=load)
            th.start()
            try:
                run_backup(F.ctx, r.choice(["incr", "diff", "full"]))
            finally:
                stop.set()
                th.join()
        else:
            run_backup(F.ctx, act)
        self.log.append("%d %s %s" % (step, act, t or ""))

    def _explain(self, what, want, got, point):
        return "%s at step %d (%s) differs.\n  expected %s\n  got      %s\n  seed %d - replay with PG_ARCA_FUZZ_SEED=%d\n  history:\n    %s" % (
            what, point[2], point[0], want, got, SEED, SEED, "\n    ".join(self.log))

    def _restorable(self):
        """Instants still covered after retention: after the end of the oldest full that was kept."""
        fl = getattr(self, "floor", "")
        if not fl:
            return list(self.points)
        from pg_arca.engine.util import target_time_to_dt
        f = target_time_to_dt(fl.replace("T", " ") if "+" in fl or "Z" in fl else fl + "+00")
        return [p for p in self.points if f is None or target_time_to_dt(p[0]) > f]

    def test_database_restores_match_every_recorded_instant(self):
        pts = self.rng.sample(self._restorable(), min(RESTORES, len(self._restorable())))
        for i, p in enumerate(sorted(pts, key=lambda x: x[2])):
            name = "fz_r%d" % i
            restore_database(F.ctx, DB, target_time=p[0], new_name=name)
            got = fingerprint_in(name)
            self.assertEqual(got, p[1], self._explain("database restore", p[1], got, p))
            q("postgres", "DROP DATABASE %s" % name)

    def test_table_restores_match(self):
        cands = [(p, t) for p in self._restorable() for t in p[1]]
        for i, (p, t) in enumerate(self.rng.sample(cands, min(RESTORES, len(cands)))):
            stage = "pgarca_stage_fz%d" % i
            restore_object(F.ctx, DB, objects=["%s.public.%s" % (DB, t)], target_time=p[0], stage_db=stage)
            got = fingerprint_in(stage).get(t)
            self.assertEqual(got, p[1][t], self._explain("table %s restore" % t, p[1][t], got, p))
            q("postgres", "DROP DATABASE %s" % stage)

    def test_instance_restore_matches(self):
        """The whole cluster at one recorded instant: started as a copy, every table compared."""
        import shutil
        from pg_arca.engine.restore import restore_instance
        from pg_arca.engine.pgsession import PgConn, PgSession
        from tests.test_engine_pg import BIN, sh
        p = self.rng.choice(self._restorable())
        dest = os.path.join(F.base, "fz_inst")
        restore_instance(F.ctx, dest=dest, target_time=p[0], action="promote")
        port = F.port + 21
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-o", "-p %d -k %s" % (port, F.sock), "-l", dest + ".log", "-w", "-t", "180", "start")
        self.assertEqual(r.returncode, 0, open(dest + ".log").read()[-1500:])
        try:
            s = PgSession(PgConn(host=F.sock, port=port, user="postgres", bindir=BIN).with_db(DB))
            for _ in range(120):
                if s.scalar("SELECT pg_is_in_recovery()") == "f":
                    break
                time.sleep(1)
            got = {}
            for (t,) in s.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') "
                                "AND NOT c.relispartition ORDER BY 1"):
                got[t] = s.scalar("SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) || ':' || count(*) FROM %s x" % t)
            s.close()
            self.assertEqual(got, p[1], self._explain("instance restore", p[1], got, p))
        finally:
            sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")
            shutil.rmtree(dest, ignore_errors=True)

    def test_zz_replace_promotions(self):
        """Put a table back from a recorded instant with mode replace: that table equals the instant, every other table is unchanged, the old one is kept."""
        from pg_arca.engine.granular import promote_object
        now = fingerprint()
        cands = [(p, t) for p in self._restorable() for t in p[1] if t in now]
        for i, (p, t) in enumerate(self.rng.sample(cands, min(3, len(cands)))):
            before = fingerprint()
            stage = "pgarca_stage_fzp%d" % i
            restore_object(F.ctx, DB, objects=["%s.public.%s" % (DB, t)], target_time=p[0], stage_db=stage)
            r = promote_object(F.ctx, stage, DB, mode="replace", drop_stage=True)
            after = fingerprint()
            olds = [k for k in after if k.startswith(t[:40]) and "_old_" in k]
            self.assertEqual(after.get(t), p[1][t], self._explain("replace of %s" % t, p[1][t], after.get(t), p))
            self.assertTrue(olds, "the replaced table is kept as _old_: %s" % sorted(after))
            self.assertEqual(after[olds[-1]], before[t], "the kept copy holds the rows it had")
            for k, v in before.items():
                if k != t:
                    self.assertEqual(after.get(k), v, "replacing %s changed %s (seed %d)" % (t, k, SEED))
            self.assertTrue(r)


if __name__ == "__main__":
    unittest.main()
