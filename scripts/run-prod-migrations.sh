#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set."
  echo "Example:"
  echo "  export DATABASE_URL='postgresql://user:pass@host:5432/dbname'"
  exit 1
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_FILE:-$ROOT_DIR/backup_before_migrations_${STAMP}.sql}"
backup_created=0

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is required but not installed."
  exit 1
fi

server_version_num="$(psql "$DATABASE_URL" -At -c "SHOW server_version_num;")"
server_major="${server_version_num:0:2}"
if [[ ! "$server_major" =~ ^[0-9]+$ ]]; then
  echo "ERROR: Could not determine server major version from: $server_version_num"
  exit 1
fi

echo "==> Creating pre-migration backup: $BACKUP_FILE"
if [[ "${SKIP_BACKUP:-0}" == "1" ]]; then
  echo "Skipping backup because SKIP_BACKUP=1"
else
  if command -v pg_dump >/dev/null 2>&1; then
    local_pg_dump_major="$(pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
  else
    local_pg_dump_major=""
  fi

  if [[ -n "${local_pg_dump_major}" && "${local_pg_dump_major}" == "${server_major}" ]]; then
    pg_dump "$DATABASE_URL" > "$BACKUP_FILE"
    backup_created=1
  else
    if ! command -v docker >/dev/null 2>&1; then
      echo "ERROR: Local pg_dump major (${local_pg_dump_major:-missing}) does not match server major (${server_major}), and docker is not installed."
      echo "Install matching pg_dump ${server_major}.x or install Docker and retry."
      exit 1
    fi
    echo "Local pg_dump major (${local_pg_dump_major:-missing}) mismatches server major (${server_major})."
    echo "Using Docker postgres:${server_major}-alpine pg_dump for compatible backup..."
    docker run --rm postgres:"${server_major}"-alpine pg_dump "$DATABASE_URL" > "$BACKUP_FILE"
    backup_created=1
  fi
fi

echo "==> Applying migrations to production database (sorted by filename)"
for f in $(find "$ROOT_DIR/database/migrations" -maxdepth 1 -name '*.sql' | LC_ALL=C sort); do
  echo "Applying: $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "==> Quick verification"
psql "$DATABASE_URL" -c "SELECT NOW() AS server_time;"

if [[ "$backup_created" == "1" ]]; then
  echo "Done. Backup saved to: $BACKUP_FILE"
else
  echo "Done. No backup file created in this run."
fi
