"""WAL rescue: closes the hole a failover can leave in the WAL archive.

The problem. Only the PRIMARY runs archive_command (archive_mode=on). A standby receives every WAL record by streaming but never archives what it received, so
if the primary dies with segments it has not archived yet (archive backlog, broken archive_command, crash) and the standby is promoted, those segments exist ONLY in
the former standby's pg_wal, where the first checkpoint after the promotion recycles them. The archive then has a hole between the old and the new timeline and
point-in-time recovery through that stretch is impossible (until the next full backup). pgBackRest/Barman users solve it with archive_mode=always or pg_receivewal.

What this does, with no change to PostgreSQL settings and no extra write traffic in a healthy cluster:
  * on a STANDBY it keeps a small private staging copy of completed segments that are STILL missing from the archive after MIN_AGE seconds (a healthy primary has
    archived them long before, so normally nothing is staged); staged copies disappear as soon as the archive has the segment;
  * on a PRIMARY it publishes staged (and still present) segments of OLDER timelines that the archive lacks, through the normal write-once archive path (a segment
    that already exists is never touched: a divergent copy would be quarantined, not overwritten).
"""
import logging
import os
import re
import shutil
import threading
import time

from pg_arca.wal_manager import SEG_RE, WalArchiveError

logger = logging.getLogger("pg_arca.wal_rescue")
MIN_AGE = 90            # seconds a completed segment may stay un-archived before a standby keeps its own copy
MAX_STAGED = 48         # bound on the staging area (segments)

ROLE_SQL = ("SELECT pg_is_in_recovery()::int || ',' || COALESCE(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(), pg_current_wal_insert_lsn())::text || ',' || "
            "(SELECT timeline_id FROM pg_control_checkpoint())")
PRIMARY_SQL = ("SELECT '0,' || pg_current_wal_insert_lsn()::text || ',' || ('x' || substr(pg_walfile_name(pg_current_wal_insert_lsn()), 1, 8))::bit(32)::int")


def _lsn_int(txt):
    hi, lo = txt.split("/")
    return (int(hi, 16) << 32) | int(lo, 16)


def _parse(name, per_id):
    m = SEG_RE.match(name)
    if not m:
        return None
    tli, log, seg = (int(x, 16) for x in m.groups())
    return tli, log * per_id + seg


class WalRescue(object):
    def __init__(self, runtime, wal, config, min_age=MIN_AGE):
        self.rt, self.wal, self.config, self.min_age = runtime, wal, config, min_age
        self.stage = os.path.join(config.get("state_dir") or "/var/lib/pgarca/state", "wal_rescue")
        self.stop = threading.Event()
        self.last = {}

    # ------------------------------------------------------------------ one pass (pure with respect to PostgreSQL: the caller supplies the role)
    def pass_once(self, pg_wal, in_recovery, cur_tli, cur_segno, now=None):
        now = time.time() if now is None else now
        seg = self.wal.segment_size
        per_id = 0x100000000 // seg
        out = {"staged": 0, "published": 0, "pruned": 0}
        os.makedirs(self.stage, mode=0o750, exist_ok=True)
        # 1. forget what the archive already has
        for n in os.listdir(self.stage):
            if SEG_RE.match(n) and self.wal.has_segment(n):
                try:
                    os.unlink(os.path.join(self.stage, n))
                    out["pruned"] += 1
                except OSError:
                    pass
        try:
            names = sorted(n for n in os.listdir(pg_wal) if SEG_RE.match(n))
        except OSError:
            return out
        complete = []
        for n in names:
            p = _parse(n, per_id)
            if p and (p[0] < cur_tli or (p[0] == cur_tli and p[1] < cur_segno)):
                complete.append(n)
        if in_recovery:
            # 2a. standby: keep a copy of completed segments the archive still lacks after MIN_AGE
            for n in complete:
                tli, _ = _parse(n, per_id)
                src = os.path.join(pg_wal, n)
                dst = os.path.join(self.stage, n)
                if os.path.exists(dst) or self.wal.has_segment(n):
                    continue
                try:
                    st = os.stat(src)
                    if st.st_size != seg or now - st.st_mtime < self.min_age:
                        continue
                    tmp = dst + ".tmp"
                    shutil.copyfile(src, tmp)
                    os.rename(tmp, dst)
                    out["staged"] += 1
                except OSError as e:
                    logger.warning("cannot stage %s: %s", n, e)
            staged = sorted(x for x in os.listdir(self.stage) if SEG_RE.match(x))
            for n in staged[:-MAX_STAGED] if len(staged) > MAX_STAGED else []:
                try:
                    os.unlink(os.path.join(self.stage, n))
                except OSError:
                    pass
            return out
        # 2b. primary: publish what is missing and belongs to an OLDER timeline (the current timeline is the archiver's business)
        candidates = {}
        for n in sorted(x for x in os.listdir(self.stage) if SEG_RE.match(x)):
            candidates[n] = os.path.join(self.stage, n)
        for n in complete:
            p = _parse(n, per_id)
            if p and p[0] < cur_tli:
                candidates.setdefault(n, os.path.join(pg_wal, n))
        for n, src in sorted(candidates.items()):
            p = _parse(n, per_id)
            if not p or p[0] >= cur_tli or self.wal.has_segment(n):
                continue
            try:
                if os.path.getsize(src) != seg:
                    continue
                self.wal.archive_segment(src, n)
                out["published"] += 1
                logger.warning("WAL rescue: archived %s, which the failed primary never archived", n)
                if src.startswith(self.stage):
                    os.unlink(src)
            except (WalArchiveError, OSError) as e:
                logger.warning("WAL rescue cannot archive %s: %s", n, e)
        return out

    # ------------------------------------------------------------------ live
    def tick(self):
        inst = self.rt.instance or {}
        pgdata = inst.get("data_directory")
        if not pgdata or not self.wal or not os.path.isdir(os.path.join(pgdata, "pg_wal")):
            return None
        ok, out, _ = self.rt.db.run_psql(ROLE_SQL, read_only=True, timeout=10)
        if not ok or out.count(",") != 2:
            return None
        rec, lsn, tli = out.strip().split(",")
        in_recovery = rec == "1"
        if not in_recovery:                                     # exact insert timeline: pg_control lags right after a promotion
            ok, out, _ = self.rt.db.run_psql(PRIMARY_SQL, read_only=True, timeout=10)
            if not ok or out.count(",") != 2:
                return None
            _, lsn, tli = out.strip().split(",")
        self.last = self.pass_once(os.path.join(pgdata, "pg_wal"), in_recovery, int(tli), _lsn_int(lsn) // self.wal.segment_size)
        return self.last

    def start(self, interval=30):
        def loop():
            while not self.stop.wait(interval):
                try:
                    self.tick()
                except Exception as e:                          # never let a safety net take the agent down
                    logger.warning("WAL rescue pass failed: %s", e)
        threading.Thread(target=loop, daemon=True, name="wal-rescue").start()
