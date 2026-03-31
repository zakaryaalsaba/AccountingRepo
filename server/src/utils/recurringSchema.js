import { pool } from '../db.js';

let cachedRecurringTables = null;

export async function recurringTablesExist() {
  if (cachedRecurringTables !== null) return cachedRecurringTables;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('recurring_templates', 'recurring_runs', 'journal_auto_reversals')`
    );
    cachedRecurringTables = r.rows[0].c === 3;
    return cachedRecurringTables;
  } catch {
    cachedRecurringTables = false;
    return false;
  }
}

export function recurringSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/018_recurring_accounting.sql';
}

