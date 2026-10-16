"""Shared helpers: errors, codec, atomic JSON, LSN arithmetic, SQL quoting."""

import hashlib
import json
import os
import re
import tempfile
import time
import uuid
import zlib
from datetime import datetime, timedelta, timezone

try:
    import zstandard as _zstd
except ImportError:
    _zstd = None


class _StdZstd(object):
    """Python 3.14+ ships zstd in the standard library (compression.zstd): same on-disk format as the zstandard package, so repositories stay interchangeable."""
    def __init__(self, mod):
        self.m = mod

    def ZstdCompressor(self, level=3):
        m = self.m
        return type("C", (), {"compress": staticmethod(lambda data: m.compress(data, level=level))})()

    def ZstdDecompressor(self):
        m = self.m
        return type("D", (), {"decompress": staticmethod(lambda data: m.decompress(data))})()


if _zstd is None:
    try:
        from compression import zstd as _stdzstd                 # Python >= 3.14
        _zstd = _StdZstd(_stdzstd)
    except ImportError:
        pass

BLCKSZ = 8192
CHUNK_PAGES = 8
CHUNK_SIZE = BLCKSZ * CHUNK_PAGES          # 64 KiB: 8 PostgreSQL pages
HASH_NAME = "blake2b-256"


class EngineError(Exception):
    """A clean, user-presentable failure with a stable code (PGA-xxx-nnn) and an optional remediation hint."""

    def __init__(self, code, message, hint=None):
        Exception.__init__(self, "%s: %s" % (code, message))
        self.code = code
        self.message = message
        self.hint = hint

    def as_text(self):
        return "%s: %s%s" % (self.code, self.message, ("\n  hint: " + self.hint) if self.hint else "")


class Cancelled(EngineError):
    def __init__(self):
        EngineError.__init__(self, "PGA-GEN-099", "operation cancelled")


# ----------------------------------------------------------------------- time
def now_utc():
    return datetime.now(timezone.utc)


def iso(dt=None):
    return (dt or now_utc()).isoformat(timespec="seconds")


def human(n):
    n = float(n)
    for u in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024.0:
            return "%.1f %s" % (n, u)
        n /= 1024.0
    return "%.1f PiB" % n


# ----------------------------------------------------------------------- hashing & codec
def chunk_hash(data):
    return hashlib.blake2b(data, digest_size=32).hexdigest()


def have_zstd():
    return _zstd is not None


SAMPLE = 4096


def _incompressible(data):
    """Already compressed / encrypted / random data (bytea payloads, TOAST compressed with pglz or lz4, encrypted columns) does not shrink: compressing it costs
    CPU at backup AND restore for nothing. A 4 KiB sample (or two) compressed with the fastest setting tells; such chunks are stored as they are."""
    if len(data) < 2 * SAMPLE:
        return False
    mid = len(data) // 2
    for off in (0, mid):
        s = data[off:off + SAMPLE]
        if len(zlib.compress(s, 1)) < 0.92 * len(s):
            return False
    return True


def compress(data, algo=None, level=3):
    """Returns tag byte + payload. Tag 'S' = zstd, 'Z' = zlib, 'N' = stored (also for chunks that would not shrink)."""
    algo = algo or ("zstd" if _zstd is not None else "zlib")
    if algo == "none" or _incompressible(data):
        return b"N" + data
    if algo == "zstd" and _zstd is not None:
        out = _zstd.ZstdCompressor(level=level).compress(data)
        return b"S" + out if len(out) < len(data) else b"N" + data
    # no zstd on this host (python3-zstandard missing): zlib, at its fastest level unless zlib was asked for explicitly - level 3 costs ~15-30% more CPU
    # for ~1% of size on database pages (measured on the lab: 0.52 vs 0.53)
    zl = min(max(level, 1), 9) if algo == "zlib" else 1
    out = zlib.compress(data, zl)
    return b"Z" + out if len(out) < len(data) else b"N" + data


