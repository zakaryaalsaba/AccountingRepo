export const PERMISSION_DOCUMENTS_READ = 'documents.read';
export const PERMISSION_DOCUMENTS_MANAGE = 'documents.manage';

function perms(req) {
  return req.authorization?.permissions || {};
}

/**
 * List / read document detail / preview metadata.
 * Any member with read or manage; document owner always sees their doc.
 */
export function canReadDocument(req, document) {
  const p = perms(req);
  if (p['*'] || p[PERMISSION_DOCUMENTS_READ] || p[PERMISSION_DOCUMENTS_MANAGE]) return true;
  if (document && req.user?.id && String(document.owner_id) === String(req.user.id)) return true;
  return false;
}

/**
 * Upload, edit draft, send. Company roles with manage; or document owner for that document.
 */
export function canManageDocument(req, document) {
  const p = perms(req);
  if (p['*'] || p[PERMISSION_DOCUMENTS_MANAGE]) return true;
  if (document && req.user?.id && String(document.owner_id) === String(req.user.id)) return true;
  return false;
}

/**
 * Authenticated routes must always scope SQL with this company id (from JWT + X-Company-Id).
 */
export function companyIdFromRequest(req) {
  return req.company?.id;
}
