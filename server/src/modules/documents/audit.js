import { assertEsignAuditAction } from './auditActions.js';

/**
 * @param {(text: string, params?: unknown[]) => Promise<unknown>} executor - pool.query or client.query
 */
export async function insertEsignAudit(executor, { companyId, documentId, action, actor, metadata = {} }) {
  assertEsignAuditAction(action);
  await executor(
    `INSERT INTO esign_audit_logs (company_id, document_id, action, actor, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [companyId, documentId, action, actor, JSON.stringify(metadata ?? {})]
  );
}
