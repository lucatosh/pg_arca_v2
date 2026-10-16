"""pg-arca-pgctl bridge (polkit < 0.106): the root side accepts only restart/start of known PostgreSQL units, asked by a listed user (file owner)."""
import json
import os
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_arca import pgctl_bridge as b


class R(object):
    def __init__(self, rc=0, out=""):
        self.returncode, self.stdout, self.stderr = rc, out, ""


def runner_for(calls, loaded=("postgresql@14-main.service",)):
    def run(argv, **k):
        calls.append(argv)
        if argv[:2] == ["systemctl", "show"]:
            return R(0, "loaded\n" if argv[-1] in loaded else "not-found\n")
        return R(0, "")
    return run


class Bridge(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        os.chmod(self.d, 0o1733)
        self.me = os.geteuid()
        self.users = {"pgagent"}
        self.pw = lambda uid: "pgagent" if uid == self.me else "other"

    def tearDown(self):
        import shutil
        shutil.rmtree(self.d, ignore_errors=True)

    def _req(self, body, rid="a" * 32):
        with open(os.path.join(self.d, rid + ".req"), "w") as f:
            f.write(body if isinstance(body, str) else json.dumps(body))
        return rid

    def _ans(self, rid):
        with open(os.path.join(self.d, rid + ".done")) as f:
            return json.load(f)

    def test_allowed_restart_runs_systemctl(self):
        calls = []
        rid = self._req({"verb": "restart", "unit": "postgresql@14-main.service"})
        out = b.handle(self.d, self.users, runner_for(calls), self.pw, log=lambda m: None)
        self.assertEqual(out[0][4], 0)
        self.assertIn(["systemctl", "restart", "postgresql@14-main.service"], calls)
        self.assertEqual(self._ans(rid)["rc"], 0)
        self.assertFalse(os.path.exists(os.path.join(self.d, rid + ".req")))

    def test_start_is_no_block(self):
        calls = []
        self._req({"verb": "start", "unit": "postgresql@14-main.service"})
        b.handle(self.d, self.users, runner_for(calls), self.pw, log=lambda m: None)
        self.assertIn(["systemctl", "start", "--no-block", "postgresql@14-main.service"], calls)

    def test_refusals(self):
        cases = [({"verb": "stop", "unit": "postgresql@14-main.service"}, "verb"),
                 ({"verb": "restart", "unit": "ssh.service"}, "not a PostgreSQL unit"),
                 ({"verb": "restart", "unit": "postgresql@.service"}, "not a PostgreSQL unit"),
                 ({"verb": "restart", "unit": "postgresql-99.service"}, "not known")]
        for i, (body, why) in enumerate(cases):
            calls = []
            rid = self._req(body, rid=("%x" % i) * 32)
            b.handle(self.d, self.users, runner_for(calls), self.pw, log=lambda m: None)
            ans = self._ans(rid)
            self.assertEqual(ans["rc"], 77, body)
            self.assertIn(why, ans["out"])
            self.assertFalse(any(c[1] in ("restart", "start", "stop") for c in calls), calls)

    def test_user_not_listed(self):
        calls = []
        rid = self._req({"verb": "restart", "unit": "postgresql@14-main.service"})
        b.handle(self.d, {"someone-else"}, runner_for(calls), self.pw, log=lambda m: None)
        self.assertEqual(self._ans(rid)["rc"], 77)
        self.assertEqual([c for c in calls if c[1] == "restart"], [])

    def test_symlink_and_bad_names_dropped(self):
        os.symlink("/etc/passwd", os.path.join(self.d, "b" * 32 + ".req"))
        with open(os.path.join(self.d, "not-an-id.req"), "w") as f:
            f.write("{}")
        calls = []
        self.assertEqual(b.handle(self.d, self.users, runner_for(calls), self.pw, log=lambda m: None), [])
        self.assertEqual(os.listdir(self.d), [])

    def test_unreadable_users_file_allows_nobody(self):
        p = os.path.join(self.d, "users")
        with open(p, "w") as f:
            f.write("pgagent\n")
        os.chmod(p, 0o666)
        self.assertEqual(b._allowed_users(p), set())

    def test_round_trip(self):
        """agent side request() + root side handle() on the same directory"""
        calls = []
        stop = []

        def serve():
            while not stop:
                b.handle(self.d, self.users, runner_for(calls), self.pw, log=lambda m: None)
                time.sleep(0.05)
        t = threading.Thread(target=serve)
        t.start()
        try:
            rc, out = b.request("restart", "postgresql@14-main.service", timeout=5, ctl_dir=self.d, poll=0.05)
        finally:
            stop.append(1)
            t.join()
        self.assertEqual(rc, 0)
        self.assertEqual([x for x in os.listdir(self.d)], [])

    def test_no_answer_withdraws(self):
        rc, out = b.request("restart", "postgresql@14-main.service", timeout=-29.8, ctl_dir=self.d, poll=0.05)
        self.assertEqual(rc, 124)
        self.assertEqual(os.listdir(self.d), [])

    def test_available_needs_the_installer_directory(self):
        self.assertFalse(b.available(os.path.join(self.d, "missing")))
        if os.geteuid() == 0:
            self.assertTrue(b.available(self.d, runner=lambda a, **k: R(0, "active\n")))
            self.assertFalse(b.available(self.d, runner=lambda a, **k: R(3, "inactive\n")))
            os.chmod(self.d, 0o777)
            self.assertFalse(b.available(self.d, runner=lambda a, **k: R(0, "active\n")))


if __name__ == "__main__":
    unittest.main()
