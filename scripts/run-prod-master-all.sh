#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set."
  exit 1
fi

echo "==> Step 1/4: Run full production migrations bundle"
bash "$ROOT_DIR/scripts/run-prod-migrations.sh"

echo "==> Step 2/4: Run real-accounting focused bundle"
bash "$ROOT_DIR/scripts/run-real-accounting-final.sh"

echo "==> Step 3/4: Backfill voucher references (apply)"
NODE_TLS_REJECT_UNAUTHORIZED=0 APPLY=1 node "$ROOT_DIR/server/scripts/backfillVoucherReferences.mjs"

echo "==> Step 4/4: Optional module rollout flags"
if [[ -n "${API_BASE_URL:-}" && -n "${API_TOKEN:-}" && -n "${COMPANY_ID:-}" ]]; then
  bash "$ROOT_DIR/scripts/prod-module-rollout.sh"
else
  echo "Skipping module rollout flags (API_BASE_URL/API_TOKEN/COMPANY_ID not fully set)."
fi

echo "==> Final verification"
psql "$DATABASE_URL" -c "SELECT NOW() AS server_time;"
echo "All production scripts completed."
