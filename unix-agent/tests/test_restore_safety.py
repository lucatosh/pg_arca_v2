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


class WalChainAcrossTimelines(unittest.TestCase):
    class _Wal:
        def __init__(self, have): self.have = set(have)
        def has_segment(self, n): return n in self.have

    def test_failover_between_full_and_incr_is_not_a_gap(self):
        from pg_arca.engine.util import wal_name
        seg = 16 * 1024 * 1024
        mk = lambda tl, n: wal_name(tl, n, seg)
        have = [mk(1, n) for n in range(1, 5)] + [mk(2, n) for n in range(4, 8)]            # timeline 2 starts inside segment 4
        full = {"id": "F", "timeline": 1, "start_lsn": "0/1000028", "stop_lsn": "0/2000100"}
        incr = {"id": "I", "timeline": 2, "start_lsn": "0/5000028", "stop_lsn": "0/6000100"}
        ctx = type("C", (), {"wal": self._Wal(have), "seg_size": seg})()
        self.assertEqual(restore.check_wal_for_chain(ctx, [full, incr]), [])
        ctx.wal.have.discard(mk(1, 3))                                                       # a REAL hole is still reported
        self.assertEqual(restore.check_wal_for_chain(ctx, [full, incr]), [mk(2, 3)])


class CopyPreload(unittest.TestCase):
    def test_background_libraries_removed_security_ones_kept(self):
        self.assertEqual(restore.copy_preload_filter("pg_stat_statements, pg_cron,anon"), ("pg_stat_statements,anon", ["pg_cron"]))
        self.assertEqual(restore.copy_preload_filter("$libdir/pglogical,auto_explain"), ("auto_explain", ["$libdir/pglogical"]))
        self.assertEqual(restore.copy_preload_filter("pg_cron"), ("", ["pg_cron"]))
        self.assertEqual(restore.copy_preload_filter("pg_stat_statements"), (None, []))
        self.assertEqual(restore.copy_preload_filter(""), (None, []))
        self.assertEqual(restore.copy_preload_filter(None), (None, []))

    def test_value_read_from_restored_files_when_the_catalog_is_old(self):
        import tempfile, os
        d = tempfile.mkdtemp()
        open(os.path.join(d, "postgresql.conf"), "w").write("shared_preload_libraries = 'pg_stat_statements'   # x\n")
        open(os.path.join(d, "postgresql.auto.conf"), "w").write("shared_preload_libraries = 'pg_cron, pg_stat_statements'\n")
        self.assertEqual(restore._conf_preload(d), "pg_cron, pg_stat_statements")


class PreviousLocations(unittest.TestCase):
    """A migration interrupted while copying a set leaves .mig-<id> in the new location: it must never look like a set (expire would then delete the
    REAL set through the path resolved to the previous location)."""
    def test_work_dirs_are_not_sets_and_retention_stays_home(self):
        import json, tempfile, os
        from pg_arca.engine.repo import Repo
        from pg_arca.engine.ctx import Ctx
        from pg_arca.engine import maintenance
        old, new = tempfile.mkdtemp(), tempfile.mkdtemp()
        meta = {"id": "20261012-100000F", "type": "full", "status": "COMPLETE", "start_time": "2026-10-12T10:00:00Z", "start_lsn": "0/2000028", "timeline": 1}
        for root, name in ((old, meta["id"]), (new, ".mig-" + meta["id"])):
            d = os.path.join(root, "stanza", "main", "backup", name)
            os.makedirs(d)
            json.dump(meta, open(os.path.join(d, "meta.json"), "w"))
        os.makedirs(os.path.join(new, "cas")); os.makedirs(os.path.join(new, "stanza", "main", "locks"), exist_ok=True)
        newer = dict(meta, id="20261012-120000F", start_time="2026-10-12T12:00:00Z", start_lsn="0/5000028")      # a full made in the new location since
        d = os.path.join(new, "stanza", "main", "backup", newer["id"]); os.makedirs(d); json.dump(newer, open(os.path.join(d, "meta.json"), "w"))
        r = Repo(new, "main", previous=[old])
        self.assertEqual([m["id"] for m in r.own_sets()], [newer["id"]])
        self.assertEqual([(m["id"], m.get("location")) for m in r.sets()], [(meta["id"], os.path.realpath(old)), (newer["id"], None)])
        self.assertEqual(r.own_path("backup", "x"), os.path.join(os.path.realpath(new), "stanza", "main", "backup", "x"))
        wal = tempfile.mkdtemp()
        ctx = Ctx(None, "", new, "main", wal, tempfile.mkdtemp(), retention_full=1, repo_previous=[old])
        maintenance.expire(ctx, retention_full=1)
        self.assertTrue(os.path.exists(os.path.join(old, "stanza", "main", "backup", meta["id"], "meta.json")), "the previous location is untouched")


if __name__ == "__main__":
    unittest.main()
