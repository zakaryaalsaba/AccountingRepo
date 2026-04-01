import { query } from '../db.js';

let tableCache = null;

export async function featureFlagsTableExists() {
  if (tableCache !== null) return tableCache;
  const r = await query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'company_feature_flags'
     LIMIT 1`
  );
  tableCache = r.rows.length > 0;
  return tableCache;
}

export function featureFlagsSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/036_feature_flags.sql';
}

export async function isModuleEnabled(companyId, moduleKey, defaultEnabled = true) {
  if (!(await featureFlagsTableExists())) return defaultEnabled;
  const r = await query(
    `SELECT is_enabled
     FROM company_feature_flags
     WHERE company_id = $1 AND module_key = $2
     LIMIT 1`,
    [companyId, String(moduleKey)]
  );
  if (!r.rows.length) return defaultEnabled;
  return Boolean(r.rows[0].is_enabled);
}
