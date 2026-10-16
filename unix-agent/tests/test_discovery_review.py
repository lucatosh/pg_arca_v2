"""Discovery (independent review 16/10 night): which processes are PostgreSQL / Patroni, which data directory a postmaster serves, whether a postmaster.pid
is alive, how a TCP-only instance is reached, which instance and which Patroni the agent binds to, patroni.yml without PyYAML, the pg_waldump of the
WAL's own major and binaries replaced in place."""
import http.server
import json
import os
import shutil
import socket
import stat
import struct
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca import discovery
from pg_arca.discovery import ClusterDiscoveryEngine, advise


class NoPyYAML(object):
    def __enter__(self):
        self.old = sys.modules.get("yaml", "absent")
        sys.modules["yaml"] = None                 # import yaml -> ImportError: the stdlib fallback parser
        return discovery.parse_simple_yaml

    def __exit__(self, *a):
        if self.old == "absent":
            sys.modules.pop("yaml", None)
        else:
            sys.modules["yaml"] = self.old


class Yaml(unittest.TestCase):
    # expected values: what PyYAML 6 returns for the same documents (checked side by side when the fixes were written)
    def test_anchor_and_alias(self):
        doc = "scope: main\nx-auth: &restauth\n  username: patroni\n  password: s3cret\nrestapi:\n  listen: 10.0.0.5:8008\n  authentication: *restauth\n"
        with NoPyYAML() as p:
            y = p(doc)
        self.assertEqual(y["restapi"]["authentication"], {"username": "patroni", "password": "s3cret"})
        self.assertEqual(y["restapi"]["listen"], "10.0.0.5:8008")
        self.assertNotIn("username", y, "the anchored map's keys do not leak into the parent")

    def test_block_scalars_do_not_leak_keys(self):
        doc = ("bootstrap:\n  post_init: |\n    #!/bin/sh\n    data_dir: /tmp/x\npostgresql:\n  pg_hba: |\n    host all all 0.0.0.0/0 scram-sha-256\n"
               "  data_dir: /pgdata/16/data\nrestapi:\n  certfile: >\n    /etc/patroni/tls/server.pem\n  listen: 10.0.0.5:8008\n")
        with NoPyYAML() as p:
            y = p(doc)
        self.assertEqual(y["bootstrap"], {"post_init": "#!/bin/sh\ndata_dir: /tmp/x\n"})
        self.assertEqual(y["postgresql"]["data_dir"], "/pgdata/16/data")
        self.assertEqual(y["restapi"]["certfile"], "/etc/patroni/tls/server.pem\n")

    def test_quotes_comments_lists_and_merge(self):
        doc = ("scope: \"a: b\"\nrestapi:\n  listen: '0.0.0.0:8008'   # wildcard\n  authentication:\n    username: 'pat#roni'\n    password: \"pa ss #1\"\n"
               "etcd3:\n  hosts:\n    - 10.0.0.1:2379\n    - 10.0.0.2:2379\ntags:\n  - name: a\n    value: 1\n  - name: b\n"
               "postgresql:\n    pg_hba:\n    - host all all 0.0.0.0/0 md5\n    parameters:\n      archive_mode: on\n    data_dir: /d\n"
               "base: &b\n  ttl: 30\n  loop_wait: 10\nother:\n  <<: *b\n  ttl: 40\nnul: ~\n")
        with NoPyYAML() as p:
            y = p(doc)
        self.assertEqual(y["scope"], "a: b")
        self.assertEqual(y["restapi"], {"listen": "0.0.0.0:8008", "authentication": {"username": "pat#roni", "password": "pa ss #1"}})
        self.assertEqual(y["etcd3"]["hosts"], ["10.0.0.1:2379", "10.0.0.2:2379"])
        self.assertEqual(y["tags"], [{"name": "a", "value": 1}, {"name": "b"}])
        self.assertEqual(y["postgresql"], {"pg_hba": ["host all all 0.0.0.0/0 md5"], "parameters": {"archive_mode": True}, "data_dir": "/d"})
        self.assertEqual(y["other"], {"ttl": 40, "loop_wait": 10})
        self.assertIsNone(y["nul"])

    def test_same_result_as_pyyaml_when_installed(self):
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML not installed")
        doc = "scope: main\nrestapi:\n  listen: 0.0.0.0:8008\n  authentication: &a\n    username: u\n    password: \"p#1\"\nctl:\n  <<: *a\n  cacert: /ca.pem\n"
        ref = yaml.safe_load(doc)
        with NoPyYAML() as p:
            self.assertEqual(p(doc), ref)


