"""
pg_hba.conf management: strict validation, a console-managed block, offline simulation of "who can connect" before and after a change.

Design rules
  * The console owns ONLY a delimited block; everything else in the file (and in Patroni's DCS list) is left alone.
  * The block sits at the top (pg_hba is first-match), so it can both grant and restrict — which is why every change is simulated first
    against the connections that matter (replication clients, the local postgres user, anything the operator lists).
  * Pure functions, no I/O: the executor does the reading, the atomic write, the reload and the verification.
"""
import hashlib
import ipaddress
import re

BEGIN = "# >>> pg_arca managed block (edited by the console; changes made by hand inside this block are overwritten) >>>"
END = "# <<< pg_arca managed block <<<"
REV_PREFIX = "# rev: "
TYPES = ("local", "host", "hostssl", "hostnossl", "hostgssenc", "hostnogssenc")
METHODS = ("peer", "scram-sha-256", "md5", "password", "trust", "reject", "cert", "ident", "ldap", "gss", "pam", "radius", "sspi", "bsd")
_TOKEN = re.compile(r'^(?:[A-Za-z0-9_$.+\-]{1,63}|"[^"\x00-\x1f#]{1,63}")$')
_HOST = re.compile(r"^\.?[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*$")
_OPTS = re.compile(r'^[A-Za-z0-9_.=,:/ \-"\'@]{0,300}$')


class HbaError(ValueError):
    pass


def _tokens(s):
    return [t for t in str(s).split(",")]


def validate_rule(r):
    """Returns (clean_rule, warnings). Raises HbaError with an operator-readable message."""
    if not isinstance(r, dict):
        raise HbaError("rule must be an object")
    t = str(r.get("type", "")).strip()
    if t not in TYPES:
        raise HbaError("type must be one of: %s" % ", ".join(TYPES))
    db = str(r.get("database", "")).strip()
    us = str(r.get("user", "")).strip()
    method = str(r.get("method", "")).strip()
    addr = str(r.get("address", "") or "").strip()
    opts = str(r.get("options", "") or "").strip()
    comment = str(r.get("comment", "") or "").strip()
    warns = []
    for label, val in (("database", db), ("user", us)):
        if not val:
            raise HbaError("%s is required (use 'all' for any)" % label)
        for tok in _tokens(val):
            if tok.startswith("@"):
                raise HbaError("%s: file inclusion (@) is not allowed" % label)
            if not _TOKEN.match(tok) and not (tok.startswith("+") and _TOKEN.match(tok[1:])):
                raise HbaError("%s: invalid name %r (letters, digits, _ $ . - ; roles as +name; quote names with spaces)" % (label, tok))
    if method not in METHODS:
        raise HbaError("method must be one of: %s" % ", ".join(METHODS))
    if t == "local":
        if addr:
            raise HbaError("'local' rules have no address")
    else:
        if not addr:
            raise HbaError("address is required (CIDR such as 10.0.0.0/24, a host name, 'samehost' or 'samenet')")
        if addr not in ("all", "samehost", "samenet"):
            if "/" in addr or re.match(r"^[0-9a-fA-F:.]+$", addr):
                try:
                    ipaddress.ip_network(addr, strict=False)
                except ValueError:
                    raise HbaError("address %r is not a valid CIDR (e.g. 10.0.0.0/24 or 2001:db8::/32)" % addr)
                if addr in ("0.0.0.0/0", "::/0") and method not in ("reject",):
                    warns.append("opens the database to the whole internet range (%s)" % addr)
            elif not _HOST.match(addr):
                raise HbaError("address %r is neither a CIDR nor a valid host name" % addr)
    if method == "trust":
        warns.append("'trust' lets anyone matching connect WITHOUT a password")
        if t != "local" and addr not in ("127.0.0.1/32", "::1/128"):
            raise HbaError("'trust' over the network is refused; use scram-sha-256 (or restrict trust to 127.0.0.1/32)")
    elif method == "password":
        warns.append("'password' sends the password in clear text; use scram-sha-256")
    elif method == "md5":
        warns.append("md5 is deprecated; scram-sha-256 is preferred")
    if t in ("host", "hostnossl") and method not in ("reject", "peer") and addr not in ("127.0.0.1/32", "::1/128"):
        warns.append("%s allows unencrypted connections; prefer hostssl" % t)
    if opts and not _OPTS.match(opts):
        raise HbaError("options contain unsupported characters")
    if "\n" in comment or "\r" in comment or any(ord(c) < 32 for c in comment) or len(comment) > 160:
        raise HbaError("comment must be a single line of at most 160 characters")
    return {"type": t, "database": db, "user": us, "address": addr, "method": method, "options": opts, "comment": comment}, warns


