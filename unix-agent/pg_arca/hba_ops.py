"""Executor operations for pg_hba.conf: read / plan (simulate) / apply (with verification and rollback) / rollback."""
import difflib
import errno
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
SQL_SUPER = "SELECT COALESCE(json_agg(rolname ORDER BY rolname),'[]'::json) FROM pg_roles WHERE rolsuper AND rolcanlogin;"
SQL_FACTS = ("SELECT json_build_object('password_encryption', current_setting('password_encryption'), 'ssl', current_setting('ssl'), "
             "'server_version_num', current_setting('server_version_num')::int);")


SOFT = ("cannot match because SSL is disabled", "cannot match because GSSAPI is disabled")


def hard_errors(rows):
    """pg_hba_file_rules reports 'hostssl cannot match because SSL is disabled' as an error although the file loads fine: that is a warning."""
    return [r for r in rows if r.get("error") and not any(x in r["error"] for x in SOFT)]


DCS_PATH = "Patroni DCS: postgresql.pg_hba"


def rule_from_effective(r):
    """One row of pg_hba_file_rules (what PostgreSQL has loaded) back to a pg_hba line. Used ONLY to show / seed what is in force on a Patroni member
    whose DCS has no pg_hba list yet: on Patroni nodes the agent never opens pg_hba.conf (Patroni owns it and rewrites it)."""
    if r.get("error"):
        return None
    q = lambda t: t if hba._TOKEN.match(t) or t.startswith("+") else '"%s"' % t.replace('"', "")
    db = ",".join(q(str(x)) for x in (r.get("database") or []))
    us = ",".join(q(str(x)) for x in (r.get("user_name") or []))
    t = r.get("type")
    if not t or not db or not us or not r.get("auth_method"):
        return None
    if t == "local":
        addr = ""
    else:
        addr = str(r.get("address") or "")
        nm = r.get("netmask")
        if addr and nm:
            import ipaddress
            try:                                # "addr/netmask" is not accepted for IPv6 by ipaddress: count the bits of the mask (both families)
                bits = bin(int(ipaddress.ip_address(nm))).count("1")
                addr = str(ipaddress.ip_network((addr, bits), strict=False))
            except ValueError:
                return None
        if not addr:
            return None
    opts = " ".join(str(o) for o in (r.get("options") or []))
    return hba.render_rule({"type": t, "database": db, "user": us, "address": addr, "method": r["auth_method"], "options": opts, "comment": ""})


