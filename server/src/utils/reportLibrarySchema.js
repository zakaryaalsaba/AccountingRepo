import { query } from '../db.js';

let cache = null;

export async function reportSavedViewsTableExists() {
  if (cache !== null) return cache;
  const r = await query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'report_saved_views'
     LIMIT 1`
  );
  cache = r.rows.length > 0;
  return cache;
}

export function reportLibrarySchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/033_reporting_library.sql';
}
