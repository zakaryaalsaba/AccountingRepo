import { query } from '../db.js';

let cache = null;

export function resetProjectSchemaCache() {
  cache = null;
}

export async function projectTablesExist() {
  if (cache !== null) return cache;
  const r = await query(
    `SELECT COUNT(*)::int AS c
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('projects', 'project_wip_entries')`
  );
  cache = r.rows[0]?.c === 2;
  return cache;
}

export function projectSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/030_project_accounting_profitability.sql';
}
