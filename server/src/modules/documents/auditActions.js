/**
 * Canonical `esign_audit_logs.action` values for the documents module.
 */
export const ESIGN_AUDIT = Object.freeze({
  created: 'created',
  uploaded: 'uploaded',
  recipients_updated: 'recipients_updated',
  /** Draft metadata / placements changed (title or placements_json). */
  updated: 'updated',
  sent: 'sent',
  viewed: 'viewed',
  signed: 'signed',
  completed: 'completed',
  failed: 'failed',
});

const ALLOWED = new Set(Object.values(ESIGN_AUDIT));

export function isValidEsignAuditAction(action) {
  return typeof action === 'string' && ALLOWED.has(action);
}

export function assertEsignAuditAction(action) {
  if (!isValidEsignAuditAction(action)) {
    throw new Error(`Invalid esign audit action: ${String(action)}`);
  }
}
