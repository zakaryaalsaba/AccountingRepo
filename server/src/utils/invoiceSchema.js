import { pool } from '../db.js';

let cachedGlColumns = null;
let cachedPayerColumns = null;
let cachedNumberingColumns = null;
let cachedCreditNotesTable = null;

/** Whether `invoices.sale_transaction_id` exists (invoice GL migration applied). */
export async function invoicesHaveGlColumns() {
  if (cachedGlColumns !== null) return cachedGlColumns;
  try {
    const r = await pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'invoices'
         AND column_name = 'sale_transaction_id'
       LIMIT 1`
    );
    cachedGlColumns = r.rows.length > 0;
    return cachedGlColumns;
  } catch {
    cachedGlColumns = false;
    return false;
  }
}

/** Whether migration 002 invoice columns are fully present (all four). */
export async function invoicesHavePayerColumns() {
  if (cachedPayerColumns !== null) return cachedPayerColumns;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'invoices'
         AND column_name IN ('total_amount', 'paid_amount', 'payer_type', 'payer_id')`
    );
    cachedPayerColumns = r.rows[0].c === 4;
    return cachedPayerColumns;
  } catch {
    cachedPayerColumns = false;
    return false;
  }
}

export async function paymentsTableExists() {
  const payer = await invoicesHavePayerColumns();
  if (!payer) return false;
  try {
    const r = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'payments'
       LIMIT 1`
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

export async function invoiceCreditNotesTableExists() {
  if (cachedCreditNotesTable !== null) return cachedCreditNotesTable;
  try {
    const r = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'invoice_credit_notes'
       LIMIT 1`
    );
    cachedCreditNotesTable = r.rows.length > 0;
    return cachedCreditNotesTable;
  } catch {
    cachedCreditNotesTable = false;
    return false;
  }
}

/** Whether invoice numbering/template columns are present. */
export async function invoicesHaveNumberingColumns() {
  if (cachedNumberingColumns !== null) return cachedNumberingColumns;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'invoices'
         AND column_name IN ('invoice_number', 'invoice_template_id')`
    );
    cachedNumberingColumns = r.rows[0].c === 2;
    return cachedNumberingColumns;
  } catch {
    cachedNumberingColumns = false;
    return false;
  }
}

export function resetInvoiceSchemaCache() {
  cachedGlColumns = null;
  cachedPayerColumns = null;
  cachedNumberingColumns = null;
  cachedCreditNotesTable = null;
}
