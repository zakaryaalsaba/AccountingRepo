import { pool } from '../db.js';

let cachedBudgetTables = null;

export async function budgetTablesExist() {
  if (cachedBudgetTables !== null) return cachedBudgetTables;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('budgets', 'budget_lines')`
    );
    cachedBudgetTables = r.rows[0].c === 2;
    return cachedBudgetTables;
  } catch {
    cachedBudgetTables = false;
    return false;
  }
}

export function budgetSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/016_budgets_variance.sql';
}