class _Src(object):
    """Where the effective pg_hba lives.
    * plain PostgreSQL: the file named by `SHOW hba_file` (read, edited atomically, backed up next to it);
    * Patroni: ONLY the DCS list `postgresql.pg_hba` (REST GET/PATCH /config, the same call as `patronictl edit-config`). pg_hba.conf is never read nor written:
      Patroni regenerates it from the DCS on every member. When the DCS has no list yet, the rules PostgreSQL has loaded (pg_hba_file_rules) are shown and,
      on the first change, become the initial DCS list (seed) so nothing in force is lost."""

    def __init__(self, ex, err, need_pg=True):
        self.ex, self.err = ex, err
        self.patroni = False
        self.dcs_list = None
        self.seed = False
        self.seed_skipped = 0
        self.path = DCS_PATH
        if ex.patroni.configured:
            if not ex._patroni_accessible():
                raise err("this node is managed by Patroni but its REST API is not reachable: pg_hba is only read and changed through the DCS (patronictl edit-config), "
                          "never through pg_hba.conf. Restore the Patroni API access and retry")
            st, cfg = ex.patroni.get_config()
            if st != 200 or not isinstance(cfg, dict):
                raise err("cannot read the Patroni DCS configuration (HTTP %s)" % st)
            self.patroni = True
            self.cfg = cfg
            cur = (cfg.get("postgresql") or {}).get("pg_hba")
            if isinstance(cur, list):
                self.dcs_list = [str(x) for x in cur]
            else:
                self.seed = True
                if need_pg:
                    ex._require_pg()
            return
        ex._require_pg()
        ok, out, e = ex.db.run_psql("SHOW hba_file;")
        if not ok or not out.strip():
            raise err("cannot determine hba_file: %s" % e)
        self.path = out.strip()

    def external_hba_file(self):
        """Patroni generates pg_hba.conf from postgresql.pg_hba ONLY when no hba_file is configured: with a custom hba_file a DCS change would be ignored
        silently. Detected from what PostgreSQL reports (SHOW, not the file) and from the DCS parameters. Returns the path or None."""
        params = ((getattr(self, "cfg", None) or {}).get("postgresql") or {}).get("parameters") or {}
        if params.get("hba_file"):
            return str(params["hba_file"])
        try:
            ok1, hf, _ = self.ex.db.run_psql("SHOW hba_file;")
            ok2, dd, _ = self.ex.db.run_psql("SHOW data_directory;")
        except Exception:
            return None
        if ok1 and ok2 and hf.strip() and dd.strip() and os.path.realpath(hf.strip()) != os.path.realpath(os.path.join(dd.strip(), "pg_hba.conf")):
            return hf.strip()
        return None

    def require_managed(self):
        ext = self.external_hba_file()
        if ext:
            raise self.err("Patroni does not generate pg_hba on this cluster: hba_file is set to %s, so postgresql.pg_hba in the DCS would be ignored. "
                           "Remove hba_file from the Patroni configuration (then Patroni writes pg_hba.conf from the DCS list) or manage that file outside pg_arca" % ext)

    def text(self):
        if self.patroni:
            if not self.seed:
                return "\n".join(self.dcs_list) + "\n"
            rows = _json(self.ex, SQL_RULES, self.err, [])
            lines = [rule_from_effective(r) for r in rows]
            self.seed_skipped = sum(1 for x in lines if x is None)
            return "\n".join(x for x in lines if x) + "\n"
        with open(self.path, "r", encoding="utf-8", errors="surrogateescape") as f:
            return f.read()

    def file_text(self):
        if self.patroni:
            raise self.err("internal: pg_hba.conf is never read on a Patroni node")
        with open(self.path, "r", encoding="utf-8", errors="surrogateescape") as f:
            return f.read()


def _json(ex, sql, err, default):
    d, e = ex.db.query_json(sql)
    if d is None and e:
        raise err("query failed: %s" % e)
    return d if d is not None else default


def _live_probes(ex, err):
    me = getattr(ex.db, "user", None) or "postgres"                        # the role the agent really connects with (not always "postgres")
    host = getattr(ex.db, "host", "") or ""
    if host and not host.startswith("/") and not getattr(ex.db, "socket_dir", None):
        # the agent connects over TCP (pg_host = 127.0.0.1 or a name, typical in containers): THAT is the rule that must keep matching (independent
        # review: it was modelled as a local peer connection and removing the 127.0.0.1 line was not flagged)
        import socket as _socket
        try:
            addr = _socket.gethostbyname(host)
        except Exception:
            addr = "127.0.0.1" if host in ("localhost",) else host
        probes = [{"label": "the agent: host %s user %s" % (addr, me), "type": "host", "database": "postgres", "user": me, "ssl": False, "address": addr, "critical": True}]
    else:
        probes = [{"label": "local: user %s (peer)" % me, "type": "local", "database": "postgres", "user": me, "ssl": False, "critical": True}]
    if getattr(ex.patroni, "configured", False):
        users, _ = ex.db.query_json(SQL_REPL_USERS)
        probes += _patroni_local_probes([u for u in (users or []) if isinstance(u, str) and u])
    for r in _json(ex, SQL_REPL, err, []):
        probes.append({"label": "replication %s (%s)" % (r["address"], r["user"]), "type": "host", "ssl": bool(r.get("ssl")), "database": "replication", "user": r["user"],
                       "address": str(r["address"]).split("/")[0], "replication": True, "critical": True})
    return probes


