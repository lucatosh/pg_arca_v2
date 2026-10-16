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
        raw = r.get_blob(h)
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
        r.flush()
        p, off, ln = r.locate(h)
        with open(p, "r+b") as f:                                         # flip the last byte of the stored blob, in place
            f.seek(off + ln - 1)
            b = f.read(1)
            f.seek(off + ln - 1)
            f.write(bytes([b[0] ^ 1]))
        with self.assertRaises(EngineError):
            r.get_chunk(h)                                                # authenticated: bit flips are detected

    def test_blob_cannot_be_moved_to_another_id(self):
        r = self.repo(self.c)
        h1, _, _ = r.put_chunk(b"one" * 1000)
        h2, _, _ = r.put_chunk(b"two" * 1000)
        r.flush()
        p1, o1, l1 = r.locate(h1)
        p2, o2, l2 = r.locate(h2)
        self.assertEqual(l1, l2, "same size blobs: the test moves one over the other")
        blob1 = open(p1, "rb").read()[o1:o1 + l1]
        with open(p2, "r+b") as f:                                        # blob of h1 stored under h2's slot
            f.seek(o2)
            f.write(blob1)
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

    def test_encrypted_wal_without_meta_is_recovered_not_split_brain(self):
        """The writer died between publishing the encrypted object and writing its meta (independent review): the retry must recognise the same
        content (and write the missing meta), and a restore must decrypt it - not 'divergent' / 'not encrypted' forever."""
        wal = os.path.join(self.t, "wal")
        for comp in ("zlib", "none"):
            wm = WalManager(wal + comp, compression=comp, segment_size=MB, crypto=self.c)
            src = os.path.join(self.t, "seg" + comp)
            open(src, "wb").write((b"WALDATA-" * 1024 * 128)[:MB])
            name = "000000010000000000000002"
            ok, dest, sha, msg = wm.archive_segment(src, name)
            os.unlink(os.path.join(wal + comp, name + ".meta"))          # the crash window
            out = os.path.join(self.t, "out-" + comp)
            self.assertEqual(wm.retrieve_segment(name, out)[0], 0, comp)
            self.assertEqual(open(out, "rb").read(), open(src, "rb").read())
            ok, _d, _s, msg = wm.archive_segment(src, name)
            self.assertTrue(ok, comp)
            self.assertTrue(msg.startswith("already"), msg)
            meta = __import__("json").load(open(os.path.join(wal + comp, name + ".meta")))
            self.assertEqual(meta.get("enc"), "aes-256-gcm", comp)
            self.assertEqual(meta.get("sha256"), sha)
            os.unlink(out)
            self.assertEqual(wm.retrieve_segment(name, out)[0], 0, comp + " with the repaired meta")


if __name__ == "__main__":
    unittest.main()
