import { query } from '../db.js';

let workflowColsCache = null;
let branchServiceColsCache = null;

export function resetTransactionSchemaCache() {
  workflowColsCache = null;
  branchServiceColsCache = null;
}

export async function transactionsHaveWorkflowColumns() {
  if (workflowColsCache !== null) return workflowColsCache;
  const r = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'transactions'
       AND column_name IN ('status', 'posted_by', 'posted_at', 'reversed_transaction_id')`
  );
  workflowColsCache = r.rows[0]?.cnt === 4;
  return workflowColsCache;
}

export function transactionWorkflowSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/023_fiscal_years_sequences_and_voucher_status.sql';
}

export async function transactionsHaveBranchServiceColumns() {
  if (branchServiceColsCache !== null) return branchServiceColsCache;
  const r = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'transactions'
       AND column_name IN ('branch_id', 'service_card_id', 'project_id')`
  );
  branchServiceColsCache = r.rows[0]?.cnt === 3;
  return branchServiceColsCache;
}

export function transactionBranchServiceSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/030_project_accounting_profitability.sql';
}