def validate_rules(rules):
    if not isinstance(rules, list) or len(rules) > 200:
        raise HbaError("rules must be a list of at most 200 entries")
    clean, errors, warnings, seen = [], [], [], {}
    for i, r in enumerate(rules):
        try:
            c, w = validate_rule(r)
            k = tuple(c[x] for x in ("type", "database", "user", "address", "method", "options"))
            if k in seen:
                raise HbaError("duplicate of rule #%d" % (seen[k] + 1))
            seen[k] = i
            clean.append(c)
            warnings += [{"index": i, "message": x} for x in w]
        except HbaError as e:
            errors.append({"index": i, "message": str(e)})
    return clean, errors, warnings


def render_rule(r):
    cols = [r["type"], r["database"], r["user"]] + ([r["address"]] if r["type"] != "local" else []) + [r["method"]] + ([r["options"]] if r.get("options") else [])
    line = "  ".join(cols)
    return ("# %s\n%s" % (r["comment"], line)) if r.get("comment") else line


def rules_rev(rules):
    h = hashlib.sha256("\n".join(render_rule(r) for r in rules).encode("utf-8")).hexdigest()
    return h[:12]


def render_block(rules):
    return "\n".join([BEGIN, REV_PREFIX + rules_rev(rules)] + [render_rule(r) for r in rules] + [END]) + "\n"


