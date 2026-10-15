"""A small S3-compatible server for tests (standard library): PUT/GET (with Range)/HEAD/DELETE objects, ListObjectsV2 with prefix and
pagination (max-keys), path-style URLs, XML errors like S3. It checks that every request carries a SigV4 Authorization header with the
expected access key (the signature itself is verified against the AWS test vector in test_s3.py). Objects live in memory."""
import hashlib
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from xml.sax.saxutils import escape


class FakeS3(object):
    def __init__(self, access_key="AKTEST", fail_every=0):
        self.objects = {}                                  # (bucket, key) -> bytes
        self.lock = threading.Lock()
        self.access_key = access_key
        self.requests = []
        self.fail_every = fail_every                       # every n-th PUT fails with 500 (retry tests)
        self.puts = 0
        srv = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def _err(self, status, code, msg):
                body = ('<?xml version="1.0"?><Error><Code>%s</Code><Message>%s</Message></Error>' % (code, escape(msg))).encode()
                self.send_response(status)
                self.send_header("content-type", "application/xml")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _auth(self):
                a = self.headers.get("Authorization") or ""
                if not a.startswith("AWS4-HMAC-SHA256 Credential=%s/" % srv.access_key) or "Signature=" not in a or not self.headers.get("x-amz-date"):
                    self._err(403, "AccessDenied", "bad or missing signature")
                    return False
                return True

            def _split(self):
                u = urllib.parse.urlsplit(self.path)
                parts = u.path.lstrip("/").split("/", 1)
                return parts[0], urllib.parse.unquote(parts[1]) if len(parts) > 1 else "", dict(urllib.parse.parse_qsl(u.query, keep_blank_values=True))

            def do_PUT(self):
                srv.requests.append(("PUT", self.path))
                if not self._auth():
                    return
                b, k, _ = self._split()
                n = int(self.headers.get("content-length") or 0)
                data = self.rfile.read(n)
                srv.puts += 1
                if srv.fail_every and srv.puts % srv.fail_every == 0:
                    return self._err(500, "InternalError", "simulated failure")
                with srv.lock:
                    srv.objects[(b, k)] = data
                self.send_response(200)
                self.send_header("ETag", '"%s"' % hashlib.md5(data).hexdigest())
                self.send_header("content-length", "0")
                self.end_headers()

            def do_HEAD(self):
                srv.requests.append(("HEAD", self.path))
                if not self._auth():
                    return
                b, k, _ = self._split()
                data = srv.objects.get((b, k))
                if data is None:
                    self.send_response(404)
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("content-length", str(len(data)))
                self.send_header("ETag", '"%s"' % hashlib.md5(data).hexdigest())
                self.send_header("Last-Modified", "Wed, 15 Oct 2026 00:00:00 GMT")
                self.end_headers()

            def do_GET(self):
                srv.requests.append(("GET", self.path))
                if not self._auth():
                    return
                b, k, q = self._split()
                if not k:                                      # list
                    prefix = q.get("prefix", "")
                    maxk = int(q.get("max-keys", "1000"))
                    start = q.get("continuation-token", "")
                    with srv.lock:
                        keys = sorted(kk for (bb, kk) in srv.objects if bb == b and kk.startswith(prefix) and kk > start)
                    page, trunc = keys[:maxk], len(keys) > maxk
                    xml = ['<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
                           "<Name>%s</Name><Prefix>%s</Prefix><KeyCount>%d</KeyCount><MaxKeys>%d</MaxKeys><IsTruncated>%s</IsTruncated>" % (b, escape(prefix), len(page), maxk, "true" if trunc else "false")]
                    if trunc:
                        xml.append("<NextContinuationToken>%s</NextContinuationToken>" % escape(page[-1]))
                    for kk in page:
                        xml.append("<Contents><Key>%s</Key><Size>%d</Size></Contents>" % (escape(kk), len(srv.objects[(b, kk)])))
                    xml.append("</ListBucketResult>")
                    body = "".join(xml).encode()
                    self.send_response(200)
                    self.send_header("content-type", "application/xml")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                data = srv.objects.get((b, k))
                if data is None:
                    return self._err(404, "NoSuchKey", "The specified key does not exist.")
                rng = self.headers.get("Range")
                status = 200
                if rng and rng.startswith("bytes="):
                    a, _, z = rng[6:].partition("-")
                    a = int(a)
                    z = int(z) if z else len(data) - 1
                    data = data[a:z + 1]
                    status = 206
                self.send_response(status)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_DELETE(self):
                srv.requests.append(("DELETE", self.path))
                if not self._auth():
                    return
                b, k, _ = self._split()
                with srv.lock:
                    srv.objects.pop((b, k), None)
                self.send_response(204)
                self.send_header("content-length", "0")
                self.end_headers()

        class TS(ThreadingMixIn, HTTPServer):
            daemon_threads = True
        self.httpd = TS(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        self.endpoint = "http://127.0.0.1:%d" % self.port
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
