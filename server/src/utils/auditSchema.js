import { pool } from '../db.js';

let cachedAuditTables = null;
let cachedAuditComplianceTables = null;

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

export async function auditComplianceTablesExist() {
  if (cachedAuditComplianceTables !== null) return cachedAuditComplianceTables;
  try {
    const r = await pool.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'audit_monitor_jobs'
       LIMIT 1`
    );
    cachedAuditComplianceTables = r.rows.length > 0;
    return cachedAuditComplianceTables;
  } catch {
    cachedAuditComplianceTables = false;
    return false;
  }
}

export function auditComplianceSchemaHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/035_audit_compliance_enhancements.sql';
}

