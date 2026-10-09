"""Real agent code <-> real console route modules over HTTP."""
import json, os, subprocess, sys, tempfile, threading, time, unittest, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.config import load_config
from pg_arca.runtime import Runtime
from pg_arca.executor import OperationExecutor
from pg_arca.console_client import ConsoleClient
from pg_arca.wal_manager import WalManager

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FAKES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fakes")

class Admin:
    def __init__(self, base): self.base, self.cookie = base, None
    def call(self, method, path, body=None, key=None):
        h = {"Content-Type": "application/json"}
        if self.cookie: h["Cookie"] = self.cookie
        if key: h["Idempotency-Key"] = key
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                if r.headers.get("Set-Cookie"): self.cookie = r.headers["Set-Cookie"].split(";")[0]
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")

class E2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc = subprocess.Popen(["tsx", "tests/e2e/harness.ts"], cwd=ROOT, stdout=subprocess.PIPE, universal_newlines=True)
        line = cls.proc.stdout.readline(); assert line.startswith("READY"), line
        cls.base = "http://127.0.0.1:%s" % line.split()[1]
    @classmethod
    def tearDownClass(cls): cls.proc.terminate(); cls.proc.wait()

    def test_full_lifecycle(self):
        adm = Admin(self.base)
        self.assertEqual(adm.call("POST", "/api/auth/setup", {"username": "admin", "password": "correct-horse-battery"})[0], 201)
        st, tok = adm.call("POST", "/api/enrollment-tokens", {"label": "e2e", "environment": "prod"}); self.assertEqual(st, 201)

        t = tempfile.mkdtemp()
        os.environ["PATH"] = FAKES + os.pathsep + os.environ["PATH"]
        cfg = load_config(); cfg.update({"web_server_url": self.base, "enrollment_token": tok["token"], "node_name": "e2e-node",
            "credentials_file": os.path.join(t, "cred.json"), "state_dir": os.path.join(t, "state"), "wal_archive_dir": os.path.join(t, "wal"),
            "repo_path": os.path.join(t, "repo"), "heartbeat_interval_seconds": 1, "pg_host": "127.0.0.1"})
        rt = Runtime(cfg)
        # discovery on a box without a running PG: instance is None. Bind the fake psql explicitly.
        rt.instance = {"data_directory": "/fake/pgdata", "cluster_key": "sysid:7312345678901234567", "port": 5432}
        ex = OperationExecutor(cfg, rt.db, rt.patroni, discovery=lambda: {"summary": {"postgres_instances_found": 1}})
        client = ConsoleClient(cfg, rt, ex, WalManager(cfg["wal_archive_dir"], "none"), None)
        client.start()
        try:
            for _ in range(60):
                st, cl = adm.call("GET", "/api/clusters")
                real = [c for c in cl["clusters"] if not c["isSandbox"]]
                if real and real[0].get("pgVersion"): break
                time.sleep(0.25)
            else: self.fail("cluster never appeared")
            c = real[0]
            self.assertEqual(c["pgVersion"], "16.4"); self.assertEqual(c["environment"], "prod"); self.assertEqual(c["haState"]["nodes"][0]["role"], "primary")
            self.assertEqual(oct(os.stat(cfg["credentials_file"]).st_mode & 0o777), "0o600")
            # operation round trip, idempotent submit
            st, o1 = adm.call("POST", "/api/clusters/%s/operations" % c["id"], {"type": "wal_switch"}, key="e2e-1"); self.assertEqual(st, 202, o1)
            st, o2 = adm.call("POST", "/api/clusters/%s/operations" % c["id"], {"type": "wal_switch"}, key="e2e-1"); self.assertTrue(o2["replayed"])
            opid = o1["operation"]["id"]
            for _ in range(60):
                st, d = adm.call("GET", "/api/operations/" + opid)
                if d["operation"]["status"] in ("succeeded", "failed"): break
                time.sleep(0.25)
            self.assertEqual(d["operation"]["status"], "succeeded", d); self.assertEqual(d["operation"]["result"]["segment"], "000000020000000000000003")
            # a failing op surfaces a clean error
            st, o3 = adm.call("POST", "/api/clusters/%s/operations" % c["id"], {"type": "patroni_pause", "params": {"enable": True}}, key="e2e-2")
            self.assertEqual(st, 409, o3)                      # no Patroni on this node => refused up-front, nothing queued
            # revoke node => agent gets 401 and stops pushing
            nid = json.load(open(cfg["credentials_file"]))["node_id"]
            self.assertEqual(adm.call("DELETE", "/api/nodes/" + nid)[0], 200)
            time.sleep(2.5)
            st, cl = adm.call("GET", "/api/clusters"); real = [x for x in cl["clusters"] if not x["isSandbox"]]
            self.assertTrue(all(len(x["agentNodes"]) == 0 for x in real))
        finally:
            client.stop()

if __name__ == "__main__": unittest.main()
