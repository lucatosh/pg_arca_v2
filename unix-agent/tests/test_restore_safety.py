import os, tempfile, unittest
from pg_arca.engine import restore


class ExternalConf(unittest.TestCase):
    def test_debian_conf_cannot_point_back_at_production(self):
        d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, "_conf"))
        conf = os.path.join(d, "_conf", "postgresql.conf")
        open(conf, "w").write("data_directory = '/var/lib/postgresql/16/main'\nhba_file = '/etc/postgresql/16/main/pg_hba.conf'\nident_file = '/etc/postgresql/16/main/pg_ident.conf'\n"
                              "external_pid_file = '/x.pid'\ninclude_dir = 'conf.d'\n  include_if_exists = 'x.conf'\nport = 5432\nshared_buffers = 1GB\n")
        open(os.path.join(d, "_conf", "pg_hba.conf"), "w").write("local all all trust\n")
        restore.install_external_conf(d, ["_conf/postgresql.conf", "_conf/pg_hba.conf"])
        txt = open(os.path.join(d, "postgresql.conf")).read()
        active = [l for l in txt.split("\n") if l.strip() and not l.lstrip().startswith("#")]
        self.assertEqual(active, ["port = 5432", "shared_buffers = 1GB"])
        self.assertIn("pg_arca", txt)
        self.assertTrue(os.path.exists(os.path.join(d, "pg_hba.conf")))

    def test_existing_pgdata_conf_is_left_alone(self):
        d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, "_conf"))
        open(os.path.join(d, "_conf", "postgresql.conf"), "w").write("data_directory='/x'\n")
        open(os.path.join(d, "postgresql.conf"), "w").write("data_directory='/mine'\n")
        restore.install_external_conf(d, ["_conf/postgresql.conf"])
        self.assertEqual(open(os.path.join(d, "postgresql.conf")).read(), "data_directory='/mine'\n")


if __name__ == "__main__":
    unittest.main()
