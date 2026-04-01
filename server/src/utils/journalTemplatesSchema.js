import { query } from '../db.js';

let cache = null;

export function resetJournalTemplatesSchemaCache() {
  cache = null;
}

export async function journalEntryTemplatesTableExists() {
  if (cache !== null) return cache;
  const r = await query(
    `SELECT COUNT(*)::int AS c
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'journal_entry_templates'`
  );
  cache = r.rows[0]?.c === 1;
  return cache;
}

export function journalEntryTemplatesSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/025_journal_entry_templates.sql';
}
