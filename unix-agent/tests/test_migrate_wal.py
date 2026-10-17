"""Migrating a previous WAL archive into the current one: one object per segment whatever its codec, the same content is skipped, a DIFFERENT
version of the same segment is never overwritten nor lost (kept in the current archive's quarantine, and only then does the previous location
count as migrated)."""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pg_arca.engine import migrate


def put(d, base, raw_sha, codec=".zst", body=b"x"):
    with open(os.path.join(d, base + codec), "wb") as f:
        f.write(body)
    with open(os.path.join(d, base + ".meta"), "w") as f:
        json.dump({"sha256": raw_sha, "size": 16}, f)


class WalPlan(unittest.TestCase):
    def setUp(self):
        self.old, self.new = tempfile.mkdtemp(), tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.old); self.addCleanup(shutil.rmtree, self.new)

    def test_codec_does_not_duplicate_and_conflicts_are_kept_not_dropped(self):
        S1, S2, S3 = "000000010000000000000001", "000000010000000000000002", "000000010000000000000003"
        put(self.old, S1, "aa", ".gz"); put(self.new, S1, "aa", ".zst")              # same segment, other codec: skipped, no second copy
        put(self.old, S2, "bb"); put(self.new, S2, "cc")                              # same name, different content: conflict
        put(self.old, S3, "dd")                                                       # only in the old archive: copied
        with open(os.path.join(self.old, "00000002.history"), "w") as f:
            f.write("1\t0/3000000\tx\n")
        copy, conflicts, kept = migrate._wal_plan(self.old, self.new)
        self.assertEqual(sorted(copy), sorted(["00000002.history", S3 + ".meta", S3 + ".zst"]))
        self.assertEqual(copy[0], S3 + ".meta", "metas first")
        self.assertEqual(sorted(conflicts), [S2]); self.assertEqual(kept, {})

        class Ctx:
            wal_dir = self.new
            logs = []
            def log(self, lvl, m): self.logs.append(m)
        # what the migration does with the conflict: a verified copy into conflicts/migrated/<segment>/, the current version untouched
        kd = migrate._kept_dir(self.old, self.new, S2, conflicts[S2])
        os.makedirs(kd)
        for f in conflicts[S2]:
            migrate._copy_verified(os.path.join(self.old, f), os.path.join(kd, f))
        copy2, conflicts2, kept2 = migrate._wal_plan(self.old, self.new)
        self.assertEqual(conflicts2, {}); self.assertEqual(sorted(kept2), [S2])
        with open(os.path.join(self.new, S2 + ".meta")) as f:
            self.assertEqual(json.load(f)["sha256"], "cc", "the current archive's version is never overwritten")
        # a THIRD version (another previous location) under the same name and codec is not "already kept"
        third = tempfile.mkdtemp(); self.addCleanup(shutil.rmtree, third)
        put(third, S2, "ee")
        self.assertEqual(sorted(migrate._wal_plan(third, self.new)[1]), [S2])

    def test_what_the_current_archive_set_aside_is_not_copied_back(self):
        H = "00000003.history"; S = "000000030000000000000004"
        for d in (self.old,):
            with open(os.path.join(d, H), "w") as f:
                f.write("2\t0/5000000\tx\n")
            put(d, S, "dead")
        dd = os.path.join(self.new, "conflicts", "dead-branch-00000003"); os.makedirs(dd)
        shutil.copy(os.path.join(self.old, H), dd); shutil.copy(os.path.join(self.old, S + ".zst"), dd); shutil.copy(os.path.join(self.old, S + ".meta"), dd)
        with open(os.path.join(dd, "RETIRED.json"), "w") as f:
            f.write("{}")
        self.assertEqual(migrate._wal_plan(self.old, self.new), ([], {}, {}), "a retired dead branch is never resurrected by a migration")
        put(self.old, S, "other-dead-version")
        self.assertEqual(sorted(migrate._wal_plan(self.old, self.new)[1]), [S], "a different version is still kept, not dropped")

    def test_files_without_meta_compare_their_bytes(self):
        with open(os.path.join(self.old, "00000002.history"), "w") as f:
            f.write("1\t0/3000000\tx\n")
        shutil.copy(os.path.join(self.old, "00000002.history"), self.new)
        self.assertEqual(migrate._wal_plan(self.old, self.new), ([], {}, {}))
        with open(os.path.join(self.new, "00000002.history"), "w") as f:
            f.write("1\t0/4000000\tx\n")
        self.assertEqual(sorted(migrate._wal_plan(self.old, self.new)[1]), ["00000002.history"])


if __name__ == "__main__":
    unittest.main()