class Processes(unittest.TestCase):
    def test_classification(self):
        c = ClusterDiscoveryEngine._classify
        self.assertEqual(c(["/usr/edb/as16/bin/edb-postgres", "-D", "/var/lib/edb/as16/data"]), "postgres")
        self.assertEqual(c(["edb-postgres: checkpointer"]), "postgres")
        self.assertEqual(c(["postgres: 16/main: walwriter "]), "postgres")
        self.assertEqual(c(["/usr/bin/python3", "-s", "/usr/bin/patroni", "/etc/patroni/patroni.yml"]), "patroni")
        self.assertEqual(c(["/usr/libexec/platform-python", "/usr/bin/patroni", "/etc/patroni.yml"]), "patroni")
        self.assertEqual(c(["python3.11", "-W", "ignore", "-m", "patroni", "/etc/patroni.yml"]), "patroni")
        self.assertIsNone(c(["/usr/bin/postgres_exporter", "--web.listen-address=:9187"]), "an exporter is not a server")
        self.assertIsNone(c(["/usr/bin/python3", "-c", "import patroni"]))
        self.assertEqual(c(["/usr/bin/etcd", "--name", "e1"]), "etcd")


class PostmasterDataDir(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.data = os.path.join(self.d, "var-pg16")
        self.conf = os.path.join(self.d, "etc-pg16")
        os.makedirs(self.data)
        os.makedirs(self.conf)
        open(os.path.join(self.data, "PG_VERSION"), "w").write("16\n")
        open(os.path.join(self.conf, "postgresql.conf"), "w").write("data_directory = '%s'\n" % self.data)
        self.e = ClusterDiscoveryEngine()

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def test_cwd_is_the_authority(self):
        self.assertEqual(self.e._postmaster_pgdata({"argv": ["postgres", "-D", "data"], "cwd": self.data}), self.data)

    def test_relative_d_resolved_against_the_process_not_the_agent(self):
        p = {"argv": ["postgres", "-D", "var-pg16"], "cwd": None}
        self.assertIsNone(self.e._postmaster_pgdata(p), "cwd unknown: a relative -D cannot be placed (never the agent's own directory)")
        cwd = os.getcwd()
        os.chdir(self.d)
        try:
            self.assertIsNone(self.e._postmaster_pgdata(p))
        finally:
            os.chdir(cwd)

    def test_configuration_directory_layouts(self):
        for argv in (["postgres", "-D", self.conf, "--data-directory=" + self.data],
                     ["postgres", "-D", self.conf, "-c", "data_directory=" + self.data],
                     ["postgres", "-D", self.conf]):                       # data_directory read from the configuration directory's postgresql.conf
            self.assertEqual(self.e._postmaster_pgdata({"argv": argv, "cwd": None}), self.data, argv)


class PidFile(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        open(os.path.join(self.d, "PG_VERSION"), "w").write("16\n")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _pid(self, pid, port=55432, sockdir=""):
        with open(os.path.join(self.d, "postmaster.pid"), "w") as f:
            f.write("%d\n%s\n1700000000\n%d\n%s\n*\n" % (pid, self.d, port, sockdir))

    def test_reused_pid_is_not_a_live_postmaster(self):
        self._pid(os.getpid())                         # alive, but this test runner - not a postgres working in this directory
        self.assertFalse(ClusterDiscoveryEngine._pid_alive_from_file(self.d))

    def test_missing_pid_is_dead(self):
        self._pid(4194303)
        self.assertFalse(ClusterDiscoveryEngine._pid_alive_from_file(self.d))

    def test_server_in_another_pid_namespace_answers_on_its_socket(self):
        sockdir = tempfile.mkdtemp()
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(os.path.join(sockdir, ".s.PGSQL.55432"))
        srv.listen(1)
        try:
            self._pid(4194303, 55432, sockdir)
            self.assertTrue(ClusterDiscoveryEngine._pid_alive_from_file(self.d))
        finally:
            srv.close()
            shutil.rmtree(sockdir, ignore_errors=True)


class ConnectHost(unittest.TestCase):
    def test_tcp_only_instances(self):
        h = ClusterDiscoveryEngine._connect_host
        d = tempfile.mkdtemp()
        try:
            self.assertEqual(h(d, "*"), d)
            self.assertEqual(h("", "*"), "127.0.0.1")
            self.assertEqual(h(None, "0.0.0.0"), "127.0.0.1")
            self.assertEqual(h("/run/not/here", "::"), "::1", "a socket directory of another mount namespace is not usable")
            self.assertEqual(h("", "10.0.0.5"), "10.0.0.5")
            self.assertEqual(h("", "'10.0.0.5, 127.0.0.1'"), "10.0.0.5")
        finally:
            shutil.rmtree(d)


class Binding(unittest.TestCase):
    def setUp(self):
        from pg_arca import runtime, pgaccess
        self.runtime = runtime
        self.d = tempfile.mkdtemp()
        self.state = os.path.join(self.d, "state")
        os.makedirs(self.state)
        self.pg16 = os.path.join(self.d, "pg16")
        os.makedirs(self.pg16)
        self.rep = {"postgres_instances": [
            {"data_directory": "/var/lib/postgresql/14/main", "running": True, "port_listening": True, "port": 5432, "socket_directory": None,
             "connect": {"host": "127.0.0.1"}, "bin_dir": None},
            {"data_directory": self.pg16, "running": False, "port_listening": False, "port": 5433, "socket_directory": None, "connect": {"host": "127.0.0.1"}}],
            "patroni_clusters": [{"scope": "other", "data_dir": "/var/lib/postgresql/14/main", "restapi_url": "http://127.0.0.1:8008", "restapi_port": 8008, "config_path": None}]}
        self._scan = ClusterDiscoveryEngine.scan_all
        self._ru = pgaccess.resolve_user
        rep = self.rep
        ClusterDiscoveryEngine.scan_all = lambda s: json.loads(json.dumps(rep))
        pgaccess.resolve_user = lambda *a, **k: "postgres"

    def tearDown(self):
        from pg_arca import pgaccess
        ClusterDiscoveryEngine.scan_all = self._scan
        pgaccess.resolve_user = self._ru
        shutil.rmtree(self.d, ignore_errors=True)

    def rt(self, **cfg):
        cfg.setdefault("state_dir", self.state)
        cfg.setdefault("node_role", "database")
        return self.runtime.Runtime(cfg)

    def test_explicit_data_directory_never_falls_back_to_another_instance(self):
        r = self.rt(pg_data=os.path.join(self.d, "elsewhere"))
        self.assertIsNone(r.instance)
        self.assertFalse(r.patroni.configured, "nor binds the other instance's Patroni")
        self.assertTrue(any("elsewhere" in w for w in r.report.get("warnings", [])))
        r2 = self.rt(pg_data=self.pg16)
        self.assertEqual(r2.instance["data_directory"], self.pg16, "found even though stopped")
        self.assertFalse(r2.patroni.configured, "the Patroni of the 14 is not the 16's")

    def test_the_served_instance_stays_while_stopped(self):
        json.dump({"data_directory": self.pg16}, open(os.path.join(self.state, "instance.json"), "w"))
        r = self.rt()
        self.assertEqual(r.instance["data_directory"], self.pg16)
        self.assertTrue(any(f["code"] == "BOUND_STOPPED" for f in r.report.get("findings", [])))

    def test_first_start_takes_the_running_one_and_its_patroni(self):
        r = self.rt()
        self.assertEqual(r.instance["data_directory"], "/var/lib/postgresql/14/main")
        self.assertEqual(r.patroni_info["scope"], "other")
        self.assertEqual(r.db.host, "127.0.0.1", "no socket directory: TCP")
        self.assertIsNone(r.db.socket_dir)

    def test_lone_patroni(self):
        pp = self.runtime.Runtime._pick_patroni
        a = {"data_directory": "/a"}
        self.assertIsNone(pp(a, [{"data_dir": "/b"}], 1), "another data directory: never")
        self.assertEqual(pp(a, [{"data_dir": None, "scope": "s"}], 1)["scope"], "s", "configuration unreadable, one instance: that one")
        self.assertIsNone(pp(a, [{"data_dir": None}], 2), "unreadable and several instances: cannot tell")
        self.assertIsNone(pp(a, [{"data_dir": "/x"}, {"data_dir": "/y"}], 1))


class PatroniProbe(unittest.TestCase):
    def test_connect_address_used_when_the_listen_address_does_not_answer(self):
        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                body = {"/patroni": {"state": "running", "role": "master", "patroni": {"version": "3.3.0"}},
                        "/cluster": {"members": [{"name": "n1", "role": "leader", "state": "running"}], "scope": "s"}}.get(self.path, {})
                b = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)
        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        d = tempfile.mkdtemp()
        try:
            y = os.path.join(d, "patroni.yml")
            open(y, "w").write("scope: s\nname: n1\nrestapi:\n  listen: 127.0.0.2:%d\n  connect_address: 127.0.0.1:%d\npostgresql:\n  data_dir: /d\n" % (port, port))
            out = ClusterDiscoveryEngine()._discover_patroni([{"pid": 0, "name": "patroni", "argv": ["patroni", y]}], [])
            self.assertEqual(out[0]["restapi_url"], "http://127.0.0.1:%d" % port)
            self.assertTrue(out[0]["rest_reachable"])
            self.assertEqual(out[0]["leader"], "n1")
        finally:
            srv.shutdown()
            shutil.rmtree(d, ignore_errors=True)

    def test_unreachable_api_is_a_finding(self):
        f = advise({"toolchain": {"psql": "x", "pg_waldump": "x", "python_zstandard": "x"}, "postgres_instances": [],
                    "patroni_clusters": [{"scope": "s", "rest_reachable": False, "restapi_url": "https://10.0.0.5:8008"}]})
        self.assertEqual([x["code"] for x in f], ["PATRONI_REST"])


class Binaries(unittest.TestCase):
    def test_wal_major_from_the_page_magic(self):
        from pg_arca.pgcompat import wal_major
        d = tempfile.mkdtemp()
        try:
            for magic, major in ((0xD10D, 14), (0xD113, 16), (0xD116, 17), (0x1234, None)):
                f = os.path.join(d, "seg")
                open(f, "wb").write(struct.pack("<H", magic) + b"\0" * 30)
                self.assertEqual(wal_major(f), major)
        finally:
            shutil.rmtree(d)

    def test_waldump_of_the_wal_major(self):
        from pg_arca.engine import ephcfg
        from pg_arca.engine.ctx import Ctx
        d = tempfile.mkdtemp()
        real = ephcfg.pick_bindir
        try:
            b14 = os.path.join(d, "14", "bin")
            os.makedirs(b14)
            open(os.path.join(b14, "pg_waldump"), "w").close()
            seg = os.path.join(d, "000000010000000000000001")
            open(seg, "wb").write(struct.pack("<H", 0xD10D) + b"\0" * 30)
            ephcfg.pick_bindir = lambda major, eph=None, default_bindir="", private_root=None: (b14, "scan") if major == 14 else (default_bindir, "node")
            ctx = Ctx.__new__(Ctx)
            ctx.eph = {}

            class C(object):
                bindir = "/usr/lib/postgresql/16/bin"

                def exe(self, p):
                    return os.path.join(self.bindir, p)
            ctx.conn = C()
            self.assertEqual(ctx.waldump(seg), os.path.join(b14, "pg_waldump"))
        finally:
            ephcfg.pick_bindir = real
            shutil.rmtree(d)

    def test_binary_replaced_in_place_is_read_again(self):
        from pg_arca.pgcompat import binary_profile
        d = tempfile.mkdtemp()
        try:
            b = os.path.join(d, "pg_ctl")
            open(b, "w").write("#!/bin/sh\necho 'pg_ctl (PostgreSQL) 16.3'\n")
            os.chmod(b, 0o755)
            self.assertEqual(binary_profile(b).label, "16")
            os.unlink(b)                                       # a package upgrade: new file, same path
            open(b, "w").write("#!/bin/sh\necho 'pg_ctl (PostgreSQL) 17.1'\n")
            os.chmod(b, 0o755)
            self.assertEqual(binary_profile(b).label, "17")
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
