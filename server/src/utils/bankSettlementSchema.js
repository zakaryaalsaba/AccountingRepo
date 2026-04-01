import { query } from '../db.js';

let cache = null;

export function resetBankSettlementSchemaCache() {
  cache = null;
}

export async function bankSettlementTablesExist() {
  if (cache !== null) return cache;
  const r = await query(
    `SELECT COUNT(*)::int AS c
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('bank_settlement_batches', 'bank_settlement_batch_lines', 'reconciliation_locks')`
  );
  cache = r.rows[0]?.c === 3;
  return cache;
}

export function bankSettlementSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/028_bank_settlement_expansion.sql';
}
