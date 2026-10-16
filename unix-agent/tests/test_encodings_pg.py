"""Databases not encoded in UTF-8 (independent review, 16/10): psql over pipes speaks the database's encoding, read as UTF-8 the first accented
letter raised UnicodeDecodeError. Table restore, row comparison and row recovery on a LATIN1 and a SQL_ASCII database, plus a database restore.
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_encodings_pg'"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests import test_engine_pg as T
from tests.test_engine_pg import F, q
from pg_arca.engine.backup import run_backup
from pg_arca.engine.granular import restore_object, restore_database, diff_object, apply_rows

S = {}
WORDS = "caffè, perché, Größe, naïve"


def now_txt():
    return q("postgres", "SELECT to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")[0][0]


def setUpModule():
    T.setUpModule()
    for db, enc in (("lat1", "LATIN1"), ("sqlascii", "SQL_ASCII")):
        q("postgres", "CREATE DATABASE %s TEMPLATE template0 ENCODING '%s' LC_COLLATE 'C' LC_CTYPE 'C'" % (db, enc))
        q(db, "CREATE TABLE menu(id int PRIMARY KEY, label text); COMMENT ON TABLE menu IS 'piatti del giorno: %s';"
              "CREATE TYPE mood AS ENUM ('felicità', 'tristezza'); CREATE VIEW v_menu AS SELECT id, label || ' è buono' AS t FROM menu" % WORDS)
        q(db, "INSERT INTO menu SELECT g, 'piatto n° ' || g || ' - %s' FROM generate_series(1, 50) g" % WORDS)
    run_backup(F.ctx, "full")
    time.sleep(1.2)
    S["t0"] = now_txt()
    time.sleep(1.2)
    for db in ("lat1", "sqlascii"):
        q(db, "DELETE FROM menu WHERE id > 40; UPDATE menu SET label = 'cambiato à' WHERE id = 1")
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(3)


def tearDownModule():
    T.tearDownModule()


class Encodings(unittest.TestCase):
    def check(self, db):
        stage = "pgarca_stage_enc_" + db
        restore_object(F.ctx, db, objects=["%s.public.menu" % db], target_time=S["t0"], stage_db=stage)
        d = diff_object(F.ctx, stage, "%s.public.menu" % db)
        self.assertEqual(d["counts"], {"missing_now": 10, "added_since": 0, "changed": 1})
        self.assertIn("caffè", d["missing_now"][0]["restored"]["label"])
        apply_rows(F.ctx, stage, "%s.public.menu" % db, restore_all=["missing", "changed"])
        self.assertEqual(q(db, "SELECT count(*), count(*) FILTER (WHERE label LIKE '%%Größe%%') FROM menu")[0], ["50", "50"])

    def test_01_latin1(self):
        self.check("lat1")

    def test_02_sql_ascii(self):
        self.check("sqlascii")

    def test_03_database_restore(self):
        r = restore_database(F.ctx, "lat1", target_time=S["t0"], new_name="lat1_back")
        self.assertEqual(q("lat1_back", "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database()")[0][0], "LATIN1", r)
        self.assertEqual(q("lat1_back", "SELECT count(*) FROM menu WHERE label LIKE '%naïve%'")[0][0], "50")
        self.assertIn("caffè", q("lat1_back", "SELECT obj_description('menu'::regclass, 'pg_class')")[0][0])


if __name__ == "__main__":
    unittest.main()
