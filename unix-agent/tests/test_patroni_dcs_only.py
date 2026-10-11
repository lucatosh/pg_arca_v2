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

    def validate_param(self, name, value):
        return ({"vartype": "integer"}, None) if name != "bogus_param" else (None, "unknown parameter 'bogus_param' on this PostgreSQL version")


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
        r = ex.h_set_param({"name": "work_mem", "value": "8MB", "settle_seconds": 0.5})
        self.assertEqual(r["via"], "patroni")
        self.assertIn("overrides the DCS", r.get("warning", ""), "PostgreSQL did not take the value: said, not hidden")
        self.assertEqual(pat.patches, [{"postgresql": {"parameters": {"work_mem": "8MB"}}}])
        self.assertEqual(db.alter_calls, [])

    def test_invalid_param_never_reaches_the_dcs(self):
        ex, db, pat, _ = make()
        with self.assertRaises(OpError) as cm:
            ex.h_set_param({"name": "bogus_param", "value": "1"})
        self.assertIn("refused before touching the DCS", str(cm.exception))
        self.assertEqual(pat.patches, [])
        with self.assertRaises(OpError) as cm:
            ex.h_set_param({"name": "listen_addresses", "value": "*"})
        self.assertIn("Patroni configuration", str(cm.exception))
        self.assertEqual(pat.patches, [])

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
        db.query_json = lambda sql, **kw: (EFF, "")
        with NoFile(hf):
            src = hba_ops._Src(ex, lambda m: Exception(m))
            self.assertTrue(src.patroni and src.seed)
            self.assertEqual(src.text(), "local  all  postgres  peer\nhost  replication  replicator  10.0.0.0/8  scram-sha-256\n")   # from PostgreSQL, not the file
        lst = src.text().rstrip("\n").split("\n")
        ex.patroni.patch_config({"postgresql": {"pg_hba": lst}})   # what _apply_patroni does
        src2 = hba_ops._Src(ex, lambda m: Exception(m))
        self.assertTrue(src2.patroni and not src2.seed)
        self.assertEqual(src2.dcs_list, lst)

    def test_hba_with_dcs_list_uses_it(self):
        ex, db, pat, hf = make(config={"postgresql": {"pg_hba": ["local all all peer"]}})
        with NoFile(hf):
            src = hba_ops._Src(ex, lambda m: Exception(m))
            self.assertTrue(src.patroni and not src.seed)
            self.assertEqual(src.text(), "local all all peer\n")


EFF = [{"line_number": 1, "type": "local", "database": ["all"], "user_name": ["postgres"], "address": None, "netmask": None, "auth_method": "peer", "options": None, "error": None},
       {"line_number": 2, "type": "host", "database": ["replication"], "user_name": ["replicator"], "address": "10.0.0.0", "netmask": "255.0.0.0", "auth_method": "scram-sha-256", "options": None, "error": None}]


class NoFile(object):
    """Fails the test if anything opens the given pg_hba.conf (read OR write)."""
    def __init__(self, path):
        self.path = os.path.realpath(path)

    def __enter__(self):
        import builtins
        self.orig = builtins.open
        me = self

        def guarded(f, *a, **k):
            if isinstance(f, str) and os.path.realpath(f) == me.path:
                raise AssertionError("pg_hba.conf opened on a Patroni node")
            return me.orig(f, *a, **k)
        builtins.open = guarded
        return self

    def __exit__(self, *a):
        import builtins
        builtins.open = self.orig


class PatroniPg(object):
    """PostgreSQL behind Patroni: pg_hba_file_rules reflects the DCS list once Patroni 'reloads' (immediately here)."""
    def __init__(self, pat, hba_file):
        self.pat, self.hba_file, self.user = pat, hba_file, "postgres"

    def run_psql(self, sql, **kw):
        if "ssl" in sql:
            return True, "off", ""
        if "data_directory" in sql:
            return True, os.path.dirname(self.hba_file), ""
        return True, self.hba_file, ""

    def query_json(self, sql, **kw):
        if "pg_hba_file_rules" in sql:
            lst = (self.pat.config.get("postgresql") or {}).get("pg_hba")
            if lst is None:
                return EFF, ""
            out = []
            from pg_arca import hba
            for i, l in enumerate(lst):
                r = hba.parse_rule_line(l.strip()) if l.strip() and not l.strip().startswith("#") else None
                if r:
                    out.append({"line_number": i + 1, "type": r["type"], "database": r["database"].split(","), "user_name": r["user"].split(","),
                                "address": r["address"].split("/")[0] if r["address"] else None,
                                "netmask": __import__("ipaddress").ip_network(r["address"], strict=False).netmask.exploded if r["address"] and "/" in r["address"] else None,
                                "auth_method": r["method"], "options": None, "error": None})
            return out, ""
        if "pg_stat_replication" in sql:
            return [{"user": "replicator", "address": "10.0.0.7", "ssl": False}], ""
        return [], ""