def file_rev(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _split(line):
    out, cur, q = [], "", False
    for ch in line:
        if ch == '"':
            q = not q
            cur += ch
        elif ch in " \t" and not q:
            if cur:
                out.append(cur)
                cur = ""
        elif ch == "#" and not q:
            break
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def parse_rule_line(line):
    t = _split(line)
    if len(t) < 3 or t[0] not in TYPES:
        return None
    if t[0] == "local":
        if len(t) < 4:
            return None
        return {"type": "local", "database": t[1], "user": t[2], "address": "", "method": t[3], "options": " ".join(t[4:]), "comment": ""}
    if len(t) < 5:
        return None
    addr, rest = t[3], t[4:]
    if re.match(r"^[0-9.]+$", addr) and rest and re.match(r"^[0-9.]+$", rest[0]) and rest[0].count(".") == 3:   # "addr netmask" form
        try:
            addr = str(ipaddress.ip_network("%s/%s" % (addr, rest[0]), strict=False))
            rest = rest[1:]
        except ValueError:
            return None
    if not rest:
        return None
    return {"type": t[0], "database": t[1], "user": t[2], "address": addr, "method": rest[0], "options": " ".join(rest[1:]), "comment": ""}


def parse_file(text):
    """All rule lines in file order: [{line, rule, in_block}]. 'include' directives are reported, not followed."""
    rules, includes, inblock = [], False, False
    for n, raw in enumerate(text.split("\n"), 1):
        s = raw.strip()
        if s == BEGIN:
            inblock = True
            continue
        if s == END:
            inblock = False
            continue
        if not s or s.startswith("#"):
            continue
        if s.startswith("include"):
            includes = True
            continue
        r = parse_rule_line(s)
        if r:
            rules.append({"line": n, "rule": r, "in_block": inblock})
    return rules, includes


def extract_block(text):
    """Rules currently inside the managed block (comments restored), or None when there is no block."""
    lines = text.split("\n")
    try:
        a = next(i for i, l in enumerate(lines) if l.strip() == BEGIN)
        b = next(i for i, l in enumerate(lines) if i > a and l.strip() == END)
    except StopIteration:
        return None
    out, pending = [], ""
    for l in lines[a + 1:b]:
        s = l.strip()
        if s.startswith(REV_PREFIX.strip()):
            continue
        if s.startswith("#"):
            pending = s[1:].strip()
            continue
        r = parse_rule_line(s)
        if r:
            r["comment"] = pending
            pending = ""
            out.append(r)
    return out


def apply_block(text, rules):
    """Return the file text with the managed block replaced / inserted at the top of the rules / removed (empty list)."""
    lines = text.split("\n")
    try:
        a = next(i for i, l in enumerate(lines) if l.strip() == BEGIN)
        b = next(i for i, l in enumerate(lines) if i > a and l.strip() == END)
        head, tail = lines[:a], lines[b + 1:]
        had = True
    except StopIteration:
        head, tail, had = None, None, False
    block = render_block(rules).rstrip("\n").split("\n") if rules else []
    if had:
        return "\n".join(head + block + tail)
    if not rules:
        return text
    idx = len(lines)
    for i, l in enumerate(lines):
        s = l.strip()
        if s and not s.startswith("#"):
            idx = i
            break
    return "\n".join(lines[:idx] + block + [""] + lines[idx:])


# --------------------------------------------------------------------------- simulation
def _in_net(ip, addr):
    if addr == "all":
        return True
    if addr in ("samehost", "samenet"):
        return None
    try:
        net = ipaddress.ip_network(addr, strict=False)
        return ipaddress.ip_address(ip) in net
    except ValueError:
        return None          # host name: cannot be resolved offline


def _list_match(tokens, value, extra=None):
    """True / False / None(unknown)."""
    unknown = False
    for t in tokens.split(","):
        t = t.strip().strip('"')
        if t == "all":
            return True if extra != "replication" else None
        if t == value:
            return True
        if t.startswith("+"):
            if extra and t[1:] in extra:
                return True
            unknown = True
    return None if unknown else False


def decide(rules, probe):
    """
    probe: {type: 'local'|'host', ssl: bool, database, user, address, replication: bool, roles: [..]}
    rules: list of rule dicts in file order. Returns {allowed: True|False|None, method, rule_index, uncertain}.
    """
    uncertain = False
    for i, r in enumerate(rules):
        rt = r["type"]
        if probe["type"] == "local":
            if rt != "local":
                continue
        else:
            if rt == "local":
                continue
            if rt == "hostssl" and not probe.get("ssl"):
                continue
            if rt == "hostnossl" and probe.get("ssl"):
                continue
            ok = _in_net(probe["address"], r["address"])
            if ok is False:
                continue
            if ok is None:
                uncertain = True
                continue
        # database
        if probe.get("replication"):
            dbm = True if any(t.strip() == "replication" for t in r["database"].split(",")) else False
        else:
            dbm = False
            for t in r["database"].split(","):
                t = t.strip().strip('"')
                if t == "all" or t == probe["database"] or (t == "sameuser" and probe["database"] == probe["user"]):
                    dbm = True
                if t == "samerole":
                    uncertain = True
        if not dbm:
            continue
        um = _list_match(r["user"], probe["user"], probe.get("roles") or [])
        if um is False:
            continue
        if um is None:
            uncertain = True
            continue
        m = r["method"]
        return {"allowed": m != "reject", "method": m, "rule_index": i, "uncertain": uncertain}
    return {"allowed": False, "method": None, "rule_index": None, "uncertain": uncertain}   # no rule: PostgreSQL refuses
