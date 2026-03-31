import { pool } from '../db.js';

let cachedCurrencyTables = null;

export async function currencyTablesExist() {
  if (cachedCurrencyTables !== null) return cachedCurrencyTables;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('company_currencies', 'exchange_rates')`
    );
    cachedCurrencyTables = r.rows[0].c === 2;
    return cachedCurrencyTables;
  } catch {
    cachedCurrencyTables = false;
    return false;
  }
}

export function currencySchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/015_multi_currency.sql';
}

