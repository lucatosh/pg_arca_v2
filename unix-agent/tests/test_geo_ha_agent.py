"""HA / geo operations of the agent, against a simulated Patroni (independent review 16/10 night):
  - a site role change is confirmed by the member itself (/patroni), not by /cluster, which shows the DCS configuration at once;
  - the demotion reports where the site's WAL ended;
  - a replica reinitialization is followed until the member runs again (or reported as failed);
  - Patroni left paused is an error, never a silent success."""
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.executor import OperationExecutor, OpError


class Member(object):
    def __init__(self, seq):
        self.seq = list(seq)                     # successive /patroni answers

    def get_node_status(self):
        return 200, (self.seq.pop(0) if len(self.seq) > 1 else self.seq[0])

    def reinitialize(self, force=False):
        return 200, {"message": "reinitialize started"}


class FakePatroni(object):
    configured = True

    def __init__(self, cluster_roles, member, config=None, unpause_ok=True):
        self.cluster_roles, self.member, self.config, self.unpause_ok, self.patches = cluster_roles, member, config or {}, unpause_ok, []

    def get_config(self):
        return 200, dict(self.config)

    def patch_config(self, patch):
        self.patches.append(patch)
        for k, v in patch.items():
            if k == "pause" and v is False and not self.unpause_ok:
                continue
            if v is None:
                self.config.pop(k, None)
            else:
                self.config[k] = v
        return 200, dict(self.config)

    def leader(self):
        m = [{"name": "m1", "role": self.cluster_roles, "state": "running", "api_url": "http://m1:8008/patroni"}, {"name": "m2", "role": "replica", "state": "streaming", "api_url": "http://m2:8008/patroni"}]
        return ("m1" if self.cluster_roles in ("leader", "standby_leader") else None), m

    def wait_for(self, predicate, timeout=90, interval=2):
        end = time.time() + timeout
        while time.time() < end:
            l, m = self.leader()
            if predicate(l, m):
                return True, l, m
            time.sleep(0.01)
        return False, l, m

    def for_member(self, url):
        return self.member


def make(pat):
    d = tempfile.mkdtemp()
    ex = OperationExecutor({"state_dir": d}, None, pat, None, None)
    ex._require_patroni = lambda: None
    ex._progress = lambda *a, **k: None
    return ex


class SiteRoles(unittest.TestCase):
    def test_demotion_waits_for_the_member_and_says_where_its_wal_ended(self):
        # /cluster says standby_leader at once (DCS), the member is still a writable primary for a few polls
        member = Member([{"role": "master", "state": "running"}] * 5 + [{"role": "standby_leader", "state": "streaming", "timeline": 3, "xlog": {"received_location": 0x5000100, "replayed_location": 0x5000100}}])
        pat = FakePatroni("standby_leader", member, config={})
        r = make(pat).h_geo_demote({"host": "10.0.0.9", "port": 5432, "confirm": "DEMOTE", "timeout": 5})
        self.assertTrue(r["demoted"]); self.assertTrue(r["verified_on_member"])
        self.assertEqual(r["demoted_lsn"], "0/5000100")
        self.assertEqual(member.seq[0]["role"], "standby_leader", "it did not return while the member was still primary")

    def test_promotion_not_confirmed_by_the_member_times_out(self):
        member = Member([{"role": "standby_leader", "state": "streaming"}])
        pat = FakePatroni("leader", member, config={"standby_cluster": {"host": "x", "port": 5432}})
        with self.assertRaises(OpError):
            make(pat).h_geo_promote({"confirm": "PROMOTE", "timeout": 1})

    def test_promotion_confirmed(self):
        member = Member([{"role": "master", "state": "running", "timeline": 4}])
        pat = FakePatroni("leader", member, config={"standby_cluster": {"host": "x", "port": 5432}})
        r = make(pat).h_geo_promote({"confirm": "PROMOTE", "timeout": 5})
        self.assertTrue(r["promoted"]); self.assertEqual(r["timeline"], 4)

    def test_unpause_that_does_not_take_is_an_error(self):
        ex = make(FakePatroni("leader", Member([{"role": "master", "state": "running"}]), config={"pause": True}, unpause_ok=False))
        import pg_arca.executor as E
        real = E.time.sleep
        E.time.sleep = lambda s: None
        try:
            self.assertFalse(ex._unpause())
        finally:
            E.time.sleep = real
        ex2 = make(FakePatroni("leader", Member([{"role": "master", "state": "running"}]), config={"pause": True}))
        self.assertTrue(ex2._unpause())


class Reinit(unittest.TestCase):
    def _ex(self, seq):
        member = Member(seq)
        pat = FakePatroni("leader", member)
        ex = make(pat)
        ex._bridge_for = lambda name: (member, {"name": name})
        ex._cancelled = lambda: False
        import pg_arca.executor as E
        self._real = E.time.sleep
        E.time.sleep = lambda s: None
        return ex

    def tearDown(self):
        import pg_arca.executor as E
        E.time.sleep = self._real

    def test_followed_until_the_replica_runs(self):
        ex = self._ex([{"state": "creating replica", "role": "replica"}] * 3 + [{"state": "streaming", "role": "replica"}])
        r = ex.h_reinit({"member": "m2", "timeout": 60})
        self.assertTrue(r["verified"]); self.assertEqual(r["state"], "streaming")

    def test_a_clone_that_fails_is_a_failure(self):
        ex = self._ex([{"state": "creating replica", "role": "replica"}, {"state": "start failed", "role": "replica"}])
        with self.assertRaises(OpError) as e:
            ex.h_reinit({"member": "m2", "timeout": 60})
        self.assertIn("start failed", str(e.exception))


if __name__ == "__main__":
    unittest.main()
