"""How the agent reaches the local PostgreSQL, whatever the installation: which psql, which role.

Nothing here assumes a distribution layout. The psql that is used is, in this order: the configured binaries directory, the directory of the RUNNING postmaster
(discovery), the PATH, then the usual vendor directories (Debian /usr/lib/postgresql/N/bin, PGDG /usr/pgsql-N/bin, /opt/..., EDB), newest major first. A systemd service
usually has a minimal PATH, so a PostgreSQL that is not on the PATH is the normal case on RHEL-like systems, not an exception.

The role is the configured one, or - when none is configured - the first of: the owner of the data directory (initdb creates its bootstrap superuser with the name of
the OS user that ran it: `postgres`, but also `pgsql`, `enterprisedb`, `pg16`...), the OS user the agent runs as (peer authentication maps the OS user name), `postgres`.
The first one that really connects wins, and the choice is remembered.
"""
import glob
import os
import pwd
import re
import shutil

VENDOR_GLOBS = ("/usr/lib/postgresql/*/bin", "/usr/pgsql-*/bin", "/opt/pgsql*/bin", "/usr/local/pgsql*/bin", "/opt/postgresql*/bin", "/opt/edb/as*/bin", "/usr/local/pg*/bin",
                "/usr/edb/as*/bin", "/usr/lib/edb-as/*/bin", "/usr/lib/postgresql[0-9]*/bin", "/usr/libexec/postgresql[0-9]*")


def _is_exe(p):
    return os.path.isfile(p) and os.access(p, os.X_OK)


def _major_key(path):
    m = re.search(r"(\d+)(?:\.\d+)?", os.path.basename(os.path.dirname(path)) if path.endswith("/bin") else path)
    return int(m.group(1)) if m else 0


def find_tool(name, config=None, inst=None, which=shutil.which, globber=glob.glob):
    """Absolute path of a PostgreSQL client/server tool, or the bare name when it cannot be found (the OS will then search the PATH and fail with a clear message)."""
    config, inst = config or {}, inst or {}
    for d in (config.get("pg_bin_dir"), inst.get("bin_dir"), inst.get("bindir")):
        if d and _is_exe(os.path.join(d, name)):
            return os.path.join(d, name)
    p = which(name)
    if p:
        return p
    cands = []
    for pat in VENDOR_GLOBS:
        cands += [d for d in globber(pat) if _is_exe(os.path.join(d, name))]
    if cands:
        return os.path.join(sorted(cands, key=lambda d: _major_key(d), reverse=True)[0], name)
    return name


def data_dir_owner(path):
    try:
        return pwd.getpwuid(os.stat(path).st_uid).pw_name
    except (OSError, KeyError):
        return None


def own_user():
    try:
        return pwd.getpwuid(os.geteuid()).pw_name
    except KeyError:
        return None


def candidate_users(config, inst):
    """[role] to try, best first. An explicitly configured role is the only candidate (the operator decided)."""
    explicit = (config or {}).get("pg_user")
    if explicit:
        return [explicit]
    out = []
    for u in (data_dir_owner((inst or {}).get("data_directory") or ""), own_user() if os.geteuid() != 0 else None, "postgres"):
        if u and u != "root" and u not in out:
            out.append(u)
    return out or ["postgres"]


def resolve_user(client, config, inst, probe=None):
    """Make `client.user` the first candidate role that connects. Returns the chosen role. `probe(user) -> bool` is injectable for tests."""
    cands = candidate_users(config, inst)
    if len(cands) == 1:
        client.user = cands[0]
        return cands[0]
    keep = client.user

    def ok(u):
        client.user = u
        return client.ping()
    for u in cands:
        if (probe(u) if probe else ok(u)):
            client.user = u
            return u
    client.user = keep if keep in cands else cands[0]
    return client.user
