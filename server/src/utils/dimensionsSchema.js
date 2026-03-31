import { pool } from '../db.js';

let cachedDimensionsTables = null;

export async function dimensionsTablesExist() {
  if (cachedDimensionsTables !== null) return cachedDimensionsTables;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('dimensions', 'transaction_line_dimensions')`
    );
    cachedDimensionsTables = r.rows[0].c === 2;
    return cachedDimensionsTables;
  } catch {
    cachedDimensionsTables = false;
    return false;
  }
}

export function dimensionsSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/017_dimensions.sql';
}

