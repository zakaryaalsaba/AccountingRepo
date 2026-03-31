import { pool } from '../db.js';

let cachedApTables = null;

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

