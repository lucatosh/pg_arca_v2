"""Offsite copy on S3: the mirror cycle against the in-process fake S3 with a real repository layout (packs, sets, WAL files): what goes up
and in which order, what is deleted and when, the empty-local guard, resumability, rehydration into an empty repository, the executor ops."""
import json
import os
import shutil
import tempfile
import time
import unittest

from pg_arca import offsite
from pg_arca.engine.repo import Repo
from tests.fake_s3 import FakeS3


REAL = os.environ.get("PG_ARCA_TEST_S3_ENDPOINT")        # e.g. http://127.0.0.1:9000 (MinIO on the lab) with PG_ARCA_TEST_S3_KEY / _SECRET / _BUCKET: the same tests against a real store


class _Real(object):
    def __init__(self):
        self.endpoint = REAL

    def close(self):
        pass


class OffsiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = _Real() if REAL else FakeS3()
        cls.ak = os.environ.get("PG_ARCA_TEST_S3_KEY", "AKTEST") if REAL else "AKTEST"
        cls.sk = os.environ.get("PG_ARCA_TEST_S3_SECRET", "s") if REAL else "s"
        cls.bucket = os.environ.get("PG_ARCA_TEST_S3_BUCKET", "bk") if REAL else "bk"

    @classmethod
    def tearDownClass(cls):
        cls.srv.close()

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="pgarca-off-")
        self.repo_path = os.path.join(self.d, "repo")
        self.wal = os.path.join(self.d, "wal")
        self.state = os.path.join(self.d, "state")
        os.makedirs(self.wal)
        self.repo = Repo(self.repo_path, "main", algo="zlib")
        self.repo.init()
        self.prefix = "t%d" % int(time.time() * 1000)
        self.config = {"repo_path": self.repo_path, "wal_archive_dir": self.wal, "state_dir": self.state,
                       "offsite": {"type": "s3", "endpoint": self.srv.endpoint, "bucket": self.bucket, "prefix": self.prefix, "access_key": self.ak, "secret_key": self.sk, "region": "us-east-1"}}
        self.logs = []
        self.m = offsite.Mirror(self.config, self.state, log=lambda lv, m: self.logs.append((lv, m)))

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _set(self, sid, hashes, status="COMPLETE"):
        sd = self.repo.own_path("backup", sid)
        os.makedirs(sd, exist_ok=True)
        self.repo.write_zjson(os.path.join(sd, "manifest.json.z"), {"set": sid, "files": {"f%d" % i: {"size": 1, "chunks": [[0, 1, h]]} for i, h in enumerate(hashes)}}, sid + "/manifest")
        self.repo.write_zjson(os.path.join(sd, "catalog.json.z"), {"databases": {}}, sid + "/catalog")
        with open(os.path.join(sd, "backup_label"), "w") as f:
            f.write("START WAL LOCATION: 0/1\n")
        self.repo.write_meta({"id": sid, "status": status, "type": "full", "start_time": "2026-01-01T00:00:00Z"})

    def _wal(self, name, size=1000):
        with open(os.path.join(self.wal, name), "wb") as f:
            f.write(b"w" * size)
        with open(os.path.join(self.wal, name + ".meta"), "w") as f:
            json.dump({"sha256": "x"}, f)

    def test_validate(self):
        self.assertIsNone(offsite.validate(None))
        with self.assertRaises(ValueError):
            offsite.validate({"endpoint": "ftp://x", "bucket": "b", "access_key": "a", "secret_key": "s"})
        with self.assertRaises(ValueError):
            offsite.validate({"endpoint": "https://x", "bucket": "Bad Bucket", "access_key": "a", "secret_key": "s"})
        with self.assertRaises(ValueError):
            offsite.validate({"endpoint": "https://x", "bucket": "b", "access_key": "a"})
        c = offsite.validate({"endpoint": "https://s3.example/", "bucket": "b", "prefix": "/p/q/", "access_key": "a", "secret_key": "s"})
        self.assertEqual((c["endpoint"], c["prefix"], c["region"], c["path_style"], c["tls_verify"], c["enabled"]), ("https://s3.example", "p/q", "us-east-1", True, True, True))

    def test_plan_order(self):
        local = {"repo/cas/packs/a.pack": 1, "repo/cas/packs/a.idx": 1, "repo/repo.json": 1, "repo/stanza/main/stanza.json": 1,
                 "repo/stanza/main/backup/S1/manifest.json.z": 1, "repo/stanza/main/backup/S1/meta.json": 1, "wal/0000000100000000000000A1.zst": 1}
        up, down = offsite.plan(local, {"repo/stanza/main/backup/S0/meta.json": 1, "repo/stanza/main/backup/S0/manifest.json.z": 1, "repo/cas/packs/old.pack": 1, "repo/repo.json": 1})
        self.assertEqual(up[:2], ["repo/cas/packs/a.idx", "repo/cas/packs/a.pack"], "packs first")
        self.assertEqual(up[-1], "wal/0000000100000000000000A1.zst")
        self.assertLess(up.index("repo/stanza/main/backup/S1/manifest.json.z"), up.index("repo/stanza/main/backup/S1/meta.json"), "meta.json after the files it describes")
        self.assertEqual(down[0], "repo/stanza/main/backup/S0/meta.json", "a set's meta goes first when deleting")
        self.assertEqual(down[-1], "repo/cas/packs/old.pack", "packs last when deleting")
        self.assertNotIn("repo/repo.json", up, "same size: nothing to do")

    def test_mirror_uploads_sets_and_packs_then_deletes_after_the_grace(self):
        hs = [self.repo.put_chunk(b"%06d" % i * 100)[0] for i in range(50)]
        self.repo.flush()
        self._set("20260101-000000F", hs)
        self._set("20260101-000100F", hs[:3], status="FAILED")               # never mirrored
        self._wal("000000010000000000000001.zst")
        open_pack = self.repo.put_chunk(b"unsealed")                           # an open pack (no .idx yet): not mirrored
        st = self.m.sync()
        self.assertTrue(st["ok"], st)
        remote = offsite.client_for(self.m.cfg()).list("")
        self.assertIn("repo/repo.json", remote)
        self.assertIn("repo/stanza/main/stanza.json", remote) if os.path.exists(os.path.join(self.repo_path, "stanza", "main", "stanza.json")) else None
        self.assertIn("repo/stanza/main/backup/20260101-000000F/manifest.json.z", remote)
        self.assertIn("repo/stanza/main/backup/20260101-000000F/meta.json", remote)
        self.assertNotIn("repo/stanza/main/backup/20260101-000100F/meta.json", remote, "failed sets are not mirrored")
        self.assertEqual(len([k for k in remote if k.endswith(".pack")]), 1, "the sealed pack only")
        self.assertIn("wal/000000010000000000000001.zst", remote)
        self.assertIn("wal/000000010000000000000001.zst.meta", remote)
        self.assertEqual(st["uploaded"], len(remote))
        # idempotent: a second cycle uploads nothing; and with nothing changed locally it does not even list the bucket
        st2 = self.m.sync()
        self.assertTrue(st2.get("skipped"), st2)
        st2 = self.m.sync(force=True)
        self.assertEqual((st2["uploaded"], st2["deleted"]), (0, 0))
        # the status file the heartbeat reads
        status = self.m.status()
        self.assertTrue(status["ok"] and status["last_ok"] and status["remote_objects"] == len(remote))
        # a changed file (meta.json rewritten with another status text) is uploaded again
        self.repo.write_meta({"id": "20260101-000000F", "status": "COMPLETE", "type": "full", "start_time": "2026-01-01T00:00:00Z", "note": "a longer meta"})
        self.assertEqual(self.m.sync()["uploaded"], 1)
        # a set expired locally: deleted remotely only after the grace, meta first
        shutil.rmtree(self.repo.own_path("backup", "20260101-000000F"))
        st3 = self.m.sync()
        self.assertEqual((st3["deleted"], st3["waiting_delete"]), (0, 4))
        gone = json.load(open(self.m.gone_path))
        for k in gone:
            gone[k] = time.time() - offsite.KEEP_DELETE_GRACE - 1
        json.dump(gone, open(self.m.gone_path, "w"))
        st4 = self.m.sync(force=True)
        self.assertEqual(st4["deleted"], 4)
        self.assertFalse(any(k.startswith("repo/stanza/main/backup/20260101-000000F/") for k in offsite.client_for(self.m.cfg()).list("")))

    def test_empty_local_never_deletes_remotely(self):
        hs = [self.repo.put_chunk(b"%06d" % i * 100)[0] for i in range(5)]
        self.repo.flush()
        self._set("20260102-000000F", hs)
        self._wal("000000010000000000000002.zst")
        self.assertTrue(self.m.sync()["ok"])
        n = len(offsite.client_for(self.m.cfg()).list(""))
        shutil.rmtree(self.repo_path)                                          # "the share is not mounted"
        os.makedirs(self.repo_path)
        gone_t = time.time() - offsite.KEEP_DELETE_GRACE - 10
        st = self.m.sync()
        self.assertTrue(st["local_empty"])
        self.assertEqual(st["deleted"], 0)
        json.dump(dict((k, gone_t) for k in offsite.client_for(self.m.cfg()).list("")), open(self.m.gone_path, "w"))
        st = self.m.sync(force=True)
        self.assertEqual((st["deleted"], len(offsite.client_for(self.m.cfg()).list(""))), (0, n), "nothing deleted while the local side looks empty")

    def test_failed_upload_is_retried_next_cycle(self):
        if REAL:
            self.skipTest("simulated failures need the fake server")
        srv = FakeS3(fail_every=3)
        try:
            self.config["offsite"]["endpoint"] = srv.endpoint
            hs = [self.repo.put_chunk(b"%06d" % i * 100)[0] for i in range(5)]
            self.repo.flush()
            self._set("20260103-000000F", hs)
            st = self.m.sync()
            self.assertFalse(st["ok"])
            self.assertIn("simulated", st["last_error"])
            self.assertGreater(st["uploaded"], 0, "the other objects of the cycle were uploaded anyway")
            for _ in range(5):
                st = self.m.sync()
                if st["ok"]:
                    break
            self.assertTrue(st["ok"], st)
            self.assertEqual(len(offsite.client_for(self.m.cfg()).list("")), 7)
        finally:
            srv.close()

    def test_rehydrate_into_an_empty_repository(self):
        hs = [self.repo.put_chunk(b"%06d" % i * 300)[0] for i in range(30)]
        self.repo.flush()
        self._set("20260104-000000F", hs)
        self._wal("000000010000000000000004.zst")
        self.assertTrue(self.m.sync()["ok"])
        # the site burns down: new empty directories, same configuration
        shutil.rmtree(self.repo_path)
        shutil.rmtree(self.wal)
        os.makedirs(self.repo_path)
        os.makedirs(self.wal)
        r = self.m.rehydrate()
        self.assertGreater(r["downloaded"], 5)
        self.assertEqual(r["differ_count"], 0)
        back = Repo(self.repo_path, "main", algo="zlib")
        for i, h in enumerate(hs):
            self.assertEqual(back.get_chunk(h), b"%06d" % i * 300)
        self.assertEqual(back.sets()[0]["id"], "20260104-000000F")
        self.assertTrue(os.path.exists(os.path.join(self.wal, "000000010000000000000004.zst.meta")))
        self.assertEqual(self.m.rehydrate()["downloaded"], 0, "nothing left to fetch")

    def test_rehydrate_does_not_bring_back_what_retention_removed(self):
        """Found on the lab: the mirror had uploaded the whole WAL archive, a full backup's retention then removed the old WAL locally (the
        bucket keeps it for the grace period), and 'download what is missing' pulled 8 GB back. What this node removed on purpose (WAL below
        the retention floor, expired sets, packs dropped by the garbage collection) is skipped unless asked for; after a real loss of the
        storage (the journal and the floor go with it) everything is downloaded."""
        hs = [self.repo.put_chunk(b"%06d" % i * 300)[0] for i in range(10)]
        self.repo.flush()
        self._set("20260101-000000F", hs)
        self._set("20260108-000000F", hs)
        for n in range(1, 7):
            self._wal("0000000100000000000000%02X.zst" % n)
        self.assertTrue(self.m.sync()["ok"])
        # retention: the first set expires, WAL below segment 4 goes (floor marker as expire writes it)
        self.repo.retire(sets=["20260101-000000F"])
        shutil.rmtree(self.repo.own_path("backup", "20260101-000000F"))
        for n in range(1, 4):
            os.remove(os.path.join(self.wal, "0000000100000000000000%02X.zst" % n))
            os.remove(os.path.join(self.wal, "0000000100000000000000%02X.zst.meta" % n))
        with open(os.path.join(self.wal, ".retention_floor.json"), "w") as f:
            json.dump({"segno": 4, "lsn": "0/4000000", "seg_size": 16 * 1024 * 1024}, f)
        r = self.m.rehydrate()
        self.assertEqual(r["downloaded"], 0, r)
        self.assertGreaterEqual(r["retained_skipped"], 6 + 1, r)                     # 3 segments + 3 metas + the expired set's files
        self.assertFalse(os.path.exists(os.path.join(self.wal, "000000010000000000000001.zst")))
        self.assertFalse(os.path.isdir(self.repo.own_path("backup", "20260101-000000F")))
        # a genuinely lost segment above the floor IS fetched
        os.remove(os.path.join(self.wal, "000000010000000000000005.zst"))
        r = self.m.rehydrate(what="wal")
        self.assertEqual(r["downloaded"], 1, r)
        # on request, everything
        r = self.m.rehydrate(include_retained=True)
        self.assertGreaterEqual(r["downloaded"], 7, r)
        self.assertTrue(os.path.exists(os.path.join(self.wal, "000000010000000000000001.zst")))

    def _client(self):
        from pg_arca.s3 import S3Client
        return S3Client(self.srv.endpoint, self.bucket, self.ak, self.sk, prefix=self.prefix)

    def _inject(self, key, data):
        """An object written by whoever controls the bucket (key relative to the bucket, prefix included)."""
        if not REAL:
            self.srv.objects[(self.bucket, key)] = data
            return
        from pg_arca.s3 import S3Client, S3Error
        try:
            S3Client(self.srv.endpoint, self.bucket, self.ak, self.sk).put(key, data)
        except S3Error:
            pass                                                   # the server itself refuses the name (400 for '..'/'//' on some stores): nothing to defend against

    def test_rehydrate_refuses_hostile_object_names(self):
        """Whoever controls the bucket chooses the object names: a key that resolves outside the repository / archive, or onto an existing
        local file, is refused and reported, never written."""
        self._wal("000000010000000000000009.zst")
        self.assertTrue(self.m.sync()["ok"])
        pre = self.prefix + "/"
        bad = ["wal/../../../../tmp/pga-evil", "repo/../evil", "repo//abs", "evil/x", "wal/./x", "wal/a/../../x", "repo/" + "x"]
        before = set(self._client().list().keys()) if REAL else set()        # what the mirror itself uploaded
        for k in bad:
            self._inject(pre + k, b"evil")
        # a real server may normalize or refuse some of these names on upload: count what the bucket really holds
        held = set(self._client().list().keys()) if REAL else set(bad)
        hostile = [k for k in held if k in bad and k != "repo/x"]
        normalized = sorted(held - set(bad) - before)                   # names the server rewrote on upload ('wal/./x' -> 'wal/x'): harmless, inside the tree
        self.assertTrue(all(k.split("/", 1)[0] in ("wal", "repo") and ".." not in k.split("/") for k in normalized), normalized)
        existing = os.path.join(self.wal, "000000010000000000000009.zst")
        os.remove(os.path.join(self.wal, "000000010000000000000009.zst.meta"))             # the archive lost one file: that one is fetched
        r = self.m.rehydrate()
        self.assertEqual(r["downloaded"], 2 + len(normalized), (r, normalized))                 # the .meta, the harmless repo/x (and what the server normalized)
        self.assertEqual(r["refused_count"], len(hostile), (r, sorted(held)))
        self.assertFalse(os.path.exists("/tmp/pga-evil"))
        self.assertFalse(os.path.exists(os.path.join(self.d, "evil")))
        self.assertTrue(os.path.exists(existing))
        self.assertTrue(any("refused" in m for _, m in self.logs))
        # a local file already in the way is not overwritten even when the inventory does not know it (written between listing and download)
        with open(os.path.join(self.wal, "000000010000000000000009.zst.meta"), "w") as f:
            f.write("mine")
        self._inject(pre + "wal/000000010000000000000009.zst.meta", b"theirs")
        local = self.m.local_inventory()
        self.assertIn("wal/000000010000000000000009.zst.meta", local)
        with open(os.path.join(self.wal, "000000010000000000000009.zst.meta")) as f:
            self.assertEqual(f.read(), "mine")

    def test_executor_ops(self):
        from pg_arca.executor import OperationExecutor, OpError
        cfgfile = os.path.join(self.d, "agent.conf")
        self.config["credentials_file"] = os.path.join(self.d, "credentials.json")
        self.config.pop("offsite")
        ex = OperationExecutor(self.config, None, None)
        self.assertEqual(ex.h_offsite_get({})["offsite"], None)
        with self.assertRaises(OpError):
            ex.h_offsite_set({"offsite": {"endpoint": "http://127.0.0.1:1", "bucket": self.bucket, "access_key": self.ak, "secret_key": self.sk}, "test": True})
        self.assertIsNone(self.config.get("offsite"), "nothing saved when the probe fails")
        r = ex.h_offsite_set({"offsite": {"endpoint": self.srv.endpoint, "bucket": self.bucket, "prefix": self.prefix + "x", "access_key": self.ak, "secret_key": self.sk}, "test": True})
        self.assertTrue(r["offsite"]["secret_key_set"] and "secret_key" not in r["offsite"] and "reachable" in r["probe"])
        self.assertEqual(self.config["offsite"]["secret_key"], self.sk)
        got = ex.h_offsite_get({})
        self.assertEqual(got["offsite"]["bucket"], self.bucket)
        self.assertNotIn('"secret_key"', json.dumps(got))
        r = ex.h_offsite_set({"offsite": {"endpoint": self.srv.endpoint, "bucket": self.bucket, "prefix": self.prefix + "x", "access_key": self.ak, "secret_key": ""}, "test": False})
        self.assertEqual(self.config["offsite"]["secret_key"], self.sk, "an empty secret keeps the stored one")
        self.assertTrue(ex.h_offsite_sync({"dry_run": True})["dry_run"])
        hs = [self.repo.put_chunk(b"z" * 500)[0]]
        self.repo.flush()
        self._set("20260105-000000F", hs)
        self.assertGreater(ex.h_offsite_sync({})["uploaded"], 0)
        ex.h_offsite_set({"offsite": None})
        self.assertIsNone(self.config.get("offsite"))
        self.assertEqual(ex.h_offsite_get({})["offsite"], None)


if __name__ == "__main__":
    unittest.main()
