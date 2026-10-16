"""Layout independence: nothing may assume Debian paths, the `postgres` role, or that the PostgreSQL binaries are on the PATH. No PostgreSQL needed."""
import json
import os
import stat
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pg_arca import pgaccess, wal_archive
from pg_arca.discovery import ClusterDiscoveryEngine


def exe(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("#!/bin/sh\n")
    os.chmod(path, 0o755)
    return path


class FindTool(unittest.TestCase):
    def test_order_configured_then_running_instance_then_path_then_vendor_newest_first(self):
        t = tempfile.mkdtemp()
        a, b = exe(t + "/cfg/bin/psql"), exe(t + "/inst/bin/psql")
        self.assertEqual(pgaccess.find_tool("psql", {"pg_bin_dir": t + "/cfg/bin"}, {"bin_dir": t + "/inst/bin"}, which=lambda n: "/x/psql"), a)
        self.assertEqual(pgaccess.find_tool("psql", {}, {"bin_dir": t + "/inst/bin"}, which=lambda n: "/x/psql"), b)
        self.assertEqual(pgaccess.find_tool("psql", {}, {}, which=lambda n: "/x/psql"), "/x/psql")
        v14, v16 = exe(t + "/usr/pgsql-14/bin/psql"), exe(t + "/usr/pgsql-16/bin/psql")
        self.assertEqual(pgaccess.find_tool("psql", {}, {}, which=lambda n: None, globber=lambda pat: [os.path.dirname(v14), os.path.dirname(v16)] if "pgsql-*" in pat else []), v16)
        self.assertEqual(pgaccess.find_tool("psql", {}, {}, which=lambda n: None, globber=lambda pat: []), "psql")        # nothing found: the OS reports it

    def test_a_non_executable_file_is_ignored(self):
        t = tempfile.mkdtemp()
        p = exe(t + "/bin/psql")
        os.chmod(p, 0o644)
        self.assertEqual(pgaccess.find_tool("psql", {"pg_bin_dir": t + "/bin"}, {}, which=lambda n: None, globber=lambda pat: []), "psql")

    def test_major_from_odd_directory_names(self):
        for path, major in (("/usr/lib/postgresql/16/bin", 16), ("/usr/pgsql-15/bin", 15), ("/opt/pgsql-14.5/bin", 14), ("/opt/edb/as16/bin", 16), ("/opt/pg/bin", 0)):
            self.assertEqual(pgaccess._major_key(path), major, path)


class Role(unittest.TestCase):
    class Client:
        def __init__(self, ok):
            self.user, self.ok, self.tried = "postgres", ok, []

        def ping(self):
            self.tried.append(self.user)
            return self.user in self.ok

    def test_explicit_role_is_the_only_candidate(self):
        self.assertEqual(pgaccess.candidate_users({"pg_user": "dba"}, {"data_directory": "/"}), ["dba"])

    def test_owner_of_pgdata_comes_first_then_postgres(self):
        t = tempfile.mkdtemp()
        me = pgaccess.data_dir_owner(t)
        c = pgaccess.candidate_users({}, {"data_directory": t})
        self.assertEqual(c[0], me if me != "root" else "postgres")
        self.assertIn("postgres", c)
        self.assertNotIn("root", c)

    def test_first_role_that_connects_wins_and_is_kept(self):
        t = tempfile.mkdtemp()
        me = pgaccess.data_dir_owner(t)
        if me in (None, "root", "postgres"):
            self.skipTest("needs a data directory owned by a non-postgres, non-root user")
        c = self.Client(ok={"postgres"})
        self.assertEqual(pgaccess.resolve_user(c, {}, {"data_directory": t}), "postgres")
        self.assertEqual(c.tried[0], me)
        c2 = self.Client(ok=set())
        pgaccess.resolve_user(c2, {}, {"data_directory": t})
        self.assertIn(c2.user, pgaccess.candidate_users({}, {"data_directory": t}))


class WalArchiveSettings(unittest.TestCase):
    def test_console_overrides_reach_archive_command(self):
        t = tempfile.mkdtemp()
        json.dump({"wal_archive_dir": "/a", "compression": "zlib"}, open(t + "/agent.conf", "w"))
        old = os.environ.get("PG_ARCA_CONF"), os.environ.pop("WAL_ARCHIVE_DIR", None)
        os.environ["PG_ARCA_CONF"] = t + "/agent.conf"
        try:
            self.assertEqual(wal_archive._settings()[0], "/a")
            json.dump({"wal_archive_dir": "/b"}, open(t + "/agent.local.json", "w"))
            self.assertEqual(wal_archive._settings()[0], "/b")                    # agent.local.json (console-managed) beats agent.conf
            self.assertEqual(wal_archive._settings()[1], "zlib")
            os.environ["WAL_ARCHIVE_DIR"] = "/c"
            self.assertEqual(wal_archive._settings()[0], "/c")                    # environment beats both
        finally:
            os.environ.pop("WAL_ARCHIVE_DIR", None)
            if old[0] is None:
                os.environ.pop("PG_ARCA_CONF", None)
            else:
                os.environ["PG_ARCA_CONF"] = old[0]

    def test_unknown_override_keys_are_ignored(self):
        t = tempfile.mkdtemp()
        json.dump({"wal_archive_dir": "/a"}, open(t + "/agent.conf", "w"))
        json.dump({"auth_token": "x", "wal_archive_dir": ""}, open(t + "/agent.local.json", "w"))
        os.environ["PG_ARCA_CONF"] = t + "/agent.conf"
        try:
            self.assertEqual(wal_archive._conf().get("wal_archive_dir"), "/a")
            self.assertNotIn("auth_token", wal_archive._conf())
        finally:
            os.environ.pop("PG_ARCA_CONF", None)

    def test_named_config_missing_fails_instead_of_defaults(self):
        """an instance agent's archive_command names its config: gone (uninstalled, unreadable) -> the archive fails (PostgreSQL retries), never the
        defaults, which are ANOTHER cluster's archive (independent review)"""
        old = os.environ.get("PG_ARCA_CONF"), os.environ.pop("WAL_ARCHIVE_DIR", None)
        os.environ["PG_ARCA_CONF"] = "/nonexistent/b/agent.conf"
        try:
            with self.assertRaises(wal_archive.ConfError):
                wal_archive._settings()
            self.assertEqual(wal_archive.main(["x", "archive", "/nonexistent/p", "000000010000000000000001"]), 1)
            self.assertEqual(wal_archive.main(["x", "get", "000000010000000000000001", "/nonexistent/p"]), 126)
            os.environ["WAL_ARCHIVE_DIR"] = "/w"                                 # explicit directory (the restore copies' restore_command): fine
            self.assertEqual(wal_archive._settings()[0], "/w")
        finally:
            os.environ.pop("WAL_ARCHIVE_DIR", None)
            if old[0] is None:
                os.environ.pop("PG_ARCA_CONF", None)
            else:
                os.environ["PG_ARCA_CONF"] = old[0]


class ArchiveCommand(unittest.TestCase):
    def _ex(self, conf_path):
        from pg_arca.executor import OperationExecutor as Executor
        ex = Executor.__new__(Executor)
        ex.config = {"_conf_path": conf_path}
        return ex

    def test_standard_layout_is_a_plain_command(self):
        self.assertEqual(self._ex("/etc/pg-arca/agent.conf")._archive_env(), "")

    def test_custom_config_is_carried_into_archive_command(self):
        e = self._ex("/srv/my conf/agent.conf")._archive_env()
        self.assertTrue(e.startswith("env PG_ARCA_CONF="))
        self.assertIn("'/srv/my conf/agent.conf'", e)

    def test_wal_tool_must_exist(self):
        from pg_arca.executor import OpError
        ex = self._ex("/etc/pg-arca/agent.conf")
        ex.config["wal_bin"] = "/nonexistent/pg-arca-wal"
        old = os.environ.get("PG_ARCA_WAL_BIN")
        t = exe(tempfile.mkdtemp() + "/pg-arca-wal")
        os.environ["PG_ARCA_WAL_BIN"] = t
        try:
            self.assertEqual(ex._wal_tool(), t)                                     # the first candidate that exists wins, a missing configured one is skipped
        finally:
            if old is None:
                os.environ.pop("PG_ARCA_WAL_BIN", None)
            else:
                os.environ["PG_ARCA_WAL_BIN"] = old


class BinDir(unittest.TestCase):
    def test_from_the_started_command_line(self):
        t = tempfile.mkdtemp()
        p = exe(t + "/odd/place/bin/postgres")
        self.assertEqual(ClusterDiscoveryEngine._bin_dir({"pid": None, "cmdline": p + " -D /data"}, "16"), os.path.dirname(p))

    def test_from_the_running_process(self):
        # this very process: /proc/<pid>/exe is the python interpreter - proves the readlink path is used before any naming convention
        d = ClusterDiscoveryEngine._bin_dir({"pid": os.getpid(), "cmdline": None}, "16")
        self.assertEqual(d, os.path.dirname(os.path.realpath(sys.executable)) if os.path.islink("/proc/%d/exe" % os.getpid()) else d)

    def test_unknown_gives_none_or_a_matching_major(self):
        d = ClusterDiscoveryEngine._bin_dir({"pid": None, "cmdline": None}, "99")
        self.assertIsNone(d)


class Sysres(unittest.TestCase):
    def _cg(self, files, proc="0::/sys.slice/app.service\n"):
        from pg_arca import sysres
        root = tempfile.mkdtemp()
        for rel, val in files.items():
            os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True)
            open(os.path.join(root, rel), "w").write(val)
        pc = os.path.join(root, "proc_cgroup")
        open(pc, "w").write(proc)
        return sysres, root, pc

    def test_cgroup_v2_memory_limit_on_a_parent_slice(self):
        sysres, root, pc = self._cg({"sys.slice/memory.max": str(2 << 30), "sys.slice/memory.current": str(1 << 30), "sys.slice/app.service/memory.max": "max"})
        self.assertEqual(sysres.memory_limit(root, pc), (2 << 30, 1 << 30))

    def test_no_limit_means_host_numbers(self):
        sysres, root, pc = self._cg({"memory.max": "max"}, "0::/\n")
        self.assertEqual(sysres.memory_limit(root, pc), (None, None))
        mi = os.path.join(root, "meminfo")
        open(mi, "w").write("MemTotal:  8000000 kB\nMemAvailable:  4000000 kB\n")
        m = sysres.memory(mi, root=root, proc_cgroup=pc)
        self.assertEqual((m["total"], m["available"], m["limited"]), (8000000 * 1024, 4000000 * 1024, False))

    def test_limited_memory_caps_total_and_available(self):
        sysres, root, pc = self._cg({"sys.slice/app.service/memory.max": str(1 << 30), "sys.slice/app.service/memory.current": str(256 << 20)})
        mi = os.path.join(root, "meminfo")
        open(mi, "w").write("MemTotal:  64000000 kB\nMemAvailable:  60000000 kB\n")
        m = sysres.memory(mi, root=root, proc_cgroup=pc)
        self.assertEqual((m["total"], m["available"], m["limited"]), (1 << 30, 768 << 20, True))

    def test_cpu_quota_v2_and_v1(self):
        sysres, root, pc = self._cg({"sys.slice/app.service/cpu.max": "150000 100000"})
        self.assertLessEqual(sysres.cpu_count(root, pc), 2)
        sysres, root, pc = self._cg({"cpu/sys.slice/app.service/cpu.cfs_quota_us": "50000", "cpu/sys.slice/app.service/cpu.cfs_period_us": "100000"}, "4:cpu,cpuacct:/sys.slice/app.service\n")
        self.assertEqual(sysres.cpu_count(root, pc), 1)

    def test_v1_no_limit_value_is_not_a_limit(self):
        sysres, root, pc = self._cg({"memory/memory.limit_in_bytes": "9223372036854771712"}, "5:memory:/\n")
        self.assertEqual(sysres.memory_limit(root, pc), (None, None))


