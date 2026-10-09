"""Cheap repository summary for heartbeats (no CAS walk on the hot path; CAS size is cached by the last backup/expire)."""

import os
import time

from pg_arca.engine.util import iso, read_json, write_json


class RepoSummary(object):
    def __init__(self, ctx):
        self.ctx = ctx

    def _cache_path(self):
        return self.ctx.repo.sp("summary.json")

    def refresh_cas(self):
        repo = self.ctx.repo
        n = total = 0
        for root, _, files in os.walk(repo.p("cas")):
            for f in files:
                if ".tmp." in f:
                    continue
                try:
                    total += os.path.getsize(os.path.join(root, f))
                    n += 1
                except OSError:
                    pass
        data = {"chunks": n, "stored_bytes": total, "at": iso()}
        try:
            write_json(self._cache_path(), data)
        except OSError:
            pass
        return data

    def get_stats(self):
        repo = self.ctx.repo
        if not os.path.isdir(repo.sp("backup")):
            return {"stanza": self.ctx.stanza, "configured": False, "sets": 0}
        sets = repo.sets()
        done = [s for s in sets if s.get("status") == "COMPLETE"]
        last = done[-1] if done else None
        try:
            cas = read_json(self._cache_path())
        except Exception:
            cas = None
        logical = sum((s.get("stats") or {}).get("bytes_logical", 0) for s in done)
        stored = (cas or {}).get("stored_bytes", 0)
        age = None
        if last and last.get("started_ts"):
            age = round((time.time() - last["started_ts"]) / 3600.0, 1)
        failed = [s for s in sets if s.get("status") in ("FAILED", "UNRECOVERABLE")]
        recent = []
        for s in sets[-60:]:
            st = s.get("stats") or {}
            recent.append({"id": s["id"], "type": s.get("type"), "parent": s.get("parent"), "status": s.get("status"), "start_time": s.get("start_time"),
                           "stop_time": s.get("stop_time"), "duration_sec": s.get("duration_sec"), "start_lsn": s.get("start_lsn"), "stop_lsn": s.get("stop_lsn"),
                           "timeline": s.get("timeline"), "bytes_logical": st.get("bytes_logical", 0), "bytes_written": st.get("bytes_written", 0),
                           "reason": s.get("reason"), "pg_version": s.get("pg_version")})
        return {"stanza": self.ctx.stanza, "configured": True, "sets": len(done), "failed_sets": len(failed),
                "last_backup": ({k: last.get(k) for k in ("id", "type", "start_time", "stop_time", "duration_sec", "stop_lsn")} if last else None),
                "last_backup_age_hours": age, "last_failure": ({k: failed[-1].get(k) for k in ("id", "status", "reason", "start_time")} if failed else None),
                "full_count": len([s for s in done if s["type"] == "full"]),
                "total_chunks": (cas or {}).get("chunks"), "stored_bytes": stored, "raw_bytes": logical,
                "dedup_ratio": round(logical / float(stored), 2) if stored else None, "repo_path": repo.path,
                "encryption": ({"alg": "aes-256-gcm", "key_id": repo.crypto.key_id} if repo.crypto else None), "recent_sets": recent}
