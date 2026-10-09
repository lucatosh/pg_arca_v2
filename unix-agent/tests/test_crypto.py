import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.engine import crypt
from pg_arca.engine.repo import Repo
from pg_arca.engine.util import EngineError
from pg_arca.wal_manager import WalManager

MB = 1024 * 1024


@unittest.skipUnless(crypt.available(), "python 'cryptography' not installed")
class CryptoTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp()
        self.key = crypt.generate_key(os.path.join(self.t, "k1"))
        self.key2 = crypt.generate_key(os.path.join(self.t, "k2"))
        self.c = crypt.Crypto(self.key)

    def tearDown(self):
        shutil.rmtree(self.t, ignore_errors=True)

    def repo(self, crypto, name="repo"):
        r = Repo(os.path.join(self.t, name), "main", algo="zlib", crypto=crypto)
        r.init()
        return r

    def test_key_file_rules(self):
        self.assertEqual(oct(os.stat(self.key).st_mode & 0o777), "0o600")
        with self.assertRaises(EngineError):
            crypt.generate_key(self.key)                                   # never overwrite a key
        os.chmod(self.key, 0o644)
        with self.assertRaises(EngineError) as cm:
            crypt.Crypto(self.key)
        self.assertEqual(cm.exception.code, "PGA-ENC-003")

    def test_chunks_are_encrypted_and_roundtrip(self):
        r = self.repo(self.c)
        data = b"super secret row data " * 500
        h, w, dedup = r.put_chunk(data)
        self.assertFalse(dedup)
        raw = open(r.cas_path(h), "rb").read()
        self.assertEqual(raw[:1], b"E")
        self.assertNotIn(b"secret", raw)
        self.assertEqual(r.get_chunk(h), data)
        self.assertTrue(r.put_chunk(data)[2], "dedup still works")
        self.assertNotEqual(h, __import__("pg_arca.engine.util", fromlist=["x"]).chunk_hash(data), "ids are keyed")

    def test_wrong_key_missing_key_and_tamper(self):
        r = self.repo(self.c)
        h, _, _ = r.put_chunk(b"abc" * 1000)
        with self.assertRaises(EngineError) as cm:
            self.repo(None)                                               # existing encrypted repo without key
        self.assertEqual(cm.exception.code, "PGA-ENC-005")
        with self.assertRaises(EngineError) as cm:
            self.repo(crypt.Crypto(self.key2))
        self.assertEqual(cm.exception.code, "PGA-ENC-007")
        p = r.cas_path(h)
        blob = bytearray(open(p, "rb").read())
        blob[-1] ^= 1
        open(p, "wb").write(bytes(blob))
        with self.assertRaises(EngineError):
            r.get_chunk(h)                                                # authenticated: bit flips are detected

    def test_blob_cannot_be_moved_to_another_id(self):
        r = self.repo(self.c)
        h1, _, _ = r.put_chunk(b"one" * 1000)
        h2, _, _ = r.put_chunk(b"two" * 1000)
        shutil.copyfile(r.cas_path(h1), r.cas_path(h2))
        with self.assertRaises(EngineError):
            r.get_chunk(h2)

    def test_plain_repo_refuses_key_and_manifests_encrypted(self):
        plain = self.repo(None, "plain")
        with self.assertRaises(EngineError) as cm:
            Repo(plain.path, "main", crypto=self.c).init()
        self.assertEqual(cm.exception.code, "PGA-ENC-008")
        r = self.repo(self.c, "enc")
        path = os.path.join(self.t, "m.json.z")
        r.write_zjson(path, {"files": {"base/16384/secret_table": 1}}, "s1/manifest")
        self.assertNotIn(b"secret_table", open(path, "rb").read())
        self.assertEqual(r.read_zjson(path, "s1/manifest")["files"], {"base/16384/secret_table": 1})
        with self.assertRaises(EngineError):
            r.read_zjson(path, "s2/manifest")                              # bound to its set

    def test_wal_archive_encrypted(self):
        wal = os.path.join(self.t, "wal")
        wm = WalManager(wal, compression="zlib", segment_size=MB, crypto=self.c)
        src = os.path.join(self.t, "seg")
        payload = (b"WALDATA-" * 1024) * 128 + os.urandom(1024 * 900)
        open(src, "wb").write(payload[:MB].ljust(MB, b"\0"))
        name = "000000010000000000000001"
        ok, dest, sha, msg = wm.archive_segment(src, name)
        self.assertTrue(ok)
        self.assertNotIn(b"WALDATA", open(dest, "rb").read())
        out = os.path.join(self.t, "out")
        self.assertEqual(wm.retrieve_segment(name, out)[0], 0)
        self.assertEqual(open(out, "rb").read(), open(src, "rb").read())
        self.assertEqual(wm.archive_segment(src, name)[3].split(" ")[0], "already", "idempotent")
        nokey = WalManager(wal, compression="zlib", segment_size=MB)
        self.assertEqual(nokey.retrieve_segment(name, out + "2")[0], 126)
        other = WalManager(wal, compression="zlib", segment_size=MB, crypto=crypt.Crypto(self.key2))
        self.assertEqual(other.retrieve_segment(name, out + "3")[0], 126)
        self.assertFalse(os.path.exists(out + "2") or os.path.exists(out + "3"))


if __name__ == "__main__":
    unittest.main()
