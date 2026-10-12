"""How a standalone PostgreSQL is restarted from the console (pgrestart.plan/run) - fake /proc trees, fake runner."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca import pgrestart


def tree(cg_pg, cg_me, pid=4242, me=99):
    proc = tempfile.mkdtemp()
    data = tempfile.mkdtemp()
    for p, cg in ((pid, cg_pg), (me, cg_me)):
        os.makedirs(os.path.join(proc, str(p)))
        with open(os.path.join(proc, str(p), "cgroup"), "w") as f:
            f.write(cg)
    with open(os.path.join(data, "postmaster.pid"), "w") as f:
        f.write("%d\n/var/lib/postgresql/14/main\n" % pid)
    return proc, data, me


class R(object):
    def __init__(self, rc=0, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err


class Plan(unittest.TestCase):
    def test_debian_unit(self):
        proc, data, me = tree("0::/system.slice/system-postgresql.slice/postgresql@14-main.service\n", "0::/system.slice/pg-arca-agent.service\n")
        p = pgrestart.plan(data, proc, me)
        self.assertEqual((p["method"], p["unit"]), ("systemd", "postgresql@14-main.service"))

    def test_rhel_unit_cgroup_v1(self):
        proc, data, me = tree("12:pids:/system.slice/postgresql-16.service\n1:name=systemd:/system.slice/postgresql-16.service\n", "1:name=systemd:/system.slice/pg-arca-agent.service\n")
        self.assertEqual(pgrestart.plan(data, proc, me)["unit"], "postgresql-16.service")

    def test_hand_started_while_agent_is_a_service_is_refused(self):
        proc, data, me = tree("0::/user.slice/user-1000.slice/session-3.scope\n", "0::/system.slice/pg-arca-agent.service\n")
        p = pgrestart.plan(data, proc, me)
        self.assertEqual(p["method"], "refuse")
        self.assertIn("by hand", p["why"])

    def test_container_without_systemd(self):
        proc, data, me = tree("0::/\n", "0::/\n")
        self.assertEqual(pgrestart.plan(data, proc, me)["method"], "pg_ctl")

    def test_other_service_is_refused(self):
        proc, data, me = tree("0::/system.slice/myapp-db.service\n", "0::/system.slice/pg-arca-agent.service\n")
        self.assertEqual(pgrestart.plan(data, proc, me)["method"], "refuse")

    def test_not_running(self):
        data = tempfile.mkdtemp()
        self.assertEqual(pgrestart.plan(data, tempfile.mkdtemp(), 1)["method"], "refuse")


class Run(unittest.TestCase):
    def test_polkit_denied_says_what_to_add(self):
        calls = []
        runner = lambda a, **k: (calls.append(a), R(1, "", "Failed to restart postgresql@14-main.service: Interactive authentication required."))[1]
        real_isdir = pgrestart.os.path.isdir
        pgrestart.os.path.isdir = lambda x: True if x == "/etc/polkit-1" else real_isdir(x)
        try:
            with self.assertRaises(RuntimeError) as e:
                pgrestart.run({"method": "systemd", "unit": "postgresql@14-main.service"}, "/d", "", "postgres", runner=runner)
        finally:
            pgrestart.os.path.isdir = real_isdir
        self.assertEqual(calls[0], ["systemctl", "restart", "postgresql@14-main.service"])
        self.assertIn(pgrestart.POLKIT_FILE, str(e.exception))
        self.assertIn('subject.user == "postgres"', str(e.exception))
        self.assertIn("sudo systemctl restart postgresql@14-main.service", str(e.exception))

    def test_without_polkit_says_to_install_it(self):
        runner = lambda a, **k: R(1, "", "Failed to restart postgresql@14-main.service: Access denied")
        real_isdir = pgrestart.os.path.isdir
        pgrestart.os.path.isdir = lambda x: False if x == "/etc/polkit-1" else real_isdir(x)
        try:
            with self.assertRaises(RuntimeError) as e:
                pgrestart.run({"method": "systemd", "unit": "postgresql@14-main.service"}, "/d", "", "postgres", runner=runner)
        finally:
            pgrestart.os.path.isdir = real_isdir
        self.assertIn("polkit is not installed", str(e.exception))
        self.assertIn("Nothing was restarted", str(e.exception))

    def test_pg_ctl_uses_fast_and_wait(self):
        calls = []
        pgrestart.run({"method": "pg_ctl"}, "/srv/pg15/main", "/usr/lib/postgresql/15/bin", "postgres", runner=lambda a, **k: (calls.append((a, k)), R(0))[1], log_dir=tempfile.mkdtemp())
        a, k = calls[0]
        self.assertNotEqual(k.get("stdout"), __import__("subprocess").PIPE, "a pipe would never reach EOF: the postmaster inherits it")
        self.assertTrue(k.get("start_new_session"))
        calls[:] = [a]
        self.assertEqual(calls[0][:6], ["/usr/lib/postgresql/15/bin/pg_ctl", "restart", "-D", "/srv/pg15/main", "-m", "fast"])

    def test_polkit_rule_only_postgres_units(self):
        r = pgrestart.polkit_rule("postgres")
        self.assertIn("manage-units", r)
        self.assertIn('"restart"', r)
        self.assertNotIn('"stop"', r)


class Permission(unittest.TestCase):
    def test_dry_run_knows_when_systemd_will_refuse(self):
        import tempfile
        from pg_arca import pgrestart
        d = tempfile.mkdtemp()
        self.assertIsNone(pgrestart.systemd_permission(euid=0))
        self.assertIn("polkit is not installed", pgrestart.systemd_permission(polkit_dir=os.path.join(d, "none"), euid=1000))
        os.makedirs(os.path.join(d, "polkit-1"))
        self.assertIn("rule", pgrestart.systemd_permission(polkit_dir=os.path.join(d, "polkit-1"), rule_file=os.path.join(d, "r.rules"), euid=1000))
        open(os.path.join(d, "r.rules"), "w").write("x")
        self.assertIsNone(pgrestart.systemd_permission(polkit_dir=os.path.join(d, "polkit-1"), rule_file=os.path.join(d, "r.rules"), euid=1000, running=True))
        self.assertIn("not running", pgrestart.systemd_permission(polkit_dir=os.path.join(d, "polkit-1"), rule_file=os.path.join(d, "r.rules"), euid=1000, running=False))


if __name__ == "__main__":
    unittest.main()
