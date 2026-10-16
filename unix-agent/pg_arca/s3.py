"""Minimal S3 client on the standard library (Python 3.6+): Signature Version 4, path-style or virtual-host URLs, ranged reads, ListObjectsV2.
Works with AWS S3 and S3-compatible stores (MinIO, Ceph RGW, Wasabi, ...). No multipart: a single PUT takes objects up to 5 GB, and pg_arca's
objects (packs of 256 MiB, WAL segments, manifests) are far below that.
"""

import time
import hashlib
import hmac
import os
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UNSIGNED = "UNSIGNED-PAYLOAD"


class S3Error(Exception):
    def __init__(self, status, code, message, key=None):
        Exception.__init__(self, "%s %s: %s%s" % (status, code, message, (" (%s)" % key) if key else ""))
        self.status, self.code, self.key = status, code, key


def _uri_encode(s, keep_slash=False):
    return urllib.parse.quote(s, safe="/-_.~" if keep_slash else "-_.~")


def sign(method, url, headers, payload_hash, access_key, secret_key, region, service="s3", amz_date=None):
    """Adds x-amz-date / x-amz-content-sha256 (s3) / Authorization to `headers` (a dict, modified) for `url`. Returns the signature (hex)."""
    u = urllib.parse.urlsplit(url)
    amz_date = amz_date or time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    date = amz_date[:8]
    headers["x-amz-date"] = amz_date
    if service == "s3":
        headers["x-amz-content-sha256"] = payload_hash
    host = u.netloc
    headers["host"] = host
    canon_headers = sorted((k.lower(), " ".join(str(v).split())) for k, v in headers.items())
    signed = ";".join(k for k, _ in canon_headers)
    query = sorted(urllib.parse.parse_qsl(u.query, keep_blank_values=True))
    canon_query = "&".join("%s=%s" % (_uri_encode(k), _uri_encode(v)) for k, v in query)
    canon_uri = _uri_encode(u.path or "/", keep_slash=True) if service == "s3" else urllib.parse.quote(urllib.parse.quote(u.path or "/", safe="/-_.~"), safe="/-_.~%")
    canonical = "\n".join([method, canon_uri, canon_query, "".join("%s:%s\n" % kv for kv in canon_headers), signed, payload_hash])
    scope = "%s/%s/%s/aws4_request" % (date, region, service)
    sts = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode("utf-8")).hexdigest()])
    k = ("AWS4" + secret_key).encode("utf-8")
    for part in (date, region, service, "aws4_request"):
        k = hmac.new(k, part.encode("utf-8"), hashlib.sha256).digest()
    sig = hmac.new(k, sts.encode("utf-8"), hashlib.sha256).hexdigest()
    headers["Authorization"] = "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s" % (access_key, scope, signed, sig)
    return sig


