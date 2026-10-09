"""Executor operations for pg_hba.conf: read / plan (simulate) / apply (with verification and rollback) / rollback."""
import difflib
import glob
import json
import os
import shutil
import tempfile
import time

from pg_arca import hba

KEEP_BACKUPS = 10
SQL_RULES = ("SELECT COALESCE(json_agg(r ORDER BY line_number),'[]'::json) FROM (SELECT line_number, type, database, user_name, address, netmask, auth_method, options, error "
             "FROM pg_hba_file_rules) r;")
SQL_REPL = ("SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT r.usename AS \"user\", r.client_addr::text AS address, COALESCE(s.ssl,false) AS ssl "
            "FROM pg_stat_replication r LEFT JOIN pg_stat_ssl s USING (pid) WHERE r.client_addr IS NOT NULL) x;")
SQL_ROLES = "SELECT COALESCE(json_agg(rolname ORDER BY rolname),'[]'::json) FROM pg_roles WHERE rolcanlogin AND rolname !~ '^pg_';"
SQL_DBS = "SELECT COALESCE(json_agg(datname ORDER BY datname),'[]'::json) FROM pg_database WHERE datallowconn;"


SOFT = ("cannot match because SSL is disabled", "cannot match because GSSAPI is disabled")


def hard_errors(rows):
    """pg_hba_file_rules reports 'hostssl cannot match because SSL is disabled' as an error although the file loads fine: that is a warning."""
    return [r for r in rows if r.get("error") and not any(x in r["error"] for x in SOFT)]


class _Src(object):
    """Where the effective pg_hba text lives: the file, or Patroni's DCS list (Patroni rewrites the file from it)."""

    def __init__(self, ex, err):
        self.ex, self.err = ex, err
        ex._require_pg()
        ok, out, e = ex.db.run_psql("SHOW hba_file;")
        if not ok or not out.strip():
            raise err("cannot determine hba_file: %s" % e)
        self.path = out.strip()
        self.patroni = False
        self.dcs_list = None
        if ex.patroni.configured and ex._patroni_accessible():
            st, cfg = ex.patroni.get_config()
            if st == 200 and isinstance((cfg.get("postgresql") or {}).get("pg_hba"), list):
                self.patroni = True
                self.dcs_list = [str(x) for x in cfg["postgresql"]["pg_hba"]]

    def text(self):
        if self.patroni:
            return "\n".join(self.dcs_list) + "\n"
        with open(self.path, "r", encoding="utf-8") as f:
            return f.read()

    def file_text(self):
        with open(self.path, "r", encoding="utf-8") as f:
            return f.read()


def _json(ex, sql, err, default):
    d, e = ex.db.query_json(sql)
    if d is None and e:
        raise err("query failed: %s" % e)
    return d if d is not None else default


def _live_probes(ex, err):
    probes = [{"label": "locale: utente postgres (peer)", "type": "local", "database": "postgres", "user": "postgres", "ssl": False, "critical": True}]
    for r in _json(ex, SQL_REPL, err, []):
        probes.append({"label": "replica %s (%s)" % (r["address"], r["user"]), "type": "host", "ssl": bool(r.get("ssl")), "database": "replication", "user": r["user"],
                       "address": str(r["address"]).split("/")[0], "replication": True, "critical": True})
    return probes


def _extra_probes(p, err):
    out = []
    for i, x in enumerate(p.get("probes") or []):
        try:
            t = "local" if x.get("type") == "local" else "host"
            q = {"label": str(x.get("label") or "sonda %d" % (i + 1))[:80], "type": t, "database": str(x["database"]), "user": str(x["user"]), "ssl": bool(x.get("ssl", True)), "critical": False}
            if t == "host":
                q["address"] = str(x["address"])
                import ipaddress
                ipaddress.ip_address(q["address"])
            out.append(q)
        except (KeyError, ValueError, TypeError):
            raise err("probe %d is invalid (type, database, user, address)" % (i + 1))
    return out[:30]


