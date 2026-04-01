#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/zakaryaalsaba/Desktop/AccountingRepo"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set."
  echo "Example:"
  echo "  export DATABASE_URL='postgresql://user:pass@host:5432/dbname'"
  exit 1
fi

MIGRATIONS=(
  "$ROOT_DIR/database/migrations/023_fiscal_years_sequences_and_voucher_status.sql"
  "$ROOT_DIR/database/migrations/024_sequence_dimensions.sql"
  "$ROOT_DIR/database/migrations/025_journal_entry_templates.sql"
  "$ROOT_DIR/database/migrations/026_voucher_families.sql"
  "$ROOT_DIR/database/migrations/027_cheque_lifecycle.sql"
  "$ROOT_DIR/database/migrations/028_bank_settlement_expansion.sql"
  "$ROOT_DIR/database/migrations/029_branch_service_card_structure.sql"
  "$ROOT_DIR/database/migrations/030_project_accounting_profitability.sql"
  "$ROOT_DIR/database/migrations/031_statement_confirmations.sql"
  "$ROOT_DIR/database/migrations/032_service_invoice_returns.sql"
  "$ROOT_DIR/database/migrations/033_reporting_library.sql"
  "$ROOT_DIR/database/migrations/034_workflow_controls.sql"
  "$ROOT_DIR/database/migrations/035_audit_compliance_enhancements.sql"
  "$ROOT_DIR/database/migrations/036_feature_flags.sql"
)

echo "==> Running Real Accounting bundle migrations"
for f in "${MIGRATIONS[@]}"; do
  echo "Applying: $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "==> Verification"
psql "$DATABASE_URL" -c "SELECT NOW() AS server_time;"
echo "Done."
