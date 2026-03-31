import { pool } from '../db.js';

let cachedAuditTables = null;

export async function auditTablesExist() {
  if (cachedAuditTables !== null) return cachedAuditTables;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('document_attachments', 'audit_events', 'journal_approvals')`
    );
    cachedAuditTables = r.rows[0].c === 3;
    return cachedAuditTables;
  } catch {
    cachedAuditTables = false;
    return false;
  }
}

export function auditSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/019_document_auditability.sql';
}

