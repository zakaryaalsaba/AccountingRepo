import { pool } from '../db.js';

let cachedIntegrationTables = null;

export async function integrationTablesExist() {
  if (cachedIntegrationTables !== null) return cachedIntegrationTables;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('integration_connections', 'payment_gateway_events', 'ecommerce_sales_syncs')`
    );
    cachedIntegrationTables = r.rows[0].c === 3;
    return cachedIntegrationTables;
  } catch {
    cachedIntegrationTables = false;
    return false;
  }
}

export function integrationSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/020_integrations.sql';
}

