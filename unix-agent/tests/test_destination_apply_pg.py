"""Applying a new WAL archive directory on a live primary (what the console's 'apply' sends: agent_config_set with verify_wal): archive_command reads the
agent's configuration, so the archive moves at once; the agent proves that the next segment lands in the new directory, keeps the old one readable,
and goes back to the old one by itself when the new one does not work.

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_destination_apply_pg -v'
"""
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import F, q

from pg_arca.config import load_config
from pg_arca.db_client import PostgresClient
from pg_arca.executor import OperationExecutor, OpError


class NoPatroni(object):
    configured = False


S = {}


def setUpModule():
    base.setUpModule()
    S["conf"] = os.path.join(F.base, "agent.conf")
    json.dump({"web_server_url": "http://x", "state_dir": os.path.join(F.base, "st"), "repo_path": F.repo, "wal_archive_dir": F.wal,
               "credentials_file": os.path.join(F.base, "credentials.json")}, open(S["conf"], "w"))
    walbin = os.path.join(base.HERE, "pg-arca-wal")
    q("postgres", "ALTER SYSTEM SET archive_command = 'env PG_ARCA_CONF=%s PG_ARCA_HOME=%s %s archive %%p %%f'" % (S["conf"], base.HERE, walbin))
    q("postgres", "SELECT pg_reload_conf()")
    os.environ["PG_ARCA_CONF_FILE"] = S["conf"]
    S["ex"] = OperationExecutor(load_config(S["conf"]), PostgresClient(user="postgres", port=F.port, host="", socket_dir=F.sock), NoPatroni(), None, None)


def tearDownModule():
    os.environ.pop("PG_ARCA_CONF_FILE", None)
    base.tearDownModule()


class Apply(unittest.TestCase):
    def test_01_new_directory_proven_and_old_kept_readable(self):
        ex = S["ex"]
        new = os.path.join(F.base, "wal_new")
        r = ex.h_cfg_set({"set": {"wal_archive_dir": new}, "verify_wal": True})
        self.assertTrue(r["wal_check"]["archived"], r["wal_check"])
        self.assertTrue(os.path.exists(os.path.join(new, r["wal_check"]["segment"])) or any(n.startswith(r["wal_check"]["segment"]) for n in os.listdir(new)))
        self.assertEqual(ex.config["wal_previous"], [F.wal])
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)
        self.assertGreaterEqual(len([n for n in os.listdir(new) if n.startswith("0000")]), 2, "archiving goes on in the new directory")

    def test_02_a_directory_that_does_not_work_is_rolled_back(self):
        ex = S["ex"]
        cur = ex.config["wal_archive_dir"]
        ex._verify_new_wal_dir = lambda d, wait=60: {"segment": "000000010000000000000099", "archived": False, "seconds": 60, "error": "Permission denied"}
        try:
            with self.assertRaises(OpError) as cm:
                ex.h_cfg_set({"set": {"wal_archive_dir": os.path.join(F.base, "wal_broken")}, "verify_wal": True})
        finally:
            del ex._verify_new_wal_dir
        self.assertIn("went back to %s" % cur, str(cm.exception))
        self.assertEqual(ex.config["wal_archive_dir"], cur)
        self.assertEqual(load_config(S["conf"])["wal_archive_dir"], cur, "the saved configuration too (archive_command reads it)")
        self.assertEqual(ex.config["wal_previous"], [F.wal], "previous locations as before the attempt")
        q("postgres", "SELECT pg_switch_wal()")
        time.sleep(3)
        self.assertEqual(q("postgres", "SELECT last_failed_wal IS NULL OR last_failed_time < last_archived_time FROM pg_stat_archiver")[0][0], "t")


if __name__ == "__main__":
    unittest.main()
