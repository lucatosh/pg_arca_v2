"""Test hygiene: every temporary file or directory a test (or the code it drives) creates through `tempfile` lands in ONE directory per test process,
removed when the process ends. Hundreds of mkdtemp() leftovers per run filled /tmp and then made the restore pre-flight refuse for lack of space
(found during the 16/10 campaign). PG_ARCA_TEST_KEEP_TMP=1 keeps it for a post-mortem."""
import atexit
import os
import shutil
import tempfile

if not os.environ.get("PG_ARCA_TEST_KEEP_TMP"):
    _base = os.environ.get("TMPDIR") or "/tmp"
    _root = tempfile.mkdtemp(prefix="pgarca-tests-", dir=_base if os.path.isdir(_base) else None)
    os.chmod(_root, 0o755)              # traversable: some tests check access as another OS user inside their own (0700) directories
    tempfile.tempdir = _root
    atexit.register(shutil.rmtree, _root, True)
