"""A restored COPY of a server that is a logical replication SUBSCRIBER must not start applying from the real publisher: its worker would consume the
real subscriber's slot (that subscriber then misses those changes for good). Same for the ephemeral recovery instance.

  publisher : a second PostgreSQL (wal_level=logical) started by this test
  subscriber: the backed-up test server; its subscription is disabled after the backup (slot free, the worst case for a copy)

  as root:   su postgres -s /bin/bash -c 'cd unix-agent && python3 -m unittest tests.test_logical_copy_pg -v'
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import test_engine_pg as base
from tests.test_engine_pg import BIN, F, q, sh

from pg_arca.engine.backup import run_backup
from pg_arca.engine.ephemeral import quarantine_config
from pg_arca.engine.pgsession import PgConn, PgSession
from pg_arca.engine.restore import restore_instance

P = {}


def pub(sql, db="postgres"):
    s = PgSession(PgConn(host=F.sock, port=P["port"], user="postgres", bindir=BIN).with_db(db))
    try:
        return s.query(sql)
    finally:
        s.close()


def setUpModule():
    base.setUpModule()
    P["dir"] = os.path.join(F.base, "publisher")
    P["port"] = F.port + 11
    r = sh(os.path.join(BIN, "initdb"), "-D", P["dir"], "-U", "postgres", "--auth=trust")
    assert r.returncode == 0, r.stderr
    with open(os.path.join(P["dir"], "postgresql.conf"), "a") as f:
        f.write("\nwal_level = logical\nlisten_addresses = ''\nunix_socket_directories = '%s'\nport = %d\n" % (F.sock, P["port"]))
    r = sh(os.path.join(BIN, "pg_ctl"), "-D", P["dir"], "-l", P["dir"] + ".log", "-w", "-t", "60", "start")
    assert r.returncode == 0, open(P["dir"] + ".log").read()[-800:]
    pub("CREATE DATABASE shop")
    pub("CREATE TABLE orders (id int PRIMARY KEY, v text); INSERT INTO orders SELECT g, 'o' || g FROM generate_series(1, 50) g; CREATE PUBLICATION pub_orders FOR TABLE orders", "shop")
    q("postgres", "CREATE DATABASE replica_db")
    q("replica_db", "CREATE TABLE orders (id int PRIMARY KEY, v text)")
    q("replica_db", "CREATE SUBSCRIPTION sub_orders CONNECTION 'host=%s port=%d dbname=shop user=postgres' PUBLICATION pub_orders" % (F.sock, P["port"]))
    for _ in range(60):
        if q("replica_db", "SELECT count(*) FROM orders")[0][0] == "50":
            break
        time.sleep(0.5)
    run_backup(F.ctx, "full")
    q("replica_db", "ALTER SUBSCRIPTION sub_orders DISABLE")              # the real subscriber pauses: the slot is free
    for _ in range(40):
        if pub("SELECT active FROM pg_replication_slots WHERE slot_name = 'sub_orders'", "shop")[0][0] == "f":
            break
        time.sleep(0.5)
    q("postgres", "SELECT pg_switch_wal()")
    time.sleep(2)


def tearDownModule():
    sh(os.path.join(BIN, "pg_ctl"), "-D", P["dir"], "-m", "immediate", "stop")
    base.tearDownModule()


class LogicalCopy(unittest.TestCase):
    def test_01_restored_copy_does_not_take_the_publishers_slot(self):
        dest = os.path.join(F.base, "copy_sub")
        # the backup's point (subscription still ENABLED there): the copy promotes with an enabled subscription in its catalog
        plan = restore_instance(F.ctx, dest=dest, immediate=True, action="promote")
        self.assertIn("max_logical_replication_workers = 0", plan.get("copy_safety") or [])
        sub = [c for c in plan["preflight"]["checks"] if c["id"] == "subscriptions"]
        self.assertTrue(sub and "replica_db.sub_orders" in sub[0]["text"] and "SET (slot_name = NONE)" in sub[0]["fix"], plan["preflight"])
        port = F.port + 12
        r = sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-o", "-p %d -k %s" % (port, F.sock), "-l", dest + ".log", "-w", "-t", "120", "start")
        self.assertEqual(r.returncode, 0, open(dest + ".log").read()[-1500:])
        try:
            s = PgSession(PgConn(host=F.sock, port=port, user="postgres", bindir=BIN).with_db("replica_db"))
            for _ in range(60):
                if s.scalar("SELECT pg_is_in_recovery()") == "f":
                    break
                time.sleep(1)
            self.assertEqual(s.scalar("SELECT subenabled FROM pg_subscription WHERE subname = 'sub_orders'"), "t", "the subscription is still defined and enabled in the copy")
            pub("INSERT INTO orders SELECT g, 'late' FROM generate_series(51, 60) g", "shop")
            time.sleep(6)
            self.assertEqual(pub("SELECT active FROM pg_replication_slots WHERE slot_name = 'sub_orders'", "shop")[0][0], "f",
                             "the copy must not connect to the real publisher's slot")
            self.assertEqual(s.scalar("SELECT count(*) FROM orders"), "50", "nothing applied in the copy")
            s.close()
        finally:
            sh(os.path.join(BIN, "pg_ctl"), "-D", dest, "-m", "immediate", "stop")
        # the real subscriber resumes and gets everything
        q("replica_db", "ALTER SUBSCRIPTION sub_orders ENABLE")
        for _ in range(60):
            if q("replica_db", "SELECT count(*) FROM orders")[0][0] == "60":
                break
            time.sleep(0.5)
        self.assertEqual(q("replica_db", "SELECT count(*) FROM orders")[0][0], "60")

    def test_02_ephemeral_instance_never_runs_apply_workers(self):
        d = os.path.join(F.base, "qc")
        os.makedirs(d)
        open(os.path.join(d, "postgresql.conf"), "w").write("max_logical_replication_workers = 8\n")
        _, forced = quarantine_config(d, {}, 5999, d, "true")
        self.assertEqual(forced.get("max_logical_replication_workers"), "0")

    def test_03_restore_database_of_a_subscriber(self):
        # the copy's subscription keeps the publisher's slot NAME: enabling it would steal the slot, and DROP SUBSCRIPTION (the obvious clean-up of a
        # copy) connects to the publisher and DROPS production's slot. Restored subscriptions are disabled AND detached (slot_name = NONE)
        from pg_arca.engine.granular import restore_database
        r = restore_database(F.ctx, "replica_db", new_name="replica_back")
        rows = q("replica_back", "SELECT subname, subenabled, coalesce(subslotname, '-') FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = 'replica_back'")
        self.assertEqual(rows, [["sub_orders", "f", "-"]])
        self.assertTrue(any("detached from the publisher" in w for w in r.get("warnings") or []), r.get("warnings"))
        q("replica_back", "DROP SUBSCRIPTION sub_orders")
        self.assertEqual(pub("SELECT count(*) FROM pg_replication_slots WHERE slot_name = 'sub_orders'", "shop")[0][0], "1", "production's slot survives the copy's clean-up")
        pub("INSERT INTO orders VALUES (61, 'after')", "shop")
        for _ in range(60):
            if q("replica_db", "SELECT count(*) FROM orders")[0][0] == "61":
                break
            time.sleep(0.5)
        self.assertEqual(q("replica_db", "SELECT count(*) FROM orders")[0][0], "61", "the real subscriber still replicates")

if __name__ == "__main__":
    unittest.main()