class S3Client(object):
    def __init__(self, endpoint, bucket, access_key, secret_key, region="us-east-1", prefix="", path_style=True, tls_verify=True, ca_file=None, timeout=60):
        self.endpoint = endpoint.rstrip("/")
        self.bucket = bucket
        self.ak, self.sk = access_key, secret_key
        self.region = region or "us-east-1"
        self.prefix = prefix.strip("/")
        self.path_style = path_style
        self.timeout = timeout
        ctx = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
        if not tls_verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), _NoRedirect())

    # ---- urls
    def key(self, name):
        return (self.prefix + "/" + name.lstrip("/")) if self.prefix else name.lstrip("/")

    def _url(self, key=None, query=None):
        u = urllib.parse.urlsplit(self.endpoint)
        if self.path_style:
            path = "/" + self.bucket + ("/" + key if key else "")
            netloc = u.netloc
        else:
            path = "/" + key if key else "/"
            netloc = self.bucket + "." + u.netloc
        q = urllib.parse.urlencode(query, safe="-_.~") if query else ""
        return urllib.parse.urlunsplit((u.scheme, netloc, _uri_encode(path, keep_slash=True), q, ""))

    # ---- one request
    def _req(self, method, key=None, query=None, data=None, headers=None, payload_hash=None, stream=False):
        url = self._url(key, query)
        h = dict(headers or {})
        if data is not None and not isinstance(data, bytes):
            data = data.read() if hasattr(data, "read") else bytes(data)
        if payload_hash is None:
            payload_hash = hashlib.sha256(data).hexdigest() if data is not None else hashlib.sha256(b"").hexdigest()
        if data is not None:
            h["content-length"] = str(len(data))
        sign(method, url, h, payload_hash, self.ak, self.sk, self.region)
        req = urllib.request.Request(url, data=data, method=method)
        for k, v in h.items():
            if k.lower() != "host":
                req.add_header(k, v)
        try:
            resp = self.opener.open(req, timeout=self.timeout)
        except urllib.error.HTTPError as e:
            body = e.read() or b""
            code, msg = _parse_error(body)
            if e.code == 404:
                code = code or "NoSuchKey"
            raise S3Error(e.code, code or "HTTPError", msg or e.reason, key)
        except (urllib.error.URLError, socket.timeout, OSError) as e:
            raise S3Error(0, "ConnectionError", str(getattr(e, "reason", e)), key)
        if stream:
            return resp
        try:
            return resp.status, dict((k.lower(), v) for k, v in resp.getheaders()), resp.read()
        finally:
            resp.close()

    # ---- operations
    def put(self, name, data, content_type="application/octet-stream"):
        """Upload bytes or a file path. Returns the ETag."""
        if isinstance(data, str):
            # a path: opened here, so a file removed since the inventory (GC, retention) is a FileNotFoundError the caller handles - not the
            # path string uploaded as the object, nor a TypeError that ended the whole cycle (independent offsite review)
            with open(data, "rb") as f:
                data = f.read()
        st, hd, _ = self._req("PUT", self.key(name), data=data, headers={"content-type": content_type})
        return hd.get("etag", "").strip('"')

    def get(self, name, offset=None, length=None):
        """Object content, or a byte range (offset, length)."""
        h = {}
        if offset is not None:
            h["range"] = "bytes=%d-%s" % (offset, (offset + length - 1) if length else "")
        st, hd, body = self._req("GET", self.key(name), headers=h)
        return body

    def get_to_file(self, name, path, expect_size=None):
        """Download into `path` (via path.part). A connection closed early reads as a clean end of data in http.client: the byte count is
        checked against Content-Length and the size the listing gave, or the download fails (independent offsite review: a truncated pack
        was renamed into place, then uploaded over the good object)."""
        resp = self._req("GET", self.key(name), stream=True)
        tmp = path + ".part"
        try:
            want = resp.getheader("content-length") if hasattr(resp, "getheader") else None
            want = int(want) if want and str(want).isdigit() else None
            got = 0
            with open(tmp, "wb") as f:
                while True:
                    buf = resp.read(1048576)
                    if not buf:
                        break
                    f.write(buf)
                    got += len(buf)
                f.flush()
                os.fsync(f.fileno())
            for w in (want, expect_size):
                if w is not None and got != int(w):
                    raise S3Error(0, "IncompleteRead", "downloaded %d bytes of %d" % (got, int(w)), self.key(name))
            os.rename(tmp, path)
        finally:
            resp.close()
            if os.path.exists(tmp):
                os.unlink(tmp)

    def head(self, name):
        """{"size", "etag", "modified"} or None when absent."""
        try:
            st, hd, _ = self._req("HEAD", self.key(name))
        except S3Error as e:
            if e.status == 404:
                return None
            raise
        return {"size": int(hd.get("content-length") or 0), "etag": hd.get("etag", "").strip('"'), "modified": hd.get("last-modified")}

    def delete(self, name):
        try:
            self._req("DELETE", self.key(name))
        except S3Error as e:
            if e.status != 404:
                raise

    def list(self, prefix=""):
        """{name without the client prefix: size} of every object under `prefix` (paginated ListObjectsV2)."""
        out = {}
        full = self.key(prefix) if prefix else self.prefix
        token = None
        while True:
            q = {"list-type": "2", "max-keys": "1000"}
            if full:
                q["prefix"] = full if full.endswith("/") or not self.prefix or prefix else full + "/"
            if token:
                q["continuation-token"] = token
            st, hd, body = self._req("GET", None, query=q)
            root = ET.fromstring(body)
            ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
            for c in root.findall(ns + "Contents"):
                k = c.findtext(ns + "Key") or ""
                if self.prefix and k.startswith(self.prefix + "/"):
                    k = k[len(self.prefix) + 1:]
                out[k] = int(c.findtext(ns + "Size") or 0)
            token = root.findtext(ns + "NextContinuationToken") if (root.findtext(ns + "IsTruncated") or "").lower() == "true" else None
            if not token:
                return out

    def check(self):
        """Can we list and write here? Returns a short description or raises S3Error."""
        self.list("")
        probe = ".pg_arca_probe"
        self.put(probe, b"ok")
        got = self.get(probe)
        self.delete(probe)
        if got != b"ok":
            raise S3Error(0, "ReadBack", "the object written could not be read back identical")
        return "bucket %s reachable, list/put/get/delete ok" % self.bucket


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _parse_error(body):
    try:
        root = ET.fromstring(body)
        return root.findtext("Code") or "", root.findtext("Message") or ""
    except Exception:
        return "", body.decode("utf-8", "replace")[:300]
