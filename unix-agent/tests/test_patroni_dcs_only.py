"""Under Patroni, parameters and pg_hba change ONLY through the DCS (the call behind `patronictl edit-config`): never postgresql.conf / ALTER SYSTEM /
pg_hba.conf / patroni.yml, and never as a "fallback" when the Patroni API is unreachable."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca import hba_ops
from pg_arca.executor import OperationExecutor, OpError


class FakePatroni(object):
    configured = True

    def __init__(self, up=True, config=None):
        self.up, self.config, self.patches = up, config if config is not None else {"postgresql": {"parameters": {}}}, []

    def get_node_status(self):
        return (200, {"state": "running"}) if self.up else (0, {"error": "connection refused"})

    def get_config(self):
        return 200, self.config

    def patch_config(self, patch):
        self.patches.append(patch)
        pg = patch.get("postgresql") or {}
        for k, v in (pg.get("parameters") or {}).items():
            self.config.setdefault("postgresql", {}).setdefault("parameters", {})[k] = v
        if "pg_hba" in pg:
            self.config.setdefault("postgresql", {})["pg_hba"] = pg["pg_hba"]
        return 200, self.config


class FakeDb(object):
    def __init__(self, hba_file):
        self.hba_file, self.alter_calls = hba_file, []

    def alter_system(self, name, value):
        self.alter_calls.append((name, value))
        return {}

    def run_psql(self, sql, **kw):
        return True, self.hba_file, ""

    def query_json(self, sql, **kw):
        return {"setting": "100", "context": "sighup"}, ""


def make(up=True, config=None):
    d = tempfile.mkdtemp(prefix="arca_dcs_")
    hf = os.path.join(d, "pg_hba.conf")
    open(hf, "w").write("local all postgres peer\nhost replication replicator 10.0.0.0/8 scram-sha-256\n")
    db, pat = FakeDb(hf), FakePatroni(up, config)
    ex = OperationExecutor({"state_dir": d}, db, pat, None, None)
    ex._require_pg = lambda: None
    return ex, db, pat, hf


class DcsOnly(unittest.TestCase):
    def test_param_goes_to_the_dcs_not_alter_system(self):
        ex, db, pat, _ = make()
        r = ex.h_set_param({"name": "work_mem", "value": "8MB"})
        self.assertEqual(r["via"], "patroni")
        self.assertEqual(pat.patches, [{"postgresql": {"parameters": {"work_mem": "8MB"}}}])
        self.assertEqual(db.alter_calls, [])

    def test_param_is_refused_when_patroni_is_unreachable(self):
        ex, db, pat, _ = make(up=False)
        with self.assertRaises(OpError) as cm:
            ex.h_set_param({"name": "work_mem", "value": "8MB"})
        self.assertIn("patronictl edit-config", str(cm.exception))
        self.assertEqual(db.alter_calls, [])
        self.assertEqual(pat.patches, [])

    def test_hba_unreachable_patroni_never_touches_the_file(self):
        ex, db, pat, hf = make(up=False)
        before = open(hf).read()
        with self.assertRaises(Exception) as cm:
            hba_ops._Src(ex, lambda m: Exception(m))
        self.assertIn("edit-config", str(cm.exception))
        self.assertEqual(open(hf).read(), before)

    def test_hba_without_dcs_list_is_seeded_from_the_rules_in_force(self):
        ex, db, pat, hf = make()
        src = hba_ops._Src(ex, lambda m: Exception(m))
        self.assertTrue(src.patroni and src.seed)
        self.assertEqual(src.text(), open(hf).read())              # nothing lost: the DCS list starts as the current file
        lst = src.text().rstrip("\n").split("\n")
        ex.patroni.patch_config({"postgresql": {"pg_hba": lst}})   # what _apply_patroni does
        src2 = hba_ops._Src(ex, lambda m: Exception(m))
        self.assertTrue(src2.patroni and not src2.seed)
        self.assertEqual(src2.dcs_list, lst)

    def test_hba_with_dcs_list_uses_it(self):
        ex, db, pat, hf = make(config={"postgresql": {"pg_hba": ["local all all peer"]}})
        src = hba_ops._Src(ex, lambda m: Exception(m))
        self.assertTrue(src.patroni and not src.seed)
        self.assertEqual(src.text(), "local all all peer\n")


if __name__ == "__main__":
    unittest.main()
