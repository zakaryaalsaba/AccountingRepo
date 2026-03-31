import { pool } from '../db.js';

let cachedApTables = null;
let cachedBillCreditsTable = null;

export async function apTablesExist() {
  if (cachedApTables !== null) return cachedApTables;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('vendors', 'bills', 'bill_payments')`
    );
    cachedApTables = r.rows[0].c === 3;
    return cachedApTables;
  } catch {
    cachedApTables = false;
    return false;
  }
}

export function apSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/009_ap_vendors_bills.sql';
}

export async function billCreditsTableExists() {
  if (cachedBillCreditsTable !== null) return cachedBillCreditsTable;
  try {
    const r = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'bill_credits'
       LIMIT 1`
    );
    cachedBillCreditsTable = r.rows.length > 0;
    return cachedBillCreditsTable;
  } catch {
    cachedBillCreditsTable = false;
    return false;
  }
}

export function billCreditsSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/010_bill_credits.sql';
}

