import { pool } from '../db.js';

let cachedTaxTables = null;
let cachedInvoiceTaxCols = null;
let cachedBillTaxCols = null;

export async function taxTablesExist() {
  if (cachedTaxTables !== null) return cachedTaxTables;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('tax_rates', 'tax_groups', 'tax_group_rates')`
    );
    cachedTaxTables = r.rows[0].c === 3;
    return cachedTaxTables;
  } catch {
    cachedTaxTables = false;
    return false;
  }
}

async function hasCols(table, cols) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
       AND column_name = ANY($2::text[])`,
    [table, cols]
  );
  return r.rows[0].c === cols.length;
}

export async function invoicesHaveTaxColumns() {
  if (cachedInvoiceTaxCols !== null) return cachedInvoiceTaxCols;
  try {
    cachedInvoiceTaxCols = await hasCols('invoices', [
      'subtotal_amount',
      'tax_amount',
      'tax_inclusive',
      'tax_rate_id',
    ]);
    return cachedInvoiceTaxCols;
  } catch {
    cachedInvoiceTaxCols = false;
    return false;
  }
}

export async function billsHaveTaxColumns() {
  if (cachedBillTaxCols !== null) return cachedBillTaxCols;
  try {
    cachedBillTaxCols = await hasCols('bills', [
      'subtotal_amount',
      'tax_amount',
      'tax_inclusive',
      'tax_rate_id',
    ]);
    return cachedBillTaxCols;
  } catch {
    cachedBillTaxCols = false;
    return false;
  }
}

export function taxSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/014_tax_engine.sql';
}

export function calcTax({ amountInput, ratePercent, taxInclusive }) {
  const gross = Math.round(Number(amountInput) * 100) / 100;
  const rate = Number(ratePercent || 0) / 100;
  if (rate <= 0) return { subtotal: gross, tax: 0, total: gross };
  if (taxInclusive) {
    const subtotal = Math.round((gross / (1 + rate)) * 100) / 100;
    const tax = Math.round((gross - subtotal) * 100) / 100;
    return { subtotal, tax, total: gross };
  }
  const tax = Math.round(gross * rate * 100) / 100;
  const total = Math.round((gross + tax) * 100) / 100;
  return { subtotal: gross, tax, total };
}