class SocketPath(unittest.TestCase):
    def test_short_path_is_kept_and_a_deep_one_is_moved(self):
        from pg_arca.engine import ephemeral
        base = tempfile.mkdtemp()
        p = os.path.join(base, ".s")
        self.assertEqual(ephemeral.short_socket_dir(p), p)
        deep = os.path.join(base, *(["very_long_directory_name_for_a_nested_volume"] * 4), ".s")
        self.assertGreater(len(os.path.join(deep, ".s.PGSQL.65535")), 100)
        d = ephemeral.short_socket_dir(deep)
        try:
            self.assertNotEqual(d, deep)
            self.assertLessEqual(len(os.path.join(d, ".s.PGSQL.65535")), 100)
            self.assertEqual(stat.S_IMODE(os.stat(d).st_mode), 0o700)
        finally:
            os.rmdir(d)


class Links(unittest.TestCase):
    def test_links_inside_pgdata_are_reported_not_silently_lost(self):
        from pg_arca.engine import pgdata
        d = tempfile.mkdtemp()
        for sub in ("base", "pg_wal", "pg_tblspc", "global", "log"):
            os.makedirs(os.path.join(d, sub))
        ext = tempfile.mkdtemp()
        open(os.path.join(ext, "postgresql.conf"), "w").close()
        os.symlink(os.path.join(ext, "postgresql.conf"), os.path.join(d, "postgresql.conf"))     # config kept elsewhere through a link
        os.symlink(ext, os.path.join(d, "pg_tblspc", "16384"))                                   # tablespace: handled, not reported
        os.symlink(ext, os.path.join(d, "global_ext"))                                           # a data directory elsewhere: reported
        got = dict(pgdata.skipped_links(d))
        self.assertIn("postgresql.conf", got)
        self.assertIn("global_ext", got)
        self.assertNotIn("pg_tblspc/16384", got)
        self.assertEqual(pgdata.skipped_links(tempfile.mkdtemp()), [])


