"""pg_hba operations against a REAL PostgreSQL (read, plan/simulate, apply + verify, idempotence, lock-out refusal, rollback, Patroni mode).
Run as a non-root user:  su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_hba_pg'"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.test_engine_pg import BIN, SKIP, sh
from pg_arca import hba
from pg_arca.db_client import PostgresClient
from pg_arca.executor import OperationExecutor, OpError

R = lambda **k: dict(dict(type="hostssl", database="all", user="app", address="10.0.20.0/24", method="scram-sha-256", options="", comment=""), **k)


class NoPatroni(object):
    configured = False


class FakePatroni(object):
    """Stands in for Patroni: holds the DCS config and rewrites pg_hba.conf from it, as Patroni does on its next cycle."""
    configured = True

    def __init__(self, hba_path, lst):
        self.hba_path, self.cfg = hba_path, {"postgresql": {"pg_hba": lst}}
        self.write()

    def write(self):
        with open(self.hba_path, "w") as f:
            f.write("\n".join(self.cfg["postgresql"]["pg_hba"]) + "\n")

    def get_node_status(self): return 200, {"state": "running"}
    def get_config(self): return 200, self.cfg

    def patch_config(self, patch):
        self.cfg["postgresql"].update(patch["postgresql"]); self.write(); return 200, self.cfg


@unittest.skipIf(SKIP, SKIP or "")
class HbaPg(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.mkdtemp(prefix="pgarca-hba-")
        cls.sock = os.path.join(cls.base, "s"); os.makedirs(cls.sock)
        cls.data = os.path.join(cls.base, "d"); cls.port = 56000 + os.getpid() % 900
        assert sh(os.path.join(BIN, "initdb"), "-D", cls.data, "-U", "postgres", "--auth=trust").returncode == 0
        with open(os.path.join(cls.data, "postgresql.conf"), "a") as f:
            f.write("\nport=%d\nunix_socket_directories='%s'\nlisten_addresses=''\n" % (cls.port, cls.sock))
        assert sh(os.path.join(BIN, "pg_ctl"), "-D", cls.data, "-l", os.path.join(cls.base, "log"), "-w", "start").returncode == 0
        cls.db = PostgresClient(user="postgres", port=cls.port, socket_dir=cls.sock, psql_path=os.path.join(BIN, "psql"))
        cls.hba = os.path.join(cls.data, "pg_hba.conf")
        with open(cls.hba, "w") as f:
            f.write("local all postgres trust\nlocal all all trust\nhost replication repl 10.0.2.0/24 scram-sha-256\nhost all all 0.0.0.0/0 scram-sha-256\n")
        cls.db.run_psql("SELECT pg_reload_conf();")

    @classmethod
    def tearDownClass(cls):
        sh(os.path.join(BIN, "pg_ctl"), "-D", cls.data, "-m", "immediate", "stop")
        shutil.rmtree(cls.base, ignore_errors=True)

    def ex(self, patroni=None):
        return OperationExecutor({"state_dir": os.path.join(self.base, "state")}, self.db, patroni or NoPatroni(), None, None)

    def test_1_read_sees_real_file(self):
        r = self.ex().h_hba_read({})
        self.assertEqual(r["hba_file"], self.hba); self.assertEqual(r["mode"], "file"); self.assertFalse(r["managed"]["present"])
        self.assertEqual(len(r["effective"]), 4); self.assertEqual(r["errors"], []); self.assertIn("postgres", r["suggest"]["databases"])

    def test_2_apply_verify_idempotent_rollback(self):
        ex = self.ex(); rules = [R(comment="Rete applicativa"), R(database="billing", user="+dba", address="10.0.10.0/24", comment="DBA")]
        base = ex.h_hba_read({})["rev"]
        pl = ex.h_hba_plan({"rules": rules}); self.assertTrue(pl["valid"]); self.assertTrue(pl["changed"]); self.assertEqual(pl["would_lock_out"], []); self.assertTrue(any("scram" in d for d in pl["diff"]))
        res = ex.h_hba_apply({"rules": rules, "base_rev": pl["base_rev"]}); self.assertTrue(res["changed"]); self.assertTrue(res["backup"])
        eff = ex.h_hba_read({}); self.assertEqual(eff["errors"], []); self.assertEqual(len(eff["effective"]), 6); self.assertEqual(eff["managed"]["rules"], [hba.validate_rule(x)[0] for x in rules])
        self.assertEqual(eff["effective"][0]["address"], "10.0.20.0") if eff["effective"][0].get("address") else None
        again = ex.h_hba_apply({"rules": rules}); self.assertFalse(again["changed"], "second apply is a no-op")
        with self.assertRaises(OpError) as c: ex.h_hba_apply({"rules": [R(user="x")], "base_rev": base})
        self.assertIn("changed since", str(c.exception))
        rb = ex.h_hba_rollback({}); self.assertTrue(rb["restored"])
        self.assertFalse(ex.h_hba_read({})["managed"]["present"], "rollback restored the original file")
        self.assertEqual(ex.h_hba_read({})["errors"], [])

    def test_3_invalid_and_lockout_refused(self):
        ex = self.ex()
        with self.assertRaises(OpError): ex.h_hba_apply({"rules": [R(address="999.1.1.1/8")]})
        pl = ex.h_hba_plan({"rules": [R(type="local", address="", database="postgres", user="postgres", method="reject")]})
        self.assertEqual(len(pl["would_lock_out"]), 1, pl["would_lock_out"])
        with self.assertRaises(OpError) as c: ex.h_hba_apply({"rules": [R(type="local", address="", database="postgres", user="postgres", method="reject")]})
        self.assertIn("lock out", str(c.exception))
        self.assertFalse(ex.h_hba_read({})["managed"]["present"], "nothing was written")
        bad = ex.h_hba_plan({"rules": [R(type="nope")]}); self.assertFalse(bad["valid"]); self.assertEqual(bad["errors"][0]["index"], 0)

    def test_4_patroni_mode_edits_dcs_list(self):
        lst = ["local all all trust", "host all all 0.0.0.0/0 scram-sha-256"]
        pt = FakePatroni(self.hba, lst)
        ex = self.ex(pt)
        self.assertEqual(ex.h_hba_read({})["mode"], "patroni")
        res = ex.h_hba_apply({"rules": [R(comment="x")]}); self.assertEqual(res["mode"], "patroni")
        self.assertTrue(any(l.startswith(hba.BEGIN[:20]) for l in pt.cfg["postgresql"]["pg_hba"]))
        self.assertIn("local all all trust", pt.cfg["postgresql"]["pg_hba"], "foreign entries kept")
        self.assertEqual(ex.h_hba_read({})["errors"], [])
        with self.assertRaises(OpError): ex.h_hba_rollback({})
        ex.h_hba_apply({"rules": []}); self.assertFalse(any(hba.BEGIN in l for l in pt.cfg["postgresql"]["pg_hba"]))

    def test_5_adopt_existing_rules_and_temporary_rules(self):
        with open(self.hba, "w") as f:
            f.write("# my file\nlocal all postgres trust\nlocal all all trust\nhost replication repl 10.0.2.0/24 scram-sha-256\nhost all all 0.0.0.0/0 scram-sha-256\n")
        self.db.run_psql("SELECT pg_reload_conf();")
        ex = self.ex()
        before = ex.h_hba_read({})
        existing = [hba.validate_rule(r["rule"])[0] for r in hba.parse_file(before["raw"])[0]]
        # adopting while dropping one of them is refused: the effective policy must not change silently
        with self.assertRaises(OpError) as c: ex.h_hba_apply({"rules": existing[:-1], "adopt": True})
        self.assertIn("adopt would drop", str(c.exception))
        res = ex.h_hba_apply({"rules": existing, "adopt": True}); self.assertTrue(res["changed"])
        after = ex.h_hba_read({})
        self.assertEqual(after["errors"], []); self.assertEqual(len(after["managed"]["rules"]), 4)
        self.assertEqual([(e["type"], e["database"], e["user_name"], e["auth_method"]) for e in after["effective"]],
                         [(e["type"], e["database"], e["user_name"], e["auth_method"]) for e in before["effective"]], "same effective rules in the same order")
        self.assertEqual(len([l for l in after["raw"].split("\n") if l.strip() and not l.startswith("#") and "pgarca" not in l]), 4, "no duplicate rule lines left outside the block")
        self.assertIn("# my file", after["raw"], "operator comments kept")
        self.assertFalse(ex.h_hba_apply({"rules": existing, "adopt": True})["changed"], "idempotent")
        # temporary rules: [until=...] in the comment; expire removes only the elapsed ones
        past, future = "2020-01-01T00:00", "2999-01-01T00:00"
        rules = existing + [R(comment="Consulente [until=%sZ]" % past, address="10.9.9.0/24"), R(comment="Audit [until=%sZ]" % future, address="10.8.8.0/24")]
        ex.h_hba_apply({"rules": rules})
        ex_res = ex.h_hba_expire({}); self.assertTrue(ex_res["changed"]); self.assertEqual(ex_res["removed"], 1)
        left = ex.h_hba_read({})["managed"]["rules"]
        self.assertEqual(len(left), 5); self.assertTrue(all("2020" not in r["comment"] for r in left)); self.assertEqual(ex.h_hba_read({})["errors"], [])
        self.assertFalse(ex.h_hba_expire({})["changed"], "nothing else expired: no-op")
        self.assertEqual(hba.until_of({"comment": "x [until=2999-01-01T00:00Z]"}), 32472144000)
        pt = FakePatroni(self.hba, ["local all all trust"])
        with self.assertRaises(OpError): self.ex(pt).h_hba_expire({})


if __name__ == "__main__":
    unittest.main()
