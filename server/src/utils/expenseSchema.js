import { pool } from '../db.js';

let cachedAdvanced = null;

export async function expensesHaveAdvancedColumns() {
  if (cachedAdvanced !== null) return cachedAdvanced;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'expenses'
         AND column_name IN (
           'vendor_name',
           'payment_method',
           'receipt_reference',
           'receipt_attachment_url',
           'ocr_raw_text',
           'posting_transaction_id',
           'updated_at'
         )`
    );
    cachedAdvanced = r.rows[0].c === 7;
    return cachedAdvanced;
  } catch {
    cachedAdvanced = false;
    return false;
  }
}

export function expenseSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/011_expense_gl_automation.sql';
}