SQL_REPL_USERS = ("SELECT COALESCE(json_agg(DISTINCT u),'[]'::json) FROM (SELECT usename AS u FROM pg_stat_replication WHERE usename IS NOT NULL "
                  "UNION SELECT substring(conninfo from 'user=([^ ]+)') FROM pg_stat_wal_receiver) x WHERE u IS NOT NULL;")


def _patroni_local_probes(users):
    """Patroni reads a replica's own timeline / LSN through a LOCAL replication connection (host localhost, the replication user). Without a pg_hba rule
    for it Patroni cannot tell that a replica diverged after a failover and never runs pg_rewind: the replica (or a whole standby site) stays stuck."""
    return [{"label": "Patroni: local replication 127.0.0.1 (%s)" % u, "type": "host", "ssl": False, "database": "replication", "user": u, "address": "127.0.0.1",
             "replication": True, "critical": True, "patroni_local": True} for u in users]


def patroni_local_check(db):
    """{ok, users, denied, suggest} for the local replication connection Patroni needs, decided on the rules PostgreSQL has loaded; None when it cannot be told
    (no replication in progress to learn the user from, or pg_hba_file_rules not readable by the agent's role)."""
    rows, e = db.query_json(SQL_RULES)
    if rows is None:
        return None
    users, _ = db.query_json(SQL_REPL_USERS)
    users = [u for u in (users or []) if u]
    if not users:
        return None
    rules = [r for r in (hba.parse_rule_line(rule_from_effective(x) or "") for x in rows if not x.get("error")) if r]
    denied = [u for u in users if hba.decide(rules, _patroni_local_probes([u])[0])["allowed"] is False]
    return {"ok": not denied, "users": users, "denied": denied,
            "suggest": ["host  replication  %s  127.0.0.1/32  scram-sha-256" % u for u in denied]}


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


def _pg_up(ex):
    try:
        ex._require_pg()
        return True
    except Exception:
        return False


def read(ex, p, err):
    src = _Src(ex, err, need_pg=False)
    pg = _pg_up(ex)
    if src.patroni and src.seed and not pg:
        raise err("the Patroni DCS has no pg_hba list yet and PostgreSQL is not running on this node, so the rules in force cannot be shown: try another member")
    if not pg and not src.patroni:
        ex._require_pg()
    text = src.text()
    rules, includes = hba.parse_file(text)
    managed = hba.extract_block(text)
    if not pg:      # Patroni member with PostgreSQL down: the DCS list is still readable and editable; live data comes from a running member
        return {"hba_file": src.path, "mode": "patroni", "dcs_seed": False, "seed_skipped": 0, "rev": hba.file_rev(text), "raw": text[:200000], "truncated": len(text) > 200000,
                "dcs_rules": [x["rule"] for x in rules if not x["in_block"]], "pg_down": True,
                "managed": {"present": managed is not None, "rules": managed or [], "rev": hba.rules_rev(managed) if managed else None},
                "effective": [], "errors": [], "ssl": None, "has_includes": includes, "rule_count": len(rules),
                "suggest": {"replication_clients": [], "roles": [], "databases": []}, "backups": []}
    eff = _json(ex, SQL_RULES, err, [])
    ext = src.external_hba_file() if src.patroni else None
    plc = patroni_local_check(ex.db) if src.patroni else None
    return {"patroni_local": plc, "hba_file": src.path, "mode": "patroni" if src.patroni else "file", "dcs_seed": src.seed, "seed_skipped": src.seed_skipped, "rev": hba.file_rev(text), "raw": text[:200000], "truncated": len(text) > 200000,
            "dcs_rules": [x["rule"] for x in rules if not x["in_block"]] if src.patroni else None, "external_hba_file": ext,
            "managed": {"present": managed is not None, "rules": managed or [], "rev": hba.rules_rev(managed) if managed else None},
            "effective": eff, "errors": hard_errors(eff), "ssl": _ssl_on(ex), "has_includes": includes, "rule_count": len(rules),
            "suggest": {"replication_clients": _json(ex, SQL_REPL, err, []), "roles": _json(ex, SQL_ROLES, err, []), "databases": _json(ex, SQL_DBS, err, [])},
            # what the cluster access matrix (every node -> every node) needs to propose the right rules: the users really used for
            # replication (streaming clients, and the WAL receiver's user on a standby), the superusers, and how passwords are hashed
            "facts": dict(_json(ex, SQL_FACTS, err, {}) or {}, replication_users=_json(ex, SQL_REPL_USERS, err, []), superusers=_json(ex, SQL_SUPER, err, [])),
            "backups": [] if src.patroni else sorted(os.path.basename(x) for x in glob.glob(src.path + ".pgarca-*"))[-KEEP_BACKUPS:]}


