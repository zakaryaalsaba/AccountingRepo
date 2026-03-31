import { pool } from '../db.js';

let cachedTables = null;

export async function fixedAssetsTablesExist() {
  if (cachedTables !== null) return cachedTables;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('fixed_assets', 'fixed_asset_depreciation_entries')`
    );
    cachedTables = r.rows[0].c === 2;
    return cachedTables;
  } catch {
    cachedTables = false;
    return false;
  }
}

export function fixedAssetsSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/012_fixed_assets.sql';
}

