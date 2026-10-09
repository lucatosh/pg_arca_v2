"""Optional repository encryption (AES-256-GCM) with a key that lives OUTSIDE the repository.

  key file : 32 random bytes, base64 or hex encoded, mode 0600, owned by the agent user. `pg-arca-keygen` / generate_key() creates it.
  sub keys : derived from the master key with HMAC-SHA256 (labels enc / id / meta) so one key never serves two purposes.
  chunk id : keyed BLAKE2b-256 of the plaintext -> the repository cannot be probed for "do you contain this block" without the key.
  blob     : b"E" + 12-byte random nonce + AES-GCM(ciphertext+tag); the associated data binds the blob to its name/purpose,
             so a valid blob cannot be moved to another chunk id / file.
Compression happens BEFORE encryption (otherwise it is useless). The key is never logged and never sent to the console.
Losing the key means losing the data: back it up separately (the UI says so).
"""

import base64
import binascii
import hashlib
import hmac
import os
import stat

from pg_arca.engine.util import EngineError

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
except Exception:                                              # optional dependency
    AESGCM = None
    InvalidTag = Exception

TAG = b"E"


def available():
    return AESGCM is not None


def generate_key(path):
    if os.path.exists(path):
        raise EngineError("PGA-ENC-010", "key file already exists: %s" % path, "refusing to overwrite a key: losing it makes the repository unreadable")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, base64.b64encode(os.urandom(32)) + b"\n")
        os.fsync(fd)
    finally:
        os.close(fd)
    return path


def _read_key(path):
    try:
        st = os.stat(path)
    except OSError as e:
        raise EngineError("PGA-ENC-001", "encryption key file not readable: %s (%s)" % (path, e.strerror))
    if st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise EngineError("PGA-ENC-003", "key file %s is accessible to other users (mode %o)" % (path, st.st_mode & 0o777), "chmod 600 %s" % path)
    with open(path, "rb") as kf:
        raw = kf.read().strip()
    for dec in (lambda r: base64.b64decode(r, validate=True), lambda r: binascii.unhexlify(r)):
        try:
            k = dec(raw)
            if len(k) == 32:
                return k
        except (ValueError, binascii.Error):
            continue
    raise EngineError("PGA-ENC-004", "key file %s must contain 32 bytes encoded as base64 or hex" % path)


class Crypto(object):
    def __init__(self, key_path):
        if AESGCM is None:
            raise EngineError("PGA-ENC-002", "encryption needs the python 'cryptography' package", "pip install cryptography")
        master = _read_key(key_path)
        self._enc = hmac.new(master, b"pg_arca/enc/v1", hashlib.sha256).digest()
        self._id = hmac.new(master, b"pg_arca/id/v1", hashlib.sha256).digest()
        self._aes = AESGCM(self._enc)
        self.key_id = hashlib.sha256(self._id).hexdigest()[:16]       # public fingerprint, reveals nothing usable about the key

    def chunk_id(self, data):
        return hashlib.blake2b(data, digest_size=32, key=self._id).hexdigest()

    def seal(self, data, aad):
        nonce = os.urandom(12)
        return TAG + nonce + self._aes.encrypt(nonce, data, aad.encode("utf-8"))

    def open(self, blob, aad):
        if not blob or blob[:1] != TAG or len(blob) < 29:
            raise EngineError("PGA-ENC-020", "object is not encrypted with a pg_arca key")
        try:
            return self._aes.decrypt(blob[1:13], blob[13:], aad.encode("utf-8"))
        except InvalidTag:
            raise EngineError("PGA-ENC-021", "decryption failed for %s: wrong key or the object was modified/corrupted" % aad)


def from_settings(key_file):
    return Crypto(key_file) if key_file else None


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == "keygen":
        generate_key(sys.argv[2])
        sys.stdout.write("key written to %s (mode 600). Back it up OUTSIDE this host: without it the repository cannot be read.\n" % sys.argv[2])
    else:
        sys.stderr.write("usage: python3 -m pg_arca.engine.crypt keygen <path>\n")
        sys.exit(2)
