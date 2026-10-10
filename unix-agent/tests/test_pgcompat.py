import os, sys, tempfile, unittest, datetime
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca import pgcompat as C


class Parse(unittest.TestCase):
    def test_every_spelling_of_a_version(self):
        cases = {"16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)": 160015, "16": 160000, "160015": 160015, "9.6.24": 90624, "9.6": 90600, "17beta1": 170000, "18devel": 180000,
                 "15.4 - Percona Distribution": 150004, "14.9 (Debian 14.9-1.pgdg120+1)": 140009, "12.22": 120022, "10.23": 100023, "11": 110000, "19.0": 190000, " v16.1 ": 160001,
                 "15.5 (EnterpriseDB Advanced Server 15.5.0)": 150005}
        for text, num in cases.items():
            self.assertEqual(C.parse_version(text), num, text)
        for bad in ("", "abc", None, "version?"):
            with self.assertRaises(C.VersionError):
                C.parse_version(bad)

    def test_majors_and_labels(self):
        self.assertEqual((C.Profile(90624).major, C.Profile(90624).label), (9.6, "9.6"))
        self.assertEqual((C.Profile(160015).major, C.Profile(160015).label), (16, "16"))

    def test_from_pgdata_and_binary(self):
        d = tempfile.mkdtemp()
        for text, label in (("16\n", "16"), ("9.6\n", "9.6"), ("12\n", "12")):
            open(os.path.join(d, "PG_VERSION"), "w").write(text)
            self.assertEqual(C.Profile.from_pgdata(d).label, label)
        fake = os.path.join(d, "pg_waldump")
        open(fake, "w").write("#!/bin/sh\necho 'pg_waldump (PostgreSQL) 14.9 (Debian 14.9-1)'\n"); os.chmod(fake, 0o755)
        self.assertEqual(C.Profile.from_binary(fake).label, "14")


class Tiers(unittest.TestCase):
    def test_tiers(self):
        t = lambda n: C.Profile(n).tier
        self.assertEqual([t(90624), t(100023), t(110022), t(120022), t(130000), t(170000), t(180005), t(190000), t(250000)],
                         ["unsupported", "legacy", "legacy", "supported", "supported", "supported", "supported", "newer", "newer"])

    def test_eol_dates_follow_the_policy(self):
        self.assertEqual(C.eol_date(12), datetime.date(2024, 11, 14))
        self.assertEqual(C.eol_date(14), datetime.date(2026, 11, 12))
        self.assertEqual(C.eol_date(16), datetime.date(2028, 11, 9))
        self.assertEqual(C.eol_date(9.6), datetime.date(2021, 11, 11))

    def test_problems_are_explained(self):
        codes = lambda n: [c for _, c, _ in C.Profile(n).problems()]
        self.assertIn("unsupported", codes(90624))
        self.assertIn("legacy", codes(110000))
        self.assertIn("eol", codes(110000))
        self.assertNotIn("eol", codes(170000))
        self.assertIn("newer", codes(190000))
        self.assertEqual(codes(160000), [])

    def test_only_really_tested_versions_are_called_verified(self):
        self.assertTrue(C.Profile(160015).verified)
        self.assertFalse(C.Profile(130000).verified)
        self.assertFalse(C.Profile(90600).verified)

    def test_unsupported_is_refused_with_a_hint(self):
        from pg_arca.engine.util import EngineError
        with self.assertRaises(EngineError) as cm:
            C.require_supported(C.Profile(90624), "backup")
        self.assertEqual(cm.exception.code, "PGA-VER-001")
        C.require_supported(C.Profile(110000), "backup")          # legacy is allowed
        C.require_supported(C.Profile(190000), "backup")          # newer is allowed


