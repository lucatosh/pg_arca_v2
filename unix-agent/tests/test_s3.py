"""S3 client: the signature against the AWS published test vector, then every operation against the in-process fake S3 (tests/fake_s3.py)."""
import os
import shutil
import tempfile
import unittest

from pg_arca.s3 import S3Client, S3Error, sign
from tests.fake_s3 import FakeS3


class Signature(unittest.TestCase):
    def test_aws_published_vector(self):
        # "get-vanilla-query" from the AWS Signature Version 4 test suite (iam, us-east-1, 2015-08-30T12:36:00Z)
        h = {"content-type": "application/x-www-form-urlencoded; charset=utf-8"}
        sig = sign("GET", "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08", h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                   "AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "us-east-1", "iam", "20150830T123600Z")
        self.assertEqual(sig, "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7")
        self.assertIn("SignedHeaders=content-type;host;x-amz-date", h["Authorization"])

    def test_s3_headers_and_key_encoding(self):
        h = {}
        sign("PUT", "https://b.s3.eu-west-1.amazonaws.com/a%20b/c+d.pack", h, "UNSIGNED-PAYLOAD", "AK", "SK", "eu-west-1")
        self.assertEqual(h["x-amz-content-sha256"], "UNSIGNED-PAYLOAD")
        self.assertTrue(h["Authorization"].startswith("AWS4-HMAC-SHA256 Credential=AK/"))


class Client(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = FakeS3()

    @classmethod
    def tearDownClass(cls):
        cls.srv.close()

    def c(self, prefix="site1", **kw):
        return S3Client(self.srv.endpoint, "backups", "AKTEST", "secret", region="us-east-1", prefix=prefix, **kw)

    def test_put_get_head_delete_list(self):
        c = self.c()
        et = c.put("repo/x.pack", b"hello world")
        self.assertEqual(len(et), 32)
        self.assertEqual(c.get("repo/x.pack"), b"hello world")
        self.assertEqual(c.get("repo/x.pack", 6, 5), b"world", "ranged read")
        self.assertEqual(c.get("repo/x.pack", 6), b"world", "open range")
        self.assertEqual(c.head("repo/x.pack")["size"], 11)
        self.assertIsNone(c.head("repo/nope"))
        with self.assertRaises(S3Error) as cm:
            c.get("repo/nope")
        self.assertEqual(cm.exception.status, 404)
        c.put("repo/y.idx", b"idx")
        c.put("wal/0000000100000000000000A1.zst", b"w" * 100)
        self.assertEqual(c.list("repo"), {"repo/x.pack": 11, "repo/y.idx": 3})
        self.assertEqual(set(c.list("")), {"repo/x.pack", "repo/y.idx", "wal/0000000100000000000000A1.zst"})
        self.assertEqual(self.c("site2").list(""), {}, "another prefix sees nothing")
        c.delete("repo/y.idx")
        c.delete("repo/y.idx")                                             # idempotent
        self.assertEqual(c.list("repo"), {"repo/x.pack": 11})
        self.assertIn("reachable", c.check())
        self.assertEqual(set(c.list("")), {"repo/x.pack", "wal/0000000100000000000000A1.zst"}, "the probe object is gone")

    def test_file_upload_download_and_pagination(self):
        c = self.c("big")
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "f.bin")
            data = os.urandom(3 * 1048576 + 17)
            with open(p, "wb") as f:
                f.write(data)
            c.put("f.bin", p)
            c.get_to_file("f.bin", os.path.join(d, "back.bin"))
            with open(os.path.join(d, "back.bin"), "rb") as f:
                self.assertEqual(f.read(), data)
            self.assertFalse(os.path.exists(os.path.join(d, "back.bin.part")))
            for i in range(1205):                                          # more than one ListObjectsV2 page
                c.put("many/%04d" % i, b"x")
            lst = c.list("many")
            self.assertEqual(len(lst), 1205)
            self.assertEqual(lst["many/1204"], 1)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_bad_credentials_and_unreachable(self):
        bad = S3Client(self.srv.endpoint, "backups", "WRONG", "secret", prefix="p")
        with self.assertRaises(S3Error) as cm:
            bad.list("")
        self.assertEqual(cm.exception.status, 403)
        down = S3Client("http://127.0.0.1:1", "backups", "AKTEST", "secret", timeout=2)
        with self.assertRaises(S3Error) as cm:
            down.head("x")
        self.assertEqual(cm.exception.code, "ConnectionError")

    def test_virtual_host_style_url(self):
        c = S3Client("https://s3.eu-central-1.amazonaws.com", "my-bucket", "AK", "SK", region="eu-central-1", prefix="pg/site", path_style=False)
        self.assertEqual(c._url("repo/a b.pack"), "https://my-bucket.s3.eu-central-1.amazonaws.com/repo/a%20b.pack")
        self.assertEqual(c._url(None, {"list-type": "2", "prefix": "pg/site/"}), "https://my-bucket.s3.eu-central-1.amazonaws.com/?list-type=2&prefix=pg%2Fsite%2F")
        self.assertEqual(c.key("/x"), "pg/site/x")


if __name__ == "__main__":
    unittest.main()
