#!/usr/bin/env bash
# Apply ALL database changes for the Document Signing module (taskDocSign.md).
# Run when you are ready to apply DocSign DDL (e.g. end of rollout).
#
# Usage:
#   export DATABASE_URL='postgresql://...'
#   bash scripts/run-document-signing-all.sh
#
# Idempotent: safe to re-run (uses IF NOT EXISTS in SQL).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set."
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is required."
  exit 1
fi

echo "==> Document signing / e-sign schema (taskDocSign.md)"
echo "    Applying: database/migrations/038_document_signing.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/database/migrations/038_document_signing.sql"

echo "    Applying: database/migrations/039_esign_integration_hooks.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/database/migrations/039_esign_integration_hooks.sql"

# Future DocSign-only migrations: add below in numeric order.

echo "==> Done (document signing DDL + integration hooks)."
