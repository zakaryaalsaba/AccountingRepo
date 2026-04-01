import { query } from '../db.js';

let cache = null;

export async function serviceInvoiceTablesExist() {
  if (cache !== null) return cache;
  const r = await query(
    `SELECT COUNT(*)::int AS c
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('service_invoices', 'service_invoice_returns')`
  );
  cache = r.rows[0]?.c === 2;
  return cache;
}

export function serviceInvoiceSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/032_service_invoice_returns.sql';
}