def _prepare(ex, p, err):
    src = _Src(ex, err)
    clean, errors, warnings = hba.validate_rules(p.get("rules"))
    if errors:
        raise err("invalid rules: " + "; ".join("#%d: %s" % (e["index"] + 1, e["message"]) for e in errors))
    old = src.text()
    base_text = old
    if p.get("adopt"):
        have = set(hba.render_rule(dict(r["rule"], comment="")) for r in hba.parse_file(old)[0] if not r["in_block"])
        want = set(hba.render_rule(dict(r, comment="")) for r in clean)
        lost = sorted(have - want)
        if lost:
            raise err("adopt would drop %d existing rule(s) not present in the new list, e.g. %s" % (len(lost), lost[0].replace("  ", " ")))
        base_text = hba.strip_unmanaged(old)
    new = hba.apply_block(base_text, clean)
    return src, clean, warnings, old, new


def plan(ex, p, err):
    try:
        clean, errors, warnings = hba.validate_rules(p.get("rules"))
    except hba.HbaError as e:
        raise err(str(e))
    src = _Src(ex, err)
    if errors:
        return {"valid": False, "errors": errors, "warnings": warnings}
    _, _, _, old, new = _prepare(ex, p, err)
    rows, lock = _simulate(old, new, _live_probes(ex, err) + _extra_probes(p, err))
    if not _ssl_on(ex) and any(r["type"] in ("hostssl", "hostgssenc") for r in clean):
        warnings.append({"index": -1, "message": "PostgreSQL has ssl=off on this node: hostssl rules will NOT match until TLS is enabled"})
    diff = list(difflib.unified_diff(old.split("\n"), new.split("\n"), "pg_hba (current)", "pg_hba (new)", lineterm="", n=1))
    return {"valid": True, "errors": [], "warnings": warnings, "changed": old != new, "mode": "patroni" if src.patroni else "file", "dcs_seed": src.seed, "base_rev": hba.file_rev(old),
            "diff": diff[:300], "simulation": rows, "would_lock_out": [r["label"] for r in lock if r["critical"]], "has_includes": hba.parse_file(old)[1]}


def _write_atomic(path, text):
    st = os.stat(path)
    fd, tmp = tempfile.mkstemp(prefix=".pgarca-hba-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", errors="surrogateescape") as f:
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


def _remember(ex, path):
    """Where pg_hba.conf and the data directory are, saved while PostgreSQL still answers: a rollback must work when it no longer lets the agent in."""
    try:
        ok, dd, _ = ex.db.run_psql("SHOW data_directory;")
        d = os.path.join((getattr(ex, "config", None) or {}).get("state_dir") or "/var/lib/pgarca/state", "hba-location.json")
        os.makedirs(os.path.dirname(d), exist_ok=True)
        with open(d + ".tmp", "w") as f:
            json.dump({"path": path, "pgdata": dd.strip() if ok else None}, f)
        os.rename(d + ".tmp", d)
    except Exception:
        pass


def _remembered(ex):
    try:
        with open(os.path.join((getattr(ex, "config", None) or {}).get("state_dir") or "/var/lib/pgarca/state", "hba-location.json")) as f:
            return json.load(f)
    except (IOError, OSError, ValueError):
        return {}


