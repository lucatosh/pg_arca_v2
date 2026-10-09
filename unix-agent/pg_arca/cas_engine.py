"""
pg_arca Content-Addressed Storage (CAS) Engine
===============================================
Enterprise block deduplication engine for PostgreSQL physical files.
Features:
 - 64 KiB chunking (8 x 8192 bytes PostgreSQL relation pages)
 - SHA-256 content addressing
 - Multi-tier compression (zstd / lz4 / zlib fallback)
 - Sparse Single-Database backup isolation (backs up only target DB + globals)
 - Backup Manifest cataloging & verification
"""

import os
import hashlib
import json
import zlib
import time
import shutil
import logging

logger = logging.getLogger("pg_arca.cas_engine")

CHUNK_SIZE = 64 * 1024  # 64 KiB

try:
    import zstandard as zstd
    HAS_ZSTD = True
except ImportError:
    HAS_ZSTD = False


class CasStore:
    def __init__(self, repo_path="/var/lib/pgarca/repo"):
        self.repo_path = repo_path
        self.chunks_dir = os.path.join(repo_path, "chunks")
        self.manifests_dir = os.path.join(repo_path, "manifests")
        os.makedirs(self.chunks_dir, exist_ok=True)
        os.makedirs(self.manifests_dir, exist_ok=True)

    def _get_chunk_path(self, chunk_hash):
        prefix_a = chunk_hash[:2]
        prefix_b = chunk_hash[2:4]
        target_dir = os.path.join(self.chunks_dir, prefix_a, prefix_b)
        os.makedirs(target_dir, exist_ok=True)
        return os.path.join(target_dir, f"{chunk_hash}.chunk")

    def compress_data(self, data):
        """Compresses block data using zlib/zstd."""
        if HAS_ZSTD:
            cctx = zstd.ZstdCompressor(level=3)
            return cctx.compress(data), "zstd"
        return zlib.compress(data, level=6), "zlib"

    def decompress_data(self, compressed_data, algo="zlib"):
        """Decompresses block data."""
        if algo == "zstd" and HAS_ZSTD:
            dctx = zstd.ZstdDecompressor()
            return dctx.decompress(compressed_data)
        return zlib.decompress(compressed_data)

    def store_block(self, block_data):
        """
        Stores a block in CAS. If already present, skips write (deduplication).
        Returns (chunk_hash, raw_size, stored_size, is_deduped).
        """
        raw_size = len(block_data)
        chunk_hash = hashlib.sha256(block_data).hexdigest()
        chunk_file = self._get_chunk_path(chunk_hash)

        if os.path.exists(chunk_file):
            # Already exists in repo -> 100% Deduplicated!
            stored_size = os.path.getsize(chunk_file)
            return chunk_hash, raw_size, stored_size, True

        # New unique block: compress and store atomically
        compressed_bytes, algo = self.compress_data(block_data)
        temp_file = f"{chunk_file}.tmp.{os.getpid()}"
        with open(temp_file, "wb") as f:
            # 4-byte header: algo identifier ('ZLIB' or 'ZSTD')
            header = algo.upper().ljust(4)[:4].encode("ascii")
            f.write(header)
            f.write(compressed_bytes)

        os.rename(temp_file, chunk_file)
        stored_size = os.path.getsize(chunk_file)
        return chunk_hash, raw_size, stored_size, False

    def read_block(self, chunk_hash):
        """Reads and decompresses a block from CAS given its SHA-256 hash."""
        chunk_file = self._get_chunk_path(chunk_hash)
        if not os.path.exists(chunk_file):
            raise FileNotFoundError(f"CAS chunk missing: {chunk_hash}")

        with open(chunk_file, "rb") as f:
            header = f.read(4).decode("ascii", errors="ignore").strip().lower()
            compressed = f.read()

        return self.decompress_data(compressed, algo="zstd" if "zstd" in header else "zlib")

    def backup_file(self, file_path):
        """Chunks a file into CAS and returns chunk metadata list."""
        chunks = []
        raw_bytes = 0
        stored_bytes = 0
        dedup_hits = 0

        with open(file_path, "rb") as f:
            offset = 0
            while True:
                buf = f.read(CHUNK_SIZE)
                if not buf:
                    break
                ch_hash, r_sz, s_sz, is_dedup = self.store_block(buf)
                chunks.append({
                    "offset": offset,
                    "length": r_sz,
                    "hash": ch_hash
                })
                offset += r_sz
                raw_bytes += r_sz
                stored_bytes += s_sz
                if is_dedup:
                    dedup_hits += 1

        return {
            "path": file_path,
            "raw_bytes": raw_bytes,
            "stored_bytes": stored_bytes,
            "chunks_count": len(chunks),
            "dedup_chunks": dedup_hits,
            "chunks": chunks
        }

    def restore_file(self, chunks_metadata, destination_path):
        """Reconstructs a file from CAS chunks to destination."""
        os.makedirs(os.path.dirname(destination_path), exist_ok=True)
        temp_dest = f"{destination_path}.tmp.{os.getpid()}"

        with open(temp_dest, "wb") as out_f:
            for item in chunks_metadata:
                block = self.read_block(item["hash"])
                out_f.write(block)

        os.rename(temp_dest, destination_path)
        return os.path.getsize(destination_path)

    def save_manifest(self, manifest):
        """Persists a backup manifest atomically."""
        backup_id = manifest["id"]
        manifest_path = os.path.join(self.manifests_dir, f"{backup_id}.json")
        temp_path = f"{manifest_path}.tmp.{os.getpid()}"

        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)

        os.rename(temp_path, manifest_path)
        return manifest_path

    def list_manifests(self):
        """Returns list of all saved backup manifests sorted newest first."""
        manifests = []
        for fname in os.listdir(self.manifests_dir):
            if fname.endswith(".json") and not fname.startswith("."):
                fpath = os.path.join(self.manifests_dir, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        manifests.append(data)
                except Exception as e:
                    logger.warning(f"Could not read manifest {fname}: {e}")

        manifests.sort(key=lambda m: m.get("start_time", ""), reverse=True)
        return manifests

    def get_stats(self):
        """Computes CAS repository statistics."""
        total_chunks = 0
        stored_bytes = 0
        for root, _, files in os.walk(self.chunks_dir):
            for f in files:
                if f.endswith(".chunk"):
                    total_chunks += 1
                    try:
                        stored_bytes += os.path.getsize(os.path.join(root, f))
                    except OSError:
                        pass

        manifests = self.list_manifests()
        total_raw_bytes = sum(m.get("raw_bytes", 0) for m in manifests)
        dedup_ratio = round(total_raw_bytes / stored_bytes, 2) if stored_bytes > 0 else 1.0

        return {
            "total_chunks": total_chunks,
            "stored_bytes": stored_bytes,
            "raw_bytes": total_raw_bytes,
            "dedup_ratio": dedup_ratio,
            "manifests_count": len(manifests),
            "repo_path": self.repo_path
        }
