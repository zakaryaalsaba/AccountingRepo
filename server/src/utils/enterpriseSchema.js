import { pool } from '../db.js';

let cachedEnterpriseTables = null;

export async function enterpriseTablesExist() {
  if (cachedEnterpriseTables !== null) return cachedEnterpriseTables;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'background_jobs',
           'webhook_subscriptions',
           'webhook_deliveries',
           'backup_records',
           'restore_requests'
         )`
    );
    cachedEnterpriseTables = r.rows[0].c === 5;
    return cachedEnterpriseTables;
  } catch {
    cachedEnterpriseTables = false;
    return false;
  }
}

export function enterpriseSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/021_enterprise_readiness.sql';
}