def _signal_reload(ex):
    """Reload the configuration WITHOUT a SQL session (the session may be what the new pg_hba refuses): SIGHUP to the postmaster."""
    import signal
    pgdata = _remembered(ex).get("pgdata")
    if not pgdata:
        return False
    try:
        with open(os.path.join(pgdata, "postmaster.pid")) as f:
            pid = int(f.readline().strip())
        os.kill(pid, signal.SIGHUP)
        return True
    except (IOError, OSError, ValueError):
        return False


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
        src.require_managed()
        return _apply_patroni(ex, src, clean, new, cur_rev, err, old_text=old)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    bak = "%s.pgarca-%s" % (src.path, stamp)
    try:
        shutil.copy2(src.path, bak)
    except OSError as e:                      # pg_hba.conf may live anywhere (/etc/..., a config volume): the agent's service may not be allowed to write there
        raise err("cannot write next to %s (%s). Give the agent's OS user write access to that directory%s" % (src.path, e.strerror or e,
                  "; with the systemd unit also add ReadWritePaths=%s in a drop-in (systemctl edit pg-arca-agent)" % os.path.dirname(src.path) if e.errno == errno.EROFS else ""))
    for old_b in sorted(glob.glob(src.path + ".pgarca-*"))[:-KEEP_BACKUPS]:
        try:
            os.unlink(old_b)
        except OSError:
            pass
    _remember(ex, src.path)
    _write_atomic(src.path, new)
    try:
        bad = _reload_and_check(ex, src.path, err)
    except Exception as e:
        # the new rules refuse the agent itself (force, or a client the simulation could not foresee): the previous file comes back at once and
        # is reloaded without SQL - before, the new file stayed and nothing could repair it from the console (independent review)
        shutil.copy2(bak, src.path)
        reloaded = _signal_reload(ex)
        raise err("the new pg_hba refused the agent's own connection (%s): the previous pg_hba was put back%s" % (
            getattr(e, "message", None) or e, " and reloaded" if reloaded else " - RELOAD PostgreSQL now (pg_ctl reload / systemctl reload) to make it effective"))
    ok_block = hba.extract_block(src.file_text()) == (clean or None)
    if bad or not ok_block:
        shutil.copy2(bak, src.path)
        _reload_and_check(ex, src.path, err)
        raise err("verification failed, previous pg_hba restored (%s)" % ("; ".join("line %s: %s" % (b["line_number"], b["error"]) for b in bad) or "block mismatch"))
    return {"changed": True, "mode": "file", "rev": hba.file_rev(new), "backup": os.path.basename(bak), "rules": len(clean), "warnings": warnings}


def _norm_key(line):
    r = hba.parse_rule_line(line)
    if not r:
        return None
    a = r["address"]
    if a and a not in ("all", "samehost", "samenet"):
        import ipaddress
        try:
            a = str(ipaddress.ip_network(a, strict=False))
        except ValueError:
            a = a.lower()
    split = lambda v: ",".join(x.strip().strip('"') for x in v.split(","))
    return (r["type"], split(r["database"]), split(r["user"]), a, r["method"])


