import { query } from '../db.js';

let cache = null;
let branchServiceCache = null;

export function resetVoucherSchemaCache() {
  cache = null;
  branchServiceCache = null;
}

export async function voucherTablesExist() {
  if (cache !== null) return cache;
  const r = await query(
    `SELECT COUNT(*)::int AS c
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (
         'vouchers',
         'receipt_invoice_allocations',
         'receipt_customer_balances',
         'payment_bill_allocations',
         'vendor_prepayments',
         'payment_bill_credit_allocations'
       )`
  );
  cache = r.rows[0]?.c === 6;
  return cache;
}

export function voucherSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/026_voucher_families.sql';
}

export async function vouchersHaveBranchServiceColumns() {
  if (branchServiceCache !== null) return branchServiceCache;
  const r = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'vouchers'
       AND column_name IN ('branch_id', 'service_card_id', 'project_id')`
  );
  branchServiceCache = r.rows[0]?.cnt === 3;
  return branchServiceCache;
}

export function voucherBranchServiceSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/030_project_accounting_profitability.sql';
}
