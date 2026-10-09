#!/usr/bin/env bash
# ==============================================================================
# pg_arca — High-Resilience Physical WAL Archiver Script
# ==============================================================================
# Usage in postgresql.conf or patroni.yml:
# archive_command = '/usr/local/bin/pg-arca-wal-archive.sh %p %f'
#
# Arguments:
#   $1: %p = Full path to WAL segment to archive (e.g. pg_wal/000000010000000000000001)
#   $2: %f = WAL filename only (e.g. 000000010000000000000001)
# ==============================================================================

set -euo pipefail

WAL_PATH="${1:-}"
WAL_FILE="${2:-}"

ARCHIVE_DIR="${PG_ARCA_WAL_DEST:-/var/lib/postgresql/wal_archive}"
LOG_FILE="${PG_ARCA_LOG:-/var/log/postgresql/pg-arca-wal.log}"
COMPRESSION="${PG_ARCA_COMPRESSION:-lz4}" # lz4, zstd, or none

if [[ -z "$WAL_PATH" || -z "$WAL_FILE" ]]; then
    echo "ERROR: Missing arguments. Usage: $0 %p %f" >&2
    exit 1
fi

mkdir -p "$ARCHIVE_DIR"
mkdir -p "$(dirname "$LOG_FILE")"

TEMP_FILE="${ARCHIVE_DIR}/.${WAL_FILE}.tmp.$$"
DEST_FILE="${ARCHIVE_DIR}/${WAL_FILE}"

# If compression is requested
if [[ "$COMPRESSION" == "lz4" ]] && command -v lz4 &>/dev/null; then
    DEST_FINAL="${DEST_FILE}.lz4"
    TEMP_FINAL="${TEMP_FILE}.lz4"
    lz4 -q -f "$WAL_PATH" "$TEMP_FINAL"
elif [[ "$COMPRESSION" == "zstd" ]] && command -v zstd &>/dev/null; then
    DEST_FINAL="${DEST_FILE}.zst"
    TEMP_FINAL="${TEMP_FILE}.zst"
    zstd -q -f -3 "$WAL_PATH" -o "$TEMP_FINAL"
else
    DEST_FINAL="${DEST_FILE}"
    TEMP_FINAL="${TEMP_FILE}"
    cp -f "$WAL_PATH" "$TEMP_FINAL"
fi

# Calculate SHA-256 for audit & deduplication catalog
CHECKSUM=$(sha256sum "$TEMP_FINAL" | awk '{print $1}')

# Atomic Rename into place (prevents partial writes)
mv -f "$TEMP_FINAL" "$DEST_FINAL"

# Log event
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"time\":\"$TIMESTAMP\",\"wal\":\"$WAL_FILE\",\"dest\":\"$DEST_FINAL\",\"sha256\":\"$CHECKSUM\",\"status\":\"SUCCESS\"}" >> "$LOG_FILE"

exit 0