def loaded_matches(ex, text, err):
    """True when the rules PostgreSQL has loaded on this node (pg_hba_file_rules) are exactly the rules of `text`, in order. This is how a Patroni change is
    verified: Patroni writes pg_hba.conf from the DCS and reloads; the agent only asks PostgreSQL what is in force, it never opens the file."""
    want = [k for k in (_norm_key(hba.render_rule(dict(x["rule"], comment=""))) for x in hba.parse_file(text)[0]) if k]
    rows = _json(ex, SQL_RULES, err, [])
    have = [k for k in (_norm_key(rule_from_effective(r) or "") for r in rows if not r.get("error")) if k]
    # with ssl=off (gssapi off) PostgreSQL loads hostssl (hostgssenc) lines as rows that carry only an error: they cannot be compared field by
    # field, so they are matched by count
    soft = {"hostssl": sum(1 for r in rows if r.get("error") and SOFT[0] in r["error"]), "hostgssenc": sum(1 for r in rows if r.get("error") and SOFT[1] in r["error"])}
    if soft["hostssl"] or soft["hostgssenc"]:
        skipped = {t: [k for k in want if k[0] == t] for t in soft}
        if all(len(skipped[t]) == soft[t] for t in soft if soft[t]):
            want = [k for k in want if not soft.get(k[0])]
    ok = want == have and not hard_errors(rows)
    if not ok:
        miss = [" ".join(k) for k in want if k not in have][:3]
        extra = [" ".join(k) for k in have if k not in want][:3]
        loaded_matches.last = "PostgreSQL has %d rule(s) loaded, the DCS list %d%s%s%s" % (len(have), len(want), "; not loaded: %s" % miss if miss else "",
                                                                                        "; loaded but not in the DCS: %s" % extra if extra else "",
                                                                                        "; errors: %s" % hard_errors(rows)[:2] if hard_errors(rows) else "")
    return ok


loaded_matches.last = ""


def _patch_dcs(ex, src, lst, err, wait=45):
    st, d = ex.patroni.patch_config({"postgresql": {"pg_hba": lst}})
    if st >= 300:
        raise err("Patroni rejected the change (%s): %s" % (st, json.dumps(d)[:300]))
    st2, cfg = ex.patroni.get_config()
    if st2 != 200 or (cfg.get("postgresql") or {}).get("pg_hba") != lst:
        raise err("verification failed: the DCS does not hold the new pg_hba list")
    text = "\n".join(lst) + "\n"
    if not _pg_up(ex):
        return False
    deadline = time.time() + wait
    while time.time() < deadline:                       # Patroni rewrites pg_hba.conf from the DCS and reloads on its next cycle (loop_wait)
        if loaded_matches(ex, text, err):
            return True
        time.sleep(2)
    return None


def _apply_patroni(ex, src, clean, new_text, cur_rev, err, old_text=None):
    lst = new_text.rstrip("\n").split("\n")
    previous = (src.dcs_list if not src.seed else None)
    loaded = _patch_dcs(ex, src, lst, err)
    res = {"changed": True, "mode": "patroni", "rev": hba.file_rev(new_text), "rules": len(clean), "dcs_seed": src.seed, "previous": previous, "previous_rev": cur_rev,
           "seed_list": (old_text.rstrip("\n").split("\n") if src.seed and old_text else None), "list": lst}
    if loaded is None:
        raise err("the DCS was updated but PostgreSQL on this node has not loaded the new rules within 45 s (%s); Patroni will still propagate them (check the Patroni log and `patronictl show-config`)" % loaded_matches.last)
    res["note"] = ("written to the DCS and loaded by PostgreSQL; every member follows" if loaded else "written to the DCS (PostgreSQL is not running on this node: verify on another member)") + \
        (" (the DCS had no pg_hba: the rules in force were copied into it first)" if src.seed else "")
    return res


def restore_dcs(ex, p, err):
    """Patroni only: put back a previous DCS pg_hba list (kept by the console from earlier changes). Same safety as apply: base revision, lock-out simulation."""
    src = _Src(ex, err)
    if not src.patroni:
        raise err("restoring a saved list is for Patroni clusters; on file-based nodes use the backup copies of pg_hba.conf")
    lst = p.get("list")
    if not isinstance(lst, list) or not lst or len(lst) > 600 or not all(isinstance(x, str) and len(x) < 600 for x in lst):
        raise err("list must be a non-empty list of pg_hba lines")
    for x in lst:
        s = x.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("include") or "@" in s.split("#")[0] or not hba.parse_rule_line(s):
            raise err("not a valid pg_hba line: %r" % x[:120])
    old = src.text()
    new = "\n".join(lst) + "\n"
    cur_rev = hba.file_rev(old)
    if p.get("base_rev") and p["base_rev"] != cur_rev:
        raise err("pg_hba changed since this restore was prepared (expected %s, found %s): reload the page" % (p["base_rev"], cur_rev))
    if old == new:
        return {"changed": False, "mode": "patroni", "rev": cur_rev}
    src.require_managed()
    rows, lock = _simulate(old, new, _live_probes(ex, err))
    crit = [r["label"] for r in lock if r["critical"]]
    if crit and not p.get("force"):
        raise err("refused: restoring this list would lock out: %s" % "; ".join(crit))
    loaded = _patch_dcs(ex, src, lst, err)
    if loaded is None:
        raise err("the DCS was updated but PostgreSQL on this node has not loaded the restored rules within 45 s (%s)" % loaded_matches.last)
    return {"changed": True, "mode": "patroni", "rev": hba.file_rev(new), "previous": src.dcs_list, "previous_rev": cur_rev, "list": lst, "restored": True}


