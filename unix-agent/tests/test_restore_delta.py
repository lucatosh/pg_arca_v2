"""Delta restore (over an existing copy of the data directory): a range no chunk of the chain covers was all zeros at backup time (an
incremental never keeps zero chunks), so the old copy's bytes there are zeroed too. Found by an independent review: pages written later
than the target survived a delta restore in such a range (valid heap pages with "future" tuples, undetectable by PostgreSQL). No PostgreSQL
needed."""
import os, shutil, tempfile, unittest
from pg_arca.engine.backup import backup_file
from pg_arca.engine.pgdata import ZEROPAGE
from pg_arca.engine.repo import Repo
from pg_arca.engine.restore import _write_one
from pg_arca.engine.util import BLCKSZ, CHUNK_SIZE
import struct

def page(lsn, fill):
    return struct.pack("<II", lsn >> 32, lsn & 0xFFFFFFFF) + bytes([fill]) * (BLCKSZ - 8)

class DeltaHoleTests(unittest.TestCase):
    def test_uncovered_ranges_are_zeroed_in_delta_mode(self):
        d = tempfile.mkdtemp(prefix="pgarca-delta-")
        try:
            repo = Repo(os.path.join(d, "repo"), "main", algo="zlib"); repo.init()
            src = os.path.join(d, "src", "base", "5"); os.makedirs(src)
            f = os.path.join(src, "f")
            with open(f, "wb") as fh:
                for i in range(8): fh.write(page(0x500 + i, 0x41))        # parent: 1 chunk
            e_full, _ = backup_file(repo, "base/5/16384", f, os.stat(f), 0, False)
            with open(f, "ab") as fh:
                fh.write(page(0x2000, 0x42))                               # child: grew by 16 pages: page 8 used, 9..23 zero (bulk extension)
                for i in range(9, 24): fh.write(ZEROPAGE)
            e_inc, _ = backup_file(repo, "base/5/16384", f, os.stat(f), 0x1000, True)
            repo.flush()
            # chunk 1 changed; chunk 2 is all zero and is kept too since the engine review of 16/10 (a zeroed range replaces what the parent had there;
            # deduplicated, it costs no space)
            self.assertEqual(sorted(c[0] for c in e_inc["chunks"]), [CHUNK_SIZE, 2 * CHUNK_SIZE])
            merged = {"size": e_inc["size"], "mode": 0o600, "kind": "pages", "chunks": {}}  # rel below is the relation path
            for off, ln, h in e_full["chunks"] + e_inc["chunks"]:
                merged["chunks"][off] = (ln, h)
            dest = os.path.join(d, "dest"); os.makedirs(dest)
            with open(os.path.join(dest, "f"), "wb") as fh:                # the old copy delta restores over: data in pages 16..23
                for i in range(24): fh.write(page(0x9000 + i, 0x5A))
            os.makedirs(os.path.join(dest, "base", "5")); shutil.move(os.path.join(dest, "f"), os.path.join(dest, "base", "5", "16384")); _write_one(repo, dest, "base/5/16384", merged, True)
            out = open(os.path.join(dest, "base", "5", "16384"), "rb").read()
            want = open(f, "rb").read()
            self.assertEqual(len(out), len(want))
            self.assertEqual(out, want, "the delta restore must give exactly the file of the backup, zero pages included")
            # a second delta pass over the correct result changes nothing (and reports nothing written)
            self.assertEqual(_write_one(repo, dest, "base/5/16384", merged, True), 0)
            self.assertEqual(open(os.path.join(dest, "base", "5", "16384"), "rb").read(), want)
        finally:
            shutil.rmtree(d, ignore_errors=True)

if __name__ == "__main__":
    unittest.main()
