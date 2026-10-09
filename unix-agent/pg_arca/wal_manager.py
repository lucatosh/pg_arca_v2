"""
pg_arca WAL Manager & Continuous Archiving Module
==================================================
Handles atomic WAL segment ingestion, SHA-256 catalog indexing,
gap detection (continuity verification), and fast retrieval for restore_command.
"""

import os
import shutil
import hashlib
import json
import time
import subprocess
import logging

logger = logging.getLogger("pg_arca.wal_manager")


class WalManager:
    def __init__(self, wal_dir="/var/lib/postgresql/wal_archive", compression="zstd"):
        self.wal_dir = wal_dir
        self.compression = compression
        self.catalog_file = os.path.join(wal_dir, "wal_catalog.json")
        os.makedirs(wal_dir, exist_ok=True)
        self._init_catalog()

    def _init_catalog(self):
        if not os.path.exists(self.catalog_file):
            try:
                with open(self.catalog_file, "w", encoding="utf-8") as f:
                    json.dump({"segments": {}, "timelines": {}, "updated_at": time.time()}, f)
            except Exception as e:
                logger.warning(f"Could not initialize wal_catalog.json: {e}")

    def _load_catalog(self):
        if os.path.exists(self.catalog_file):
            try:
                with open(self.catalog_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return {"segments": {}, "timelines": {}, "updated_at": time.time()}

    def _save_catalog(self, catalog):
        catalog["updated_at"] = time.time()
        temp_file = f"{self.catalog_file}.tmp.{os.getpid()}"
        try:
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(catalog, f, indent=2)
            os.rename(temp_file, self.catalog_file)
        except Exception as e:
            logger.error(f"Failed to persist wal catalog: {e}")

    def archive_segment(self, src_path, segment_name):
        """
        Invoked by PostgreSQL archive_command:
          archive_command = 'pg-arca-cli wal-archive %p %f'
        Returns (success, dest_path, sha256, message)
        """
        if not os.path.exists(src_path):
            return False, "", "", f"Source WAL segment {src_path} does not exist"

        dest_file = os.path.join(self.wal_dir, segment_name)
        temp_file = os.path.join(self.wal_dir, f".{segment_name}.tmp.{os.getpid()}")

        # Check if already present and identical
        if os.path.exists(dest_file):
            src_sha = self._calc_sha256(src_path)
            dest_sha = self._calc_sha256(dest_file)
            if src_sha == dest_sha:
                return True, dest_file, dest_sha, "Segment already archived with identical checksum"

        # Compress or copy to temporary file
        if self.compression == "zstd" and shutil.which("zstd"):
            temp_final = f"{temp_file}.zst"
            dest_final = f"{dest_file}.zst"
            subprocess.run(["zstd", "-q", "-f", "-3", src_path, "-o", temp_final], check=True)
        elif self.compression == "lz4" and shutil.which("lz4"):
            temp_final = f"{temp_file}.lz4"
            dest_final = f"{dest_file}.lz4"
            subprocess.run(["lz4", "-q", "-f", src_path, temp_final], check=True)
        else:
            temp_final = temp_file
            dest_final = dest_file
            shutil.copy2(src_path, temp_final)

        checksum = self._calc_sha256(temp_final)

        # Atomic Rename (prevents partial writes)
        os.rename(temp_final, dest_final)

        # Update Catalog
        cat = self._load_catalog()
        timeline_id = int(segment_name[:8], 16) if len(segment_name) == 24 else 1
        cat["segments"][segment_name] = {
            "dest_path": dest_final,
            "sha256": checksum,
            "timeline": timeline_id,
            "archived_at": time.time(),
            "size_bytes": os.path.getsize(dest_final)
        }
        self._save_catalog(cat)

        return True, dest_final, checksum, "Archived successfully"

    def retrieve_segment(self, segment_name, dest_path):
        """
        Invoked by PostgreSQL restore_command:
          restore_command = 'pg-arca-cli wal-get %f %p'
        Returns (success, message)
        """
        # Look for plain, .zst, or .lz4
        plain_file = os.path.join(self.wal_dir, segment_name)
        zst_file = f"{plain_file}.zst"
        lz4_file = f"{plain_file}.lz4"

        temp_dest = f"{dest_path}.tmp.{os.getpid()}"
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)

        try:
            if os.path.exists(plain_file):
                shutil.copy2(plain_file, temp_dest)
            elif os.path.exists(zst_file):
                subprocess.run(["zstd", "-d", "-q", "-f", zst_file, "-o", temp_dest], check=True)
            elif os.path.exists(lz4_file):
                subprocess.run(["lz4", "-d", "-q", "-f", lz4_file, temp_dest], check=True)
            else:
                return False, f"WAL segment {segment_name} not found in archive {self.wal_dir}"

            os.rename(temp_dest, dest_path)
            return True, f"Retrieved {segment_name} into {dest_path}"
        except Exception as e:
            if os.path.exists(temp_dest):
                os.remove(temp_dest)
            return False, f"Failed retrieving {segment_name}: {str(e)}"

    def verify_continuity(self):
        """
        Scans all archived WAL files and checks for gaps in segment numbering.
        Returns { continuous: bool, total_segments: int, gaps: list, timelines: list }
        """
        cat = self._load_catalog()
        segments = [s for s in os.listdir(self.wal_dir) if len(s.split(".")[0]) == 24]
        segments.sort()

        if not segments:
            return {
                "continuous": True,
                "total_segments": 0,
                "gaps": [],
                "timelines": [],
                "status": "No WAL segments archived yet"
            }

        gaps = []
        timelines = set()
        prev_seg_num = None
        prev_timeline = None

        for s in segments:
            base_name = s.split(".")[0]
            try:
                tl = int(base_name[:8], 16)
                log = int(base_name[8:16], 16)
                seg = int(base_name[16:24], 16)
                seg_num = (log << 32) | seg
                timelines.add(tl)

                if prev_timeline == tl and prev_seg_num is not None:
                    if seg_num > prev_seg_num + 1:
                        gaps.append({
                            "timeline": tl,
                            "missing_from": f"{tl:08X}{prev_seg_num + 1:016X}",
                            "missing_to": f"{tl:08X}{seg_num - 1:016X}"
                        })
                prev_seg_num = seg_num
                prev_timeline = tl
            except ValueError:
                continue

        return {
            "continuous": len(gaps) == 0,
            "total_segments": len(segments),
            "gaps": gaps,
            "timelines": sorted(list(timelines)),
            "first_segment": segments[0],
            "last_segment": segments[-1],
            "status": "100% CONTINUOUS • Zero Gaps" if len(gaps) == 0 else f"WARNING: {len(gaps)} WAL gap(s) detected!"
        }

    def _calc_sha256(self, filepath):
        sha = hashlib.sha256()
        with open(filepath, "rb") as f:
            while chunk := f.read(65536):
                sha.update(chunk)
        return sha.hexdigest()