def decompress(blob):
    if not blob:
        raise EngineError("PGA-VRF-002", "empty chunk file")
    tag, body = blob[:1], blob[1:]
    if tag == b"Z":
        return zlib.decompress(body)
    if tag == b"N":
        return body
    if tag == b"S":
        if _zstd is None:
            # no python module here (SUSE 15, RHEL 8 without EPEL, Alpine, FreeBSD, another python3): the zstd command decodes the same frames, as
            # the WAL path already does - a repository written elsewhere stays restorable on a recovery host (portability review)
            import shutil
            import subprocess
            exe = shutil.which("zstd")
            if exe:
                r = subprocess.run([exe, "-d", "-c", "-q"], input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
                if r.returncode == 0:
                    return r.stdout
                raise EngineError("PGA-VRF-002", "zstd could not decode a repository chunk: %s" % r.stderr.decode("utf-8", "replace").strip()[:200])
            raise EngineError("PGA-REPO-030", "repository chunk is zstd-compressed but neither python 'zstandard' nor the zstd command is installed on this host",
                              "install python3-zstandard (or pip install zstandard) or the zstd package")
        return _zstd.ZstdDecompressor().decompress(body)
    raise EngineError("PGA-VRF-002", "unknown chunk encoding tag %r" % tag)


# ----------------------------------------------------------------------- files
def fsync_dir(path):
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def write_file_atomic(path, data, mode=0o600):
    """tmp + fsync + rename + fsync(dir): old or new, never torn."""
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.rename(tmp, path)
        fsync_dir(d)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_json(path, obj, compressed=False, mode=0o640):
    data = json.dumps(obj, sort_keys=True, indent=None if compressed else 2).encode("utf-8")
    if compressed:
        data = compress(data, "zlib", 6)
    write_file_atomic(path, data, mode)


def read_json(path, compressed=False):
    with open(path, "rb") as f:
        data = f.read()
    if compressed:
        data = decompress(data)
    return json.loads(data.decode("utf-8"))


def safe_relpath(rel):
    """Manifests come from a repository that may be damaged or hostile: never let a path escape the destination."""
    if not rel or rel.startswith("/") or "\x00" in rel:
        raise EngineError("PGA-VRF-030", "unsafe path in manifest: %r" % rel)
    parts = rel.split("/")
    if any(p in ("..", "") for p in parts):
        raise EngineError("PGA-VRF-030", "unsafe path in manifest: %r" % rel)
    return rel


def read_file(path, binary=False, first_line=False, errors=None):
    """Whole content (or the first line) of a file, closed at once: a long-running agent never leaves a file to the garbage collector."""
    # text: UTF-8 whatever the locale (Python 3.6 in the C locale read ASCII and failed on the first accented comment)
    with open(path, "rb" if binary else "r", **({} if binary else {"encoding": "utf-8", "errors": errors or "strict"})) as f:
        return f.readline() if first_line else f.read()


def tail_file(path, n=25):
    try:
        with open(path, "r", errors="replace") as f:
            return "".join("    " + l for l in f.readlines()[-n:])
    except (IOError, OSError):
        return "    (log not available)"


# ----------------------------------------------------------------------- LSN / WAL naming
def lsn_to_int(s):
    if s is None:
        return 0
    s = str(s).strip()
    if "/" not in s:
        try:
            return int(s)
        except ValueError:
            return 0
    hi, lo = s.split("/", 1)
    return (int(hi, 16) << 32) | int(lo, 16)


def int_to_lsn(v):
    return "%X/%08X" % (v >> 32, v & 0xFFFFFFFF)


def wal_segno(lsn, seg_size):
    return lsn // seg_size


def last_wal_segno(meta, seg_size):
    """Last WAL segment a backup set needs. The stop LSN of a backup taken on a STANDBY is the END (exclusive) of the last record it needed; when that falls exactly on a
    segment boundary the next segment is EMPTY (the primary has not written into it): demanding it would make the set wait for the archive forever."""
    stop = lsn_to_int(meta["stop_lsn"])
    if meta.get("from_standby") and stop > 0 and stop % seg_size == 0:
        stop -= 1
    return stop // seg_size


def wal_name(tli, segno, seg_size):
    per_id = 0x100000000 // seg_size
    return "%08X%08X%08X" % (tli, segno // per_id, segno % per_id)


def wal_name_from_lsn(tli, lsn, seg_size=16 * 1024 * 1024):
    return wal_name(tli, wal_segno(lsn, seg_size), seg_size)


def parse_wal_name(name, seg_size):
    """'000000010000000000000005' -> (tli, absolute segment number)"""
    m = re.match(r"^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})$", name)
    if not m:
        return None
    tli, log, seg = (int(x, 16) for x in m.groups())
    return tli, log * (0x100000000 // seg_size) + seg


# ----------------------------------------------------------------------- SQL
def sql_lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def quote_ident(s):
    return '"' + str(s).replace('"', '""') + '"'


def spec_part(s):
    """One part of an object path `db.schema.name` as the UI and the agent write it: as is, or double-quoted ("" for a quote) when it contains a dot or a quote."""
    s = str(s)
    return '"' + s.replace('"', '""') + '"' if ("." in s or '"' in s) else s


def spec_path(*parts):
    return ".".join(spec_part(p) for p in parts)


def split_spec(text):
    """Inverse of spec_path: 'db."a.b".t' -> ['db', 'a.b', 't']. Unquoted parts are taken literally (case kept). Raises ValueError when malformed."""
    out, cur, i, n, quoted = [], [], 0, len(text), False
    while i < n:
        ch = text[i]
        if ch == '"' and not cur and not quoted:
            j, buf = i + 1, []
            while True:
                if j >= n:
                    raise ValueError("unterminated quote")
                if text[j] == '"':
                    if j + 1 < n and text[j + 1] == '"':
                        buf.append('"')
                        j += 2
                        continue
                    break
                buf.append(text[j])
                j += 1
            cur, quoted, i = buf, True, j + 1
            if i < n and text[i] != ".":
                raise ValueError("text after a quoted part")
            continue
        if ch == ".":
            out.append("".join(cur))
            cur, quoted = [], False
            i += 1
            continue
        if quoted:
            raise ValueError("text after a quoted part")
        cur.append(ch)
        i += 1
    out.append("".join(cur))
    return out


def new_id(prefix):
    return "%s-%s" % (prefix, uuid.uuid4().hex[:8])


# ----------------------------------------------------------------------- target time
_TZ_RE = re.compile(r"([+-]\d{2}(:?\d{2})?|Z|UTC)\s*$")


def parse_target_time(s):
    """A recovery target time MUST carry an explicit UTC offset: an ambiguous instant is a top cause of wrong-time restores."""
    if s is None or s == "":
        return None
    if not _TZ_RE.search(str(s).strip()):
        raise EngineError("PGA-PITR-001", "target time must contain a UTC offset: %r" % s,
                          "valid examples: '2026-07-26 18:34:11+02'  '2026-07-26 16:34:11Z'")
    return _pg_time(str(s).strip())


def _pg_time(s):
    """Canonical form PostgreSQL accepts while it reads postgresql.auto.conf at startup: 'YYYY-MM-DD HH:MM:SS[.f]+HH[:MM]'.
    A 'T' separator or a 'Z'/'UTC' suffix is valid SQL but the GUC check runs before the timezone abbreviations are loaded, so the server then refuses to start
    ("invalid value for parameter recovery_target_time"). A browser's toISOString() produces exactly that form, so normalise it here."""
    t = re.sub(r"(?i)\s*(z|utc)$", "+00", s)
    return re.sub(r"^(\d{4}-\d{2}-\d{2})[Tt]", r"\1 ", t)


def target_time_to_dt(s):
    """Best-effort parse of an offset-qualified timestamp to aware datetime (for choosing the base backup)."""
    s = s.strip().replace("Z", "+00:00").replace(" UTC", "+00:00").replace("UTC", "+00:00")
    m = re.match(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*([+-]\d{2})(?::?(\d{2}))?$", s)
    if not m:
        return None
    frac = (m.group(3) or "")[:7]
    off = "%s:%s" % (m.group(4), m.group(5) or "00")
    try:
        return _dt(m.group(1), m.group(2), frac, off)
    except ValueError:
        return None


def _dt(d, t, frac, off):
    base = datetime.strptime("%s %s" % (d, t), "%Y-%m-%d %H:%M:%S")
    if frac:
        base = base.replace(microsecond=int((frac[1:] + "000000")[:6]))
    sign = 1 if off[0] == "+" else -1
    hh, mm = int(off[1:3]), int(off[4:6])
    return (base - sign * timedelta(hours=hh, minutes=mm)).replace(tzinfo=timezone.utc)
