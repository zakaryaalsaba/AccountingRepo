import { query } from '../db.js';

let cache = null;
let seqDimsCache = null;

export function resetFiscalSchemaCache() {
  cache = null;
  seqDimsCache = null;
}

export async function fiscalPhaseOneTablesExist() {
  if (cache !== null) return cache;
  const r = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('fiscal_years', 'document_sequences')`
  );
  cache = r.rows[0]?.cnt === 2;
  return cache;
}

export function fiscalPhaseOneSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/023_fiscal_years_sequences_and_voucher_status.sql';
}

export function sequenceDimensionsSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/024_sequence_dimensions.sql';
}

export async function sequenceDimensionColumnsExist() {
  if (seqDimsCache !== null) return seqDimsCache;
  const r = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'document_sequences'
       AND column_name IN ('branch_dimension_id', 'department_dimension_id')`
  );
  seqDimsCache = r.rows[0]?.cnt === 2;
  return seqDimsCache;
}

export async function getFiscalYearForDate(companyId, dateValue, client = null) {
  const db = client || { query };
  const r = await db.query(
    `SELECT id, year_code, is_closed
     FROM fiscal_years
     WHERE company_id = $1
       AND start_date <= $2::date
       AND end_date >= $2::date
     ORDER BY year_code DESC
     LIMIT 1`,
    [companyId, dateValue]
  );
  return r.rows[0] || null;
}

export async function assertFiscalYearOpen(companyId, dateValue, client = null) {
  if (!(await fiscalPhaseOneTablesExist())) return;
  const fy = await getFiscalYearForDate(companyId, dateValue, client);
  if (fy && fy.is_closed) {
    const err = new Error(`Date ${dateValue} is inside closed fiscal year ${fy.year_code}`);
    err.status = 400;
    throw err;
  }
}
