import { query } from '../db.js';

let cache = null;

export async function statementConfirmationsTableExists() {
  if (cache !== null) return cache;
  const r = await query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'statement_confirmations'
     LIMIT 1`
  );
  cache = r.rows.length > 0;
  return cache;
}

export function statementSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/031_statement_confirmations.sql';
}