class HbaPatroniFlow(unittest.TestCase):
    def mk(self, config=None):
        ex, db, pat, hf = make(config=config)
        ex.db = PatroniPg(pat, hf)
        return ex, pat, hf

    RULE = {"type": "hostssl", "database": "app", "user": "app", "address": "10.1.0.0/24", "method": "scram-sha-256", "comment": "app [until=2000-01-01T00:00Z]"}

    def test_read_plan_apply_restore_expire_never_open_the_file(self):
        ex, pat, hf = self.mk()
        with NoFile(hf):
            r = hba_ops.read(ex, {}, OpError)
            self.assertEqual((r["mode"], r["dcs_seed"], r["backups"]), ("patroni", True, []))
            self.assertEqual(len(r["dcs_rules"]), 2)
            pl = hba_ops.plan(ex, {"rules": [self.RULE]}, OpError)
            self.assertTrue(pl["valid"] and pl["changed"] and pl["dcs_seed"])
            self.assertEqual(pl["would_lock_out"], [])
            a = hba_ops.apply(ex, {"rules": [self.RULE], "base_rev": pl["base_rev"]}, OpError)
            self.assertEqual((a["mode"], a["dcs_seed"], a["previous"]), ("patroni", True, None))
            dcs = pat.config["postgresql"]["pg_hba"]
            self.assertIn("hostssl  app  app  10.1.0.0/24  scram-sha-256", dcs)
            self.assertIn("host  replication  replicator  10.0.0.0/8  scram-sha-256", dcs)        # the rules in force were seeded, nothing lost
            self.assertEqual(a["seed_list"], ["local  all  postgres  peer", "host  replication  replicator  10.0.0.0/8  scram-sha-256"])
            # a stale plan is refused
            with self.assertRaises(OpError):
                hba_ops.apply(ex, {"rules": [], "base_rev": pl["base_rev"]}, OpError)
            # temporary rule already elapsed: expire removes it from the DCS list
            e = hba_ops.expire(ex, {}, OpError)
            self.assertEqual(e["removed"], 1)
            self.assertFalse(any("10.1.0.0/24" in x for x in pat.config["postgresql"]["pg_hba"]))
            # restore the list as it was after the apply (kept by the console)
            cur = hba_ops.read(ex, {}, OpError)
            rs = hba_ops.restore_dcs(ex, {"list": dcs, "base_rev": cur["rev"]}, OpError)
            self.assertTrue(rs["changed"])
            self.assertEqual(pat.config["postgresql"]["pg_hba"], dcs)

    def test_restore_refuses_lockout_and_bad_lines(self):
        ex, pat, hf = self.mk(config={"postgresql": {"pg_hba": ["local all postgres peer", "host replication replicator 10.0.0.0/8 scram-sha-256"]}})
        with self.assertRaises(OpError) as cm:
            hba_ops.restore_dcs(ex, {"list": ["local all postgres peer"]}, OpError)      # would cut the live replica 10.0.0.7
        self.assertIn("lock out", str(cm.exception))
        with self.assertRaises(OpError):
            hba_ops.restore_dcs(ex, {"list": ["include /etc/evil.conf"]}, OpError)
        with self.assertRaises(OpError):
            hba_ops.restore_dcs(ex, {"list": ["host all @users 0.0.0.0/0 trust"]}, OpError)

    def test_custom_hba_file_means_patroni_ignores_the_dcs_list(self):
        ex, pat, hf = self.mk(config={"postgresql": {"pg_hba": ["local all all peer"], "parameters": {"hba_file": "/etc/postgresql/hba.conf"}}})
        self.assertEqual(hba_ops.read(ex, {}, OpError)["external_hba_file"], "/etc/postgresql/hba.conf")
        with self.assertRaises(OpError) as cm:
            hba_ops.apply(ex, {"rules": [self.RULE]}, OpError)
        self.assertIn("would be ignored", str(cm.exception))
        self.assertEqual(pat.patches, [], "nothing written to the DCS")

    def test_read_with_postgres_down_uses_the_dcs(self):
        ex, pat, hf = self.mk(config={"postgresql": {"pg_hba": ["local all all peer"]}})
        def down():
            raise OpError("PostgreSQL is not running")
        ex._require_pg = down
        with NoFile(hf):
            r = hba_ops.read(ex, {}, OpError)
        self.assertTrue(r["pg_down"])
        self.assertEqual(r["raw"], "local all all peer\n")


class EffectiveRows(unittest.TestCase):
    def test_ipv6_and_netmask_rows_render_back(self):
        f = hba_ops.rule_from_effective
        self.assertEqual(f({"type": "host", "database": ["all"], "user_name": ["all"], "address": "::1", "netmask": "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "auth_method": "scram-sha-256"}),
                         "host  all  all  ::1/128  scram-sha-256")
        self.assertEqual(f({"type": "host", "database": ["replication"], "user_name": ["rep"], "address": "172.30.0.0", "netmask": "255.255.0.0", "auth_method": "trust"}),
                         "host  replication  rep  172.30.0.0/16  trust")
        self.assertEqual(f({"type": "host", "database": ["all"], "user_name": ["all"], "address": "all", "netmask": None, "auth_method": "md5"}), "host  all  all  all  md5")
        self.assertEqual(f({"type": "hostssl", "database": ["db1", "db2"], "user_name": ["+grp"], "address": "samenet", "netmask": None, "auth_method": "cert", "options": ["clientcert=verify-full"]}),
                         "hostssl  db1,db2  +grp  samenet  cert  clientcert=verify-full")
        self.assertIsNone(f({"type": "host", "error": "invalid"}))
        # what Patroni wrote vs what PostgreSQL loaded: equal after normalisation (IPv6 and "addr mask" forms included)
        self.assertEqual(hba_ops._norm_key("host all all ::1/128 scram-sha-256"), hba_ops._norm_key(f({"type": "host", "database": ["all"], "user_name": ["all"], "address": "::1", "netmask": "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "auth_method": "scram-sha-256"})))
        self.assertEqual(hba_ops._norm_key("host all all 10.0.0.1 255.255.255.255 md5"), hba_ops._norm_key("host all all 10.0.0.1/32 md5"))


if __name__ == "__main__":
    unittest.main()
