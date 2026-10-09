import unittest
from pg_arca import hba

BASE = """# TYPE  DATABASE  USER  ADDRESS  METHOD
local   all   postgres   peer
host    replication  repl  10.0.2.0/24  scram-sha-256
host    all   all   0.0.0.0/0   scram-sha-256
"""
R = lambda **k: dict(dict(type="hostssl", database="all", user="app", address="10.0.20.0/24", method="scram-sha-256", options="", comment=""), **k)


class HbaTests(unittest.TestCase):
    def test_validation(self):
        ok, w = hba.validate_rule(R(comment="App network"))
        self.assertEqual(ok["address"], "10.0.20.0/24"); self.assertEqual(w, [])
        for bad in (R(type="remote"), R(address="10.0.20.0/33"), R(address=""), R(user="@file"), R(user="a b"), R(method="magic"),
                    R(method="trust"), R(comment="a\nb"), R(address="bad host!"), R(database=""), R(options="x;rm -rf")):
            with self.assertRaises(hba.HbaError, msg=str(bad)):
                hba.validate_rule(bad)
        _, w = hba.validate_rule(R(type="host")); self.assertTrue(any("unencrypted" in x for x in w))
        _, w = hba.validate_rule(R(address="0.0.0.0/0")); self.assertTrue(any("internet" in x for x in w))
        hba.validate_rule(dict(type="local", database="all", user="postgres", address="", method="peer"))
        hba.validate_rule(R(type="host", address="127.0.0.1/32", method="trust"))          # loopback trust allowed
        c, errs, _ = hba.validate_rules([R(), R(type="x")]); self.assertEqual(len(c), 1); self.assertEqual(errs[0]["index"], 1)

    def test_block_roundtrip_and_idempotence(self):
        rules = [hba.validate_rule(R(comment="App"))[0], hba.validate_rule(R(database="billing", user="+dba", address="10.0.10.0/24"))[0]]
        t1 = hba.apply_block(BASE, rules)
        self.assertTrue(t1.index(hba.BEGIN) < t1.index("local   all   postgres"))          # first-match: block comes before existing rules
        self.assertEqual(hba.extract_block(t1), rules)
        self.assertEqual(hba.apply_block(t1, rules), t1)                                    # same rules -> byte-identical file
        t2 = hba.apply_block(t1, rules[:1]); self.assertEqual(len(hba.extract_block(t2)), 1)
        self.assertEqual(hba.apply_block(t2, []).count(hba.BEGIN), 0)                       # removing the block restores the original rules
        self.assertEqual([x["rule"] for x in hba.parse_file(hba.apply_block(t2, []))[0]], [x["rule"] for x in hba.parse_file(BASE)[0]])
        self.assertEqual(hba.apply_block(BASE, []), BASE)
        # nothing outside the block was touched
        outside = [x["rule"] for x in hba.parse_file(t1)[0] if not x["in_block"]]
        self.assertEqual(outside, [x["rule"] for x in hba.parse_file(BASE)[0]])

    def test_parse_variants(self):
        r = hba.parse_rule_line('host "my db",x u 192.168.1.0 255.255.255.0 md5 clientcert=verify-full')
        self.assertEqual(r["address"], "192.168.1.0/24"); self.assertEqual(r["options"], "clientcert=verify-full")
        self.assertIsNone(hba.parse_rule_line("garbage line"))
        rules, inc = hba.parse_file("include /x/y.conf\nlocal all all peer\n"); self.assertTrue(inc); self.assertEqual(len(rules), 1)

    def test_simulation(self):
        rules = [x["rule"] for x in hba.parse_file(BASE)[0]]
        repl = dict(type="host", ssl=True, database="replication", user="repl", address="10.0.2.12", replication=True)
        self.assertTrue(hba.decide(rules, repl)["allowed"])
        self.assertTrue(hba.decide(rules, dict(type="local", database="x", user="postgres"))["allowed"])
        # a reject rule at the top (the managed block) would lock replication out -> simulation sees it
        blk = [hba.validate_rule(R(database="all", user="all", address="0.0.0.0/0", method="reject", type="host"))[0]]
        self.assertTrue(hba.decide(blk + rules, repl)["allowed"], "PG: database 'all' never matches replication connections")
        blk2 = [hba.validate_rule(R(database="replication", user="all", address="10.0.2.0/24", method="reject", type="host"))[0]]
        self.assertFalse(hba.decide(blk2 + rules, repl)["allowed"])
        app = dict(type="host", ssl=False, database="billing", user="app", address="10.0.20.5")
        self.assertTrue(hba.decide(rules, app)["allowed"])
        self.assertFalse(hba.decide([r for r in rules if r["type"] != "host"], app)["allowed"], "no rule -> refused")
        ssl_only = [hba.validate_rule(R())[0]]
        self.assertFalse(hba.decide(ssl_only, app)["allowed"]); self.assertTrue(hba.decide(ssl_only, dict(app, ssl=True))["allowed"])
        d = hba.decide([R(type="host", address="db.example.com")], app); self.assertFalse(d["allowed"]); self.assertTrue(d["uncertain"])
        role = [dict(R(user="+dba", address="all", type="host"))]
        self.assertTrue(hba.decide(role, dict(app, user="bob", roles=["dba"]))["allowed"])


if __name__ == "__main__":
    unittest.main()
