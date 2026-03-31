#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/zakaryaalsaba/Desktop/AccountingRepo"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set."
  echo "Example:"
  echo "  export DATABASE_URL='postgresql://user:pass@host:5432/dbname'"
  exit 1
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_FILE:-$ROOT_DIR/backup_before_migrations_${STAMP}.sql}"

echo "==> Creating pre-migration backup: $BACKUP_FILE"
pg_dump "$DATABASE_URL" > "$BACKUP_FILE"

echo "==> Applying migrations to production database"
for f in "$ROOT_DIR"/database/migrations/*.sql; do
  echo "Applying: $f"
  psql "$DATABASE_URL" -f "$f"
done

echo "==> Quick verification"
psql "$DATABASE_URL" -c "SELECT NOW() AS server_time;"

echo "Done. Backup saved to: $BACKUP_FILE"