class Differences(unittest.TestCase):
    def test_backup_api_by_version(self):
        self.assertIn("pg_start_backup('l', true, false)", C.Profile(140000).backup_start_sql("'l'", True))
        self.assertIn("pg_backup_start('l', false)", C.Profile(150000).backup_start_sql("'l'", False))
        self.assertIn("pg_backup_start('l', false)", C.Profile(190000).backup_start_sql("'l'", False))
        self.assertIn("pg_stop_backup(false, false)", C.Profile(100000).backup_stop_sql())
        self.assertIn("pg_backup_stop(false)", C.Profile(170000).backup_stop_sql())

    def test_pause_state_by_version(self):
        self.assertIn("pg_is_wal_replay_paused()", C.Profile(130000).replay_paused_sql())
        self.assertIn("pg_get_wal_replay_pause_state()", C.Profile(140000).replay_paused_sql())

    def test_feature_flags(self):
        self.assertTrue(C.Profile(110000).recovery_conf_file); self.assertFalse(C.Profile(120000).recovery_conf_file)
        self.assertFalse(C.Profile(120000).has_slot_wal_status); self.assertTrue(C.Profile(130000).has_slot_wal_status)

    def test_recovery_is_installed_the_way_the_version_wants(self):
        d = tempfile.mkdtemp(); open(os.path.join(d, "postgresql.auto.conf"), "w").write("a = 1\n")
        self.assertEqual(C.Profile(160000).install_recovery(d, "restore_command = 'x'\n"), "recovery.signal")
        self.assertTrue(os.path.exists(os.path.join(d, "recovery.signal")))
        self.assertIn("restore_command", open(os.path.join(d, "postgresql.auto.conf")).read())
        self.assertFalse(os.path.exists(os.path.join(d, "recovery.conf")))
        d2 = tempfile.mkdtemp(); open(os.path.join(d2, "postgresql.auto.conf"), "w").write("a = 1\n"); open(os.path.join(d2, "standby.signal"), "w").close()
        self.assertEqual(C.Profile(110000).install_recovery(d2, "restore_command = 'x'\n"), "recovery.conf")
        self.assertIn("restore_command", open(os.path.join(d2, "recovery.conf")).read())
        self.assertNotIn("restore_command", open(os.path.join(d2, "postgresql.auto.conf")).read(), "before 12 these are not server settings")
        self.assertFalse(os.path.exists(os.path.join(d2, "recovery.signal"))); self.assertFalse(os.path.exists(os.path.join(d2, "standby.signal")))

    def test_ephemeral_config_for_old_versions_has_no_restore_command_guc(self):
        from pg_arca.engine.ephemeral import quarantine_config
        for ver, expect in ((110000, False), (160000, True)):
            d = tempfile.mkdtemp()
            for f in ("postgresql.conf", "postgresql.auto.conf"):
                open(os.path.join(d, f), "w").write("")
            removed, forced = quarantine_config(d, {}, 55555, d, "cp x y", profile=C.Profile(ver))
            self.assertEqual("restore_command" in forced, expect, ver)


class Tools(unittest.TestCase):
    def test_binary_of_another_major_is_flagged(self):
        server = C.Profile(160000)
        pr = C.tool_problems(server, {"pg_waldump": C.Profile(140009), "psql": C.Profile(160002), "pg_ctl": C.Profile(160001), "pg_basebackup": C.Profile(150000)})
        self.assertEqual(sorted((c) for _, c, _ in pr), ["tool_major", "tool_old"])
        self.assertEqual(pr[0][0] if pr[0][1] == "tool_major" else pr[1][0], "critical")

    def test_recovering_needs_the_same_major(self):
        from pg_arca.engine.util import EngineError
        with self.assertRaises(EngineError) as cm:
            C.require_same_major(C.Profile(150004), C.Profile(160000), "starting a recovery instance")
        self.assertEqual(cm.exception.code, "PGA-VER-002")
        C.require_same_major(C.Profile(160001), C.Profile(160015), "x")
        C.require_same_major(C.Profile(150004), None, "x")            # binary unknown: do not guess

    def test_set_profile_from_metadata(self):
        self.assertEqual(C.set_profile({"pg_version_num": 150004}).label, "15")
        self.assertEqual(C.set_profile({"pg_version": "14.9 (Debian)"}).label, "14")
        self.assertIsNone(C.set_profile({}))


if __name__ == "__main__":
    unittest.main()