class LogFiles(unittest.TestCase):
    def test_log_file_follows_the_instances_own_naming(self):
        from pg_arca.runtime import LogShipper
        d, ld = tempfile.mkdtemp(), None
        ld = os.path.join(d, "mylogs")
        os.makedirs(ld)
        open(os.path.join(ld, "pg-2026-10-11_010203"), "w").close()                  # no .log suffix: only log_filename tells
        pdir = os.path.join(d, "patroni-logs")
        os.makedirs(pdir)
        open(os.path.join(pdir, "patroni.log"), "w").close()
        rt = types.SimpleNamespace(instance={"data_directory": d, "settings": {"log_directory": ld, "log_filename": "pg-%Y-%m-%d_%H%M%S"}}, patroni_info={"log_dir": pdir})
        files = LogShipper({}, rt)._files()
        self.assertTrue(any(f.endswith("pg-2026-10-11_010203") for f in files), files)
        self.assertTrue(any(f.endswith("patroni.log") for f in files), files)


class Python36(unittest.TestCase):
    """RHEL 8 / Rocky 8 / Amazon Linux run Python 3.6 by default: the agent must not use anything newer (it would die at import or at the first call, on the customer's machine)."""
    BAD_ATTRS = {"fromisoformat", "removeprefix", "removesuffix", "isascii", "is_relative_to", "cached_property", "nullcontext", "time_ns", "isqrt"}
    BAD_KW = {"capture_output", "text", "missing_ok", "dirs_exist_ok", "process_group"}
    CALLS = {"run", "Popen", "check_output", "check_call", "call"}

    def test_no_syntax_or_api_newer_than_3_6(self):
        import ast
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        root = os.path.join(here, "pg_arca")
        bad = []
        paths = [os.path.join(dp, fn) for dp, _dn, fs in os.walk(root) for fn in fs if fn.endswith(".py")]
        paths += [os.path.join(here, n) for n in ("pg-arca-cli", "pg-arca-agent.py", "pg-arca-wal") if os.path.exists(os.path.join(here, n))]
        for path in paths:
            if True:
                with open(path, encoding="utf-8") as f:
                    src = f.read()
                tree = ast.parse(src)
                for n in ast.walk(tree):
                    where = "%s:%d" % (os.path.relpath(path, root), getattr(n, "lineno", 0))
                    if getattr(ast, "NamedExpr", None) and isinstance(n, ast.NamedExpr):   # (on 3.6/3.7 itself the walrus cannot even parse)
                        bad.append(where + " walrus operator")
                    elif isinstance(n, ast.Attribute) and n.attr in self.BAD_ATTRS:
                        bad.append("%s .%s (Python >= 3.7)" % (where, n.attr))
                    elif isinstance(n, ast.Call):
                        fname = n.func.attr if isinstance(n.func, ast.Attribute) else getattr(n.func, "id", "")
                        if fname in self.CALLS:
                            bad.extend("%s %s(%s=...) (Python >= 3.7)" % (where, fname, k.arg) for k in n.keywords if k.arg in self.BAD_KW)
                        if fname == "add_subparsers" and any(k.arg == "required" for k in n.keywords):
                            bad.append(where + " add_subparsers(required=...) (Python >= 3.7)")
                    elif isinstance(n, ast.arguments) and getattr(n, "posonlyargs", None):
                        bad.append(where + " positional-only parameters")
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main()


class DeliveryAddress(unittest.TestCase):
    """`into` (where a restored database is delivered) is an operation parameter: it may choose host/port/user/password/dbname, never the
    directory the agent runs executables from."""
    def test_into_cannot_choose_the_binaries(self):
        from pg_arca.engine.pgsession import PgConn
        from pg_arca.engine.util import EngineError
        c = PgConn.from_dict({"host": "db2", "port": "5433", "user": "app", "password": "p", "dbname": "x", "bindir": "/tmp/evil"}, "/usr/lib/postgresql/16/bin")
        self.assertEqual(c.bindir, "/usr/lib/postgresql/16/bin"); self.assertEqual(c.exe("psql"), "/usr/lib/postgresql/16/bin/psql")
        self.assertEqual((c.host, c.port, c.user, c.dbname), ("db2", 5433, "app", "x"))
        with self.assertRaises(EngineError):
            PgConn.from_dict({"port": "54;33"}, "/x")
