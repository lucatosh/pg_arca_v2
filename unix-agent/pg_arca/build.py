"""Fingerprint of the agent code: the same files, hashed the same way, by the agent (what it runs) and by the console (what it serves for install
and upgrade - server/agentbuild.ts). Different fingerprints mean the agent is older (or newer) than the console: features of the console may be
missing on that node, and the console says so with the command that upgrades it. Files: pg-arca-agent.py and pg_arca/**/*.py (no tests, no caches),
path relative with '/', sorted; sha256 over path NUL content NUL; first 12 hex digits."""
import hashlib
import os

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def fingerprint(root=_ROOT):
    files = []
    pkg = os.path.join(root, "pg_arca")
    for dp, dn, fn in os.walk(pkg):
        dn[:] = sorted(d for d in dn if d not in ("__pycache__", "tests"))
        for f in fn:
            if f.endswith(".py"):
                files.append(os.path.relpath(os.path.join(dp, f), root).replace(os.sep, "/"))
    if os.path.isfile(os.path.join(root, "pg-arca-agent.py")):
        files.append("pg-arca-agent.py")
    h = hashlib.sha256()
    for rel in sorted(files):
        try:
            with open(os.path.join(root, rel), "rb") as f:
                data = f.read()
        except OSError:
            continue
        h.update(rel.encode() + b"\0" + data + b"\0")
    return h.hexdigest()[:12]


AGENT_BUILD = fingerprint()
