import json, os, tempfile, unittest
from pg_arca import overrides as ov
from pg_arca.config import load_config


def mkpgdata(root, name="pgdata"):
    d = os.path.join(root, name); os.makedirs(os.path.join(d, "global")); open(os.path.join(d, "PG_VERSION"), "w").write("16\n"); open(os.path.join(d, "global", "pg_control"), "w").write("x")
    return d


class Overrides(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(); self.conf = os.path.join(self.t, "agent.conf")
        json.dump({"web_server_url": "http://x", "repo_path": os.path.join(self.t, "repo")}, open(self.conf, "w"))
        os.makedirs(os.path.join(self.t, "repo"))
        self.cfg = load_config(self.conf)

    def test_pgdata_must_be_a_pgdata_and_hints_the_subfolder(self):
        with self.assertRaises(ov.OverrideError) as c: ov.validate("pg_data", self.t)
        self.assertIn("PG_VERSION", str(c.exception))
        d = mkpgdata(self.t); self.assertEqual(ov.validate("pg_data", d), d)

    def test_paths_must_be_absolute_clean_and_not_system_dirs(self):
        for bad in ("relative/x", "/var/lib/../etc", "/etc", "/etc/pg", "/usr/local/x", "/", "/proc/1", "a\nb"):
            with self.assertRaises(ov.OverrideError, msg=bad): ov.validate("repo_path", bad)
        ok = os.path.join(self.t, "newrepo"); self.assertEqual(ov.validate("repo_path", ok), ok)      # parent exists and is writable

    def test_port_user_url_host(self):
        self.assertEqual(ov.validate("pg_port", "5433"), 5433)
        for bad in (0, 70000, "abc"):
            with self.assertRaises(ov.OverrideError): ov.validate("pg_port", bad)
        with self.assertRaises(ov.OverrideError): ov.validate("pg_user", "root; rm -rf")
        with self.assertRaises(ov.OverrideError): ov.validate("patroni_url", "http://user:pw@h:8008")
        with self.assertRaises(ov.OverrideError): ov.validate("patroni_url", "file:///etc/passwd")
        self.assertEqual(ov.validate("patroni_url", "https://pg1:8008/"), "https://pg1:8008")
        self.assertEqual(ov.validate("pg_host", "db.internal"), "db.internal")
        with self.assertRaises(ov.OverrideError): ov.validate("pg_host", "bad host;")

    def test_unknown_keys_rejected_and_all_or_nothing(self):
        d = mkpgdata(self.t)
        with self.assertRaises(ov.OverrideError): ov.save(self.cfg, {"pg_data": d, "auth_token": "x"})
        self.assertEqual(ov.load(self.cfg), {})                       # nothing written because one key was bad
        ov.save(self.cfg, {"pg_data": d, "pg_port": 5433})
        self.assertEqual(ov.load(self.cfg), {"pg_data": d, "pg_port": 5433})
        self.assertEqual(oct(os.stat(ov.local_path(self.cfg)).st_mode & 0o777), "0o640")

    def test_offsite_credentials_live_in_the_owner_only_file(self):
        import json
        off = {"type": "s3", "endpoint": "https://s3.example.net", "bucket": "b", "prefix": "p", "access_key": "AKIA1", "secret_key": "S3CR3T", "region": "eu-west-1"}
        ov.save(self.cfg, {"offsite": off})
        with open(ov.local_path(self.cfg)) as f:
            pub = json.load(f)
        self.assertNotIn("secret_key", pub["offsite"]); self.assertNotIn("access_key", pub["offsite"]); self.assertEqual(pub["offsite"]["bucket"], "b")
        self.assertEqual(oct(os.stat(ov.secrets_path(self.cfg)).st_mode & 0o777), "0o600")
        self.assertEqual(ov.load(self.cfg)["offsite"]["secret_key"], "S3CR3T")             # merged back for the agent
        self.assertEqual(load_config(self.conf)["offsite"]["access_key"], "AKIA1")
        ov.save(self.cfg, {"offsite": None})
        self.assertNotIn("offsite", ov.load(self.cfg))
        with open(ov.secrets_path(self.cfg)) as f:
            self.assertEqual(json.load(f), {})

    def test_layering_file_overrides_env(self):
        d = mkpgdata(self.t); ov.save(self.cfg, {"pg_data": d, "repo_path": os.path.join(self.t, "r2")})
        c2 = load_config(self.conf); self.assertEqual(c2["pg_data"], d); self.assertEqual(c2["repo_path"], os.path.join(self.t, "r2"))   # agent.local.json beats agent.conf
        os.environ["PG_ARCA_REPO"] = "/env/repo"
        try: self.assertEqual(load_config(self.conf)["repo_path"], "/env/repo")                                                                # env beats both
        finally: del os.environ["PG_ARCA_REPO"]
        ov.save(self.cfg, {"repo_path": None}); self.assertNotIn("repo_path", ov.load(self.cfg))                                              # reset

    def test_describe_shows_source(self):
        d = mkpgdata(self.t); ov.save(self.cfg, {"pg_data": d})
        rows = {r["key"]: r for r in ov.describe(load_config(self.conf))}
        self.assertEqual(rows["pg_data"]["source"], "set here"); self.assertTrue(rows["pg_data"]["check"]["ok"])
        self.assertEqual(rows["repo_path"]["source"], "agent.conf")

    def test_corrupt_local_file_does_not_stop_the_agent(self):
        open(os.path.join(self.t, ov.LOCAL_NAME), "w").write("{not json")
        self.assertEqual(load_config(self.conf)["web_server_url"], "http://x")


if __name__ == "__main__":
    unittest.main()


class ExecutorHandlers(unittest.TestCase):
    def test_get_set_roundtrip(self):
        from pg_arca.executor import OperationExecutor as Executor, OpError
        t = tempfile.mkdtemp(); conf = os.path.join(t, "agent.conf"); json.dump({"web_server_url": "http://x", "state_dir": os.path.join(t, "st")}, open(conf, "w"))
        os.environ["PG_ARCA_CONF_FILE"] = conf
        try:
            cfg = load_config(conf); ex = Executor(cfg, None, None)
            d = mkpgdata(t)
            r = ex.h_cfg_set({"set": {"pg_data": d, "pg_port": 5444}})
            self.assertEqual(cfg["pg_data"], d); self.assertEqual(cfg["pg_port"], 5444)
            self.assertEqual({s["key"]: s["source"] for s in r["settings"]}["pg_data"], "set here")
            with self.assertRaises(OpError): ex.h_cfg_set({"set": {"pg_data": t}})
            self.assertEqual(cfg["pg_data"], d)                              # failed change leaves the running config alone
            ex.h_cfg_set({"set": {"pg_data": None}}); self.assertEqual(cfg["pg_data"], "")      # reset -> default again
            self.assertIn("settings", ex.h_cfg_get({}))
        finally:
            del os.environ["PG_ARCA_CONF_FILE"]

    def test_changing_the_destination_keeps_the_old_location_readable(self):
        from pg_arca.executor import OperationExecutor as Executor
        t = tempfile.mkdtemp(); conf = os.path.join(t, "agent.conf")
        old_r, old_w = os.path.join(t, "repoA"), os.path.join(t, "walA")
        for d in (old_r, old_w):
            os.makedirs(d)
        json.dump({"web_server_url": "http://x", "state_dir": os.path.join(t, "st"), "repo_path": old_r, "wal_archive_dir": old_w}, open(conf, "w"))
        os.environ["PG_ARCA_CONF_FILE"] = conf
        try:
            cfg = load_config(conf); ex = Executor(cfg, None, None)
            ex.h_cfg_set({"set": {"repo_path": os.path.join(t, "repoB"), "wal_archive_dir": os.path.join(t, "walB")}})
            self.assertEqual((cfg["repo_previous"], cfg["wal_previous"]), ([old_r], [old_w]))
            os.makedirs(os.path.join(t, "repoB"))                          # backups were written there
            ex.h_cfg_set({"set": {"repo_path": os.path.join(t, "repoC")}})
            os.makedirs(os.path.join(t, "repoC"))
            self.assertEqual(cfg["repo_previous"], [old_r, os.path.join(t, "repoB")])
            ex.h_cfg_set({"set": {"repo_path": old_r}})                     # back to the first one: no longer "previous", the others stay readable
            self.assertEqual(cfg["repo_previous"], [os.path.join(t, "repoB"), os.path.join(t, "repoC")])
            self.assertNotIn("repo_previous", {s["key"] for s in ex.h_cfg_get({})["settings"]}, "managed by the console, not shown as a hand-editable setting")
            ex.h_cfg_set({"set": {"repo_previous": None}})
            self.assertNotIn("repo_previous", cfg)
        finally:
            del os.environ["PG_ARCA_CONF_FILE"]


class ExecutorFollowsRuntime(unittest.TestCase):
    def test_db_and_patroni_follow_refresh(self):
        import types
        from pg_arca.executor import OperationExecutor
        t = tempfile.mkdtemp(); a, b, p1, p2 = object(), object(), object(), object()
        rt = types.SimpleNamespace(db=a, patroni=p1, instance=None)
        ex = OperationExecutor({"state_dir": os.path.join(t, "st")}, a, p1, runtime=rt)
        self.assertIs(ex.db, a)
        rt.db, rt.patroni = b, p2                      # what Runtime.refresh() does
        self.assertIs(ex.db, b); self.assertIs(ex.patroni, p2)
        ex2 = OperationExecutor({"state_dir": os.path.join(t, "st2")}, a, p1)      # no runtime: the given ones
        self.assertIs(ex2.db, a)
