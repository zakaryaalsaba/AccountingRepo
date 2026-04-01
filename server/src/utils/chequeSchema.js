import { query } from '../db.js';

let cache = null;

export function resetChequeSchemaCache() {
  cache = null;
}

export async function chequeTablesExist() {
  if (cache !== null) return cache;
  const r = await query(
    `SELECT COUNT(*)::int AS c
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('cheques', 'cheque_status_events')`
  );
  cache = r.rows[0]?.c === 2;
  return cache;
}

export function chequeSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/027_cheque_lifecycle.sql';
}