def expire(ex, p, err):
    """Remove managed rules whose [until=...] has passed. File mode only (a Patroni DCS list has no per-rule comments)."""
    src = _Src(ex, err)
    managed = hba.extract_block(src.text()) or []
    keep, gone = hba.split_expired(managed, time.time())
    if not gone:
        return {"changed": False, "removed": 0}
    res = apply(ex, {"rules": keep}, err)
    res["removed"] = len(gone)
    res["removed_rules"] = [hba.render_rule(dict(r, comment="")).replace("  ", " ") for r in gone]
    return res


def rollback(ex, p, err):
    try:
        src = _Src(ex, err)
    except Exception as e:
        # PostgreSQL does not let the agent in any more (a pg_hba of the last change?): the remembered location is enough to put a backup back
        loc = _remembered(ex)
        if ex.patroni.configured or not loc.get("path"):
            raise
        return _rollback_offline(ex, p, err, loc["path"], e)
    if src.patroni:
        raise err("this cluster is managed by Patroni: previous lists are kept by the console (HBA tab, 'Versioni precedenti'), never as files on the node")
    # only the dated copies made before each change, newest first by date: '.pgarca-before-rollback' (the state before an earlier rollback)
    # sorts after every date and was restored by every later rollback (independent review)
    baks = _dated_backups(src.path)
    name = p.get("backup")
    pick = next((b for b in glob.glob(src.path + ".pgarca-*") if os.path.basename(b) == name), None) if name else (baks[-1] if baks else None)
    if not pick:
        raise err("no pg_hba backup available")
    cur = src.file_text()
    shutil.copy2(src.path, src.path + ".pgarca-before-rollback")
    with open(pick, "r", encoding="utf-8", errors="surrogateescape") as bf:
        _write_atomic(src.path, bf.read())
    bad = _reload_and_check(ex, src.path, err)
    if bad:
        _write_atomic(src.path, cur)
        _reload_and_check(ex, src.path, err)
        raise err("the backup has errors, nothing changed")
    return {"restored": os.path.basename(pick)}


def _dated_backups(path):
    import re as _re
    return sorted(b for b in glob.glob(path + ".pgarca-*") if _re.search(r"\.pgarca-\d{8}T\d{6}Z$", b))


def _rollback_offline(ex, p, err, path, why):
    baks = _dated_backups(path)
    name = p.get("backup")
    pick = next((b for b in glob.glob(path + ".pgarca-*") if os.path.basename(b) == name), None) if name else (baks[-1] if baks else None)
    if not pick:
        raise err("PostgreSQL refuses the agent (%s) and no pg_hba backup is available next to %s" % (getattr(why, "message", None) or why, path))
    shutil.copy2(path, path + ".pgarca-before-rollback")
    with open(pick, "r", encoding="utf-8", errors="surrogateescape") as bf:
        _write_atomic(path, bf.read())
    if not _signal_reload(ex):
        raise err("%s put back, but PostgreSQL could not be told to reload: run pg_ctl reload (or systemctl reload) on this server" % os.path.basename(pick))
    return {"restored": os.path.basename(pick), "offline": True, "note": "PostgreSQL did not let the agent in: the backup was put back from the remembered location and reloaded by signal"}