def _simulate(old_text, new_text, probes):
    old = [x["rule"] for x in hba.parse_file(old_text)[0]]
    new = [x["rule"] for x in hba.parse_file(new_text)[0]]
    rows, lock = [], []
    for pr in probes:
        b, a = hba.decide(old, pr), hba.decide(new, pr)
        row = {"label": pr["label"], "before": b["allowed"], "after": a["allowed"], "method_before": b["method"], "method_after": a["method"], "uncertain": b["uncertain"] or a["uncertain"], "critical": pr["critical"]}
        rows.append(row)
        if b["allowed"] and not a["allowed"]:
            lock.append(row)
    return rows, lock


def _ssl_on(ex):
    ok, out, _ = ex.db.run_psql("SHOW ssl;")
    return ok and out.strip() == "on"


def read(ex, p, err):
    src = _Src(ex, err)
    text = src.text()
    rules, includes = hba.parse_file(text)
    managed = hba.extract_block(text)
    eff = _json(ex, SQL_RULES, err, [])
    return {"hba_file": src.path, "mode": "patroni" if src.patroni else "file", "rev": hba.file_rev(text), "raw": text[:200000], "truncated": len(text) > 200000,
            "managed": {"present": managed is not None, "rules": managed or [], "rev": hba.rules_rev(managed) if managed else None},
            "effective": eff, "errors": hard_errors(eff), "ssl": _ssl_on(ex), "has_includes": includes, "rule_count": len(rules),
            "suggest": {"replication_clients": _json(ex, SQL_REPL, err, []), "roles": _json(ex, SQL_ROLES, err, []), "databases": _json(ex, SQL_DBS, err, [])},
            "backups": sorted(os.path.basename(x) for x in glob.glob(src.path + ".pgarca-*"))[-KEEP_BACKUPS:]}


def _prepare(ex, p, err):
    src = _Src(ex, err)
    clean, errors, warnings = hba.validate_rules(p.get("rules"))
    if errors:
        raise err("invalid rules: " + "; ".join("#%d: %s" % (e["index"] + 1, e["message"]) for e in errors))
    old = src.text()
    new = hba.apply_block(old, clean)
    return src, clean, warnings, old, new


def plan(ex, p, err):
    try:
        clean, errors, warnings = hba.validate_rules(p.get("rules"))
    except hba.HbaError as e:
        raise err(str(e))
    src = _Src(ex, err)
    if errors:
        return {"valid": False, "errors": errors, "warnings": warnings}
    old = src.text()
    new = hba.apply_block(old, clean)
    rows, lock = _simulate(old, new, _live_probes(ex, err) + _extra_probes(p, err))
    if not _ssl_on(ex) and any(r["type"] in ("hostssl", "hostgssenc") for r in clean):
        warnings.append({"index": -1, "message": "PostgreSQL has ssl=off on this node: hostssl rules will NOT match until TLS is enabled"})
    diff = list(difflib.unified_diff(old.split("\n"), new.split("\n"), "pg_hba (attuale)", "pg_hba (nuovo)", lineterm="", n=1))
    return {"valid": True, "errors": [], "warnings": warnings, "changed": old != new, "mode": "patroni" if src.patroni else "file", "base_rev": hba.file_rev(old),
            "diff": diff[:300], "simulation": rows, "would_lock_out": [r["label"] for r in lock if r["critical"]], "has_includes": hba.parse_file(old)[1]}


