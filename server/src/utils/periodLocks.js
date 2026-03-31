import { pool } from '../db.js';

let cachedTableExists = null;

export async function periodLocksTableExists() {
  if (cachedTableExists !== null) return cachedTableExists;
  try {
    const r = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'accounting_period_locks'
       LIMIT 1`
    );
    cachedTableExists = r.rows.length > 0;
    return cachedTableExists;
  } catch {
    cachedTableExists = false;
    return false;
  }
}

export function resetPeriodLocksCache() {
  cachedTableExists = null;
}

/**
 * Enforces period lock only when the feature table exists.
 * No-op when migration not installed yet.
 */
export async function assertDateOpen(companyId, dateValue, dbClient = null) {
  if (!dateValue) return;
  const exists = await periodLocksTableExists();
  if (!exists) return;

  const q = dbClient ?? pool;
  const r = await q.query(
    `SELECT period_start, period_end
     FROM accounting_period_locks
     WHERE company_id = $1
       AND is_closed = TRUE
       AND $2::date BETWEEN period_start AND period_end
     LIMIT 1`,
    [companyId, dateValue]
  );
  if (r.rows.length) {
    const row = r.rows[0];
    const err = new Error(
      `Period is closed for date ${dateValue} (locked range ${row.period_start} to ${row.period_end}).`
    );
    err.status = 400;
    throw err;
  }
}
