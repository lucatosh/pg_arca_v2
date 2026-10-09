import json, os, sys, tempfile, threading, unittest, time
from http.server import BaseHTTPRequestHandler, HTTPServer
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.config import load_config, atomic_write_json
from pg_arca.db_client import PostgresClient
from pg_arca.patroni_bridge import PatroniBridge
from pg_arca.executor import OperationExecutor

FAKES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fakes")

class FakePatroni(BaseHTTPRequestHandler):
    leader = "n1"; posts = []; paused = False
    def log_message(self, *a): pass
    def _j(self, code, d):
        b = json.dumps(d).encode(); self.send_response(code); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        cls = FakePatroni
        if self.path == "/patroni": self._j(200, {"state": "running", "role": "master" if cls.leader == "n1" else "replica", "pending_restart": False})
        elif self.path == "/cluster": self._j(200, {"scope": "pg", "pause": cls.paused, "members": [
            {"name": "n1", "role": "leader" if cls.leader == "n1" else "replica", "state": "running"},
            {"name": "n2", "role": "leader" if cls.leader == "n2" else "replica", "state": "streaming"},
            {"name": "n3", "role": "replica", "state": "stopped"}]})
        elif self.path == "/config": self._j(200, {"postgresql": {"parameters": getattr(FakePatroni, "params", {})}})
        else: self._j(404, {})
    def _body(self):
        n = int(self.headers.get("Content-Length", 0)); return json.loads(self.rfile.read(n) or b"{}")
    def do_POST(self):
        b = self._body(); FakePatroni.posts.append((self.path, b))
        if self.path == "/switchover": FakePatroni.leader = b.get("candidate") or "n2"; self._j(200, {"ok": 1})
        else: self._j(200, {})
    def do_PATCH(self):
        b = self._body(); FakePatroni.posts.append(("PATCH " + self.path, b))
        if "pause" in b: FakePatroni.paused = b["pause"]
        if "postgresql" in b: FakePatroni.params = {**getattr(FakePatroni, "params", {}), **b["postgresql"]["parameters"]}
        self._j(200, b)

class AgentFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), FakePatroni); cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
    @classmethod
    def tearDownClass(cls): cls.srv.shutdown()

    def setUp(self):
        FakePatroni.leader = "n1"; FakePatroni.posts = []; FakePatroni.paused = False; FakePatroni.params = {}
        self.t = tempfile.mkdtemp()
        self.log = os.path.join(self.t, "psql.log"); os.environ["FAKE_PSQL_LOG"] = self.log; os.environ.pop("FAKE_PSQL_DOWN", None)
        os.environ["PATH"] = FAKES + os.pathsep + os.environ["PATH"]
        self.cfg = load_config(); self.cfg["state_dir"] = os.path.join(self.t, "state")
        self.db = PostgresClient(user="postgres", port=5432, host="127.0.0.1")
        self.pat = PatroniBridge("http://127.0.0.1:%d" % self.port)
        self.ex = OperationExecutor(self.cfg, self.db, self.pat, discovery=lambda: {"ok": 1})
    def psql_calls(self):
        if not os.path.exists(self.log): return []
        with open(self.log) as f: return [json.loads(l) for l in f]

    def test_snapshot_parsed(self):
        s = self.db.get_snapshot(); self.assertTrue(s["alive"]); self.assertEqual(s["version"], "16.4"); self.assertEqual(s["replication"], [])
    def test_pg_down_is_reported_not_crashed(self):
        os.environ["FAKE_PSQL_DOWN"] = "1"
        self.assertFalse(self.db.get_snapshot()["alive"])
        st, _, err = self.ex.execute({"id": "op-000000000001", "type": "pg_reload", "params": {}})
        self.assertEqual(st, "failed"); self.assertIn("not reachable", err)

    def test_switchover_stale_leader_refused_without_calling_patroni(self):
        st, _, err = self.ex.execute({"id": "op-000000000002", "type": "patroni_switchover", "params": {"leader": "n2"}})
        self.assertEqual(st, "failed"); self.assertIn("stale request", err); self.assertEqual(FakePatroni.posts, [])
    def test_switchover_unhealthy_candidate_refused(self):
        st, _, err = self.ex.execute({"id": "op-000000000003", "type": "patroni_switchover", "params": {"leader": "n1", "candidate": "n3"}})
        self.assertEqual(st, "failed"); self.assertIn("not healthy", err); self.assertEqual(FakePatroni.posts, [])
    def test_switchover_ok_verified_and_never_repeated(self):
        op = {"id": "op-000000000004", "type": "patroni_switchover", "params": {"leader": "n1", "candidate": "n2"}}
        st, res, _ = self.ex.execute(op); self.assertEqual(st, "succeeded"); self.assertEqual(res["new_leader"], "n2")
        self.assertEqual(len(FakePatroni.posts), 1)
        st2, res2, _ = self.ex.execute(op)                                   # console redelivery after a lost report
        self.assertEqual((st2, res2["new_leader"]), ("succeeded", "n2")); self.assertEqual(len(FakePatroni.posts), 1)
        ex2 = OperationExecutor(self.cfg, self.db, self.pat)                   # agent restarted: journal survives
        self.assertEqual(ex2.execute(op)[0], "succeeded"); self.assertEqual(len(FakePatroni.posts), 1)
    def test_interrupted_non_idempotent_op_is_not_blindly_repeated(self):
        atomic_write_json(os.path.join(self.ex.dir, "op-000000000005.json"), {"id": "op-000000000005", "type": "patroni_switchover", "status": "running"})
        st, _, err = self.ex.execute({"id": "op-000000000005", "type": "patroni_switchover", "params": {"leader": "n1", "candidate": "n2"}})
        self.assertEqual(st, "failed"); self.assertIn("interrupted", err); self.assertEqual(FakePatroni.posts, [])
    def test_interrupted_idempotent_op_is_retried(self):
        atomic_write_json(os.path.join(self.ex.dir, "op-000000000006.json"), {"id": "op-000000000006", "type": "pg_reload", "status": "running"})
        self.assertEqual(self.ex.execute({"id": "op-000000000006", "type": "pg_reload", "params": {}})[0], "succeeded")
    def test_param_via_patroni_when_managed_and_verified(self):
        st, res, err = self.ex.execute({"id": "op-000000000007", "type": "pg_set_param", "params": {"name": "work_mem", "value": "64MB"}})
        self.assertEqual(st, "succeeded", err); self.assertEqual(res["via"], "patroni")
        self.assertEqual(FakePatroni.posts[0][1], {"postgresql": {"parameters": {"work_mem": "64MB"}}})
        self.assertFalse(any("ALTER SYSTEM" in c["sql"] for c in self.psql_calls()))      # DCS owns parameters
    def test_param_alter_system_without_patroni_uses_bound_variables(self):
        ex = OperationExecutor(self.cfg, self.db, PatroniBridge(""))
        st, res, err = ex.execute({"id": "op-000000000008", "type": "pg_set_param", "params": {"name": "work_mem", "value": "64MB'; DROP TABLE x;--"}})
        self.assertEqual(st, "succeeded", err)
        calls = [c for c in self.psql_calls() if "ALTER SYSTEM" in c["sql"]]
        self.assertEqual(len(calls), 1); self.assertNotIn("DROP TABLE", calls[0]["sql"])          # value never interpolated into SQL text
        self.assertIn("pval=64MB'; DROP TABLE x;--", calls[0]["args"])
    def test_denied_and_invalid_params(self):
        for name in ("data_directory", "Work_Mem;", "../x"):
            st, _, err = self.ex.execute({"id": "op-00000000%04d" % (10 + len(name)), "type": "pg_set_param", "params": {"name": name, "value": "1"}})
            self.assertEqual(st, "failed")
    def test_pause_verified(self):
        st, res, _ = self.ex.execute({"id": "op-000000000009", "type": "patroni_pause", "params": {"enable": True}})
        self.assertEqual((st, res), ("succeeded", {"paused": True}))
    def test_config_patch_cannot_touch_dangerous_sections(self):
        st, _, err = self.ex.execute({"id": "op-00000000000a", "type": "patroni_config_patch", "params": {"patch": {"postgresql": {"pg_hba": ["host all all 0.0.0.0/0 trust"]}}}})
        self.assertEqual(st, "failed"); self.assertEqual(FakePatroni.posts, [])
    def test_unknown_op_and_bad_id(self):
        self.assertEqual(self.ex.execute({"id": "op-00000000000b", "type": "rm_rf", "params": {}})[0], "failed")
        self.assertEqual(self.ex.execute({"id": "../../etc", "type": "pg_reload", "params": {}})[0], "failed")
    def test_wal_switch_refused_on_standby_path_returns_segment_on_primary(self):
        st, res, _ = self.ex.execute({"id": "op-00000000000c", "type": "wal_switch", "params": {}}); self.assertEqual(res["segment"], "000000020000000000000003")

if __name__ == "__main__": unittest.main()