def _write_atomic(path, text):
    st = os.stat(path)
    fd, tmp = tempfile.mkstemp(prefix=".pgarca-hba-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, st.st_mode & 0o7777)
        try:
            os.chown(tmp, st.st_uid, st.st_gid)
        except (OSError, AttributeError):
            pass
        os.rename(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    dfd = os.open(os.path.dirname(path), os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def _reload_and_check(ex, path, err):
    ok, out, e = ex.db.run_psql("SELECT pg_reload_conf();")
    if not ok:
        raise err("pg_reload_conf failed: %s" % e)
    time.sleep(0.3)
    rows = _json(ex, SQL_RULES, err, [])
    return hard_errors(rows)


def apply(ex, p, err):
    src, clean, warnings, old, new = _prepare(ex, p, err)
    base = p.get("base_rev")
    cur_rev = hba.file_rev(old)
    if old == new:
        return {"changed": False, "mode": "patroni" if src.patroni else "file", "rev": cur_rev, "message": "already up to date"}
    if base and base != cur_rev:
        raise err("pg_hba changed since the plan was made (expected %s, found %s): re-run the plan" % (base, cur_rev))
    rows, lock = _simulate(old, new, _live_probes(ex, err) + _extra_probes(p, err))
    crit = [r["label"] for r in lock if r["critical"]]
    if crit and not p.get("force"):
        raise err("refused: this change would lock out: %s" % "; ".join(crit))
    if src.patroni:
        return _apply_patroni(ex, src, clean, new, cur_rev, err)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    bak = "%s.pgarca-%s" % (src.path, stamp)
    shutil.copy2(src.path, bak)
    for old_b in sorted(glob.glob(src.path + ".pgarca-*"))[:-KEEP_BACKUPS]:
        try:
            os.unlink(old_b)
        except OSError:
            pass
    _write_atomic(src.path, new)
    bad = _reload_and_check(ex, src.path, err)
    ok_block = hba.extract_block(src.file_text()) == (clean or None)
    if bad or not ok_block:
        shutil.copy2(bak, src.path)
        _reload_and_check(ex, src.path, err)
        raise err("verification failed, previous pg_hba restored (%s)" % ("; ".join("line %s: %s" % (b["line_number"], b["error"]) for b in bad) or "block mismatch"))
    return {"changed": True, "mode": "file", "rev": hba.file_rev(new), "backup": os.path.basename(bak), "rules": len(clean), "warnings": warnings}


def _apply_patroni(ex, src, clean, new_text, cur_rev, err):
    lst = new_text.rstrip("\n").split("\n")
    st, d = ex.patroni.patch_config({"postgresql": {"pg_hba": lst}})
    if st >= 300:
        raise err("Patroni rejected the change (%s): %s" % (st, json.dumps(d)[:300]))
    st2, cfg = ex.patroni.get_config()
    if st2 != 200 or (cfg.get("postgresql") or {}).get("pg_hba") != lst:
        raise err("verification failed: the DCS does not hold the new pg_hba list")
    deadline = time.time() + 45
    while time.time() < deadline:                       # Patroni rewrites pg_hba.conf and reloads on its next cycle
        try:
            if hba.extract_block(src.file_text()) == (clean or None) and not hard_errors(_json(ex, SQL_RULES, err, [])):
                return {"changed": True, "mode": "patroni", "rev": hba.file_rev(new_text), "rules": len(clean), "note": "propagated to every member through the DCS"}
        except IOError:
            pass
        time.sleep(2)
    raise err("the DCS was updated but this node did not pick the change up within 45 s; Patroni will still propagate it (check the Patroni log)")


def rollback(ex, p, err):
    src = _Src(ex, err)
    if src.patroni:
        raise err("this cluster is managed by Patroni: change the rules again (the previous list is not stored on the node)")
    baks = sorted(glob.glob(src.path + ".pgarca-*"))
    name = p.get("backup")
    pick = next((b for b in baks if os.path.basename(b) == name), None) if name else (baks[-1] if baks else None)
    if not pick:
        raise err("no pg_hba backup available")
    cur = src.file_text()
    shutil.copy2(src.path, src.path + ".pgarca-before-rollback")
    with open(pick, "r", encoding="utf-8") as bf:
        _write_atomic(src.path, bf.read())
    bad = _reload_and_check(ex, src.path, err)
    if bad:
        _write_atomic(src.path, cur)
        _reload_and_check(ex, src.path, err)
        raise err("the backup has errors, nothing changed")
    return {"restored": os.path.basename(pick)}
