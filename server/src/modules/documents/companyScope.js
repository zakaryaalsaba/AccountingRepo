/**
 * Guard after loading a row from DB: every esign_* query must include
 * `WHERE company_id = $n` using {@link companyIdFromRequest} from permissions.js.
 */
export function assertRowCompanyScope(row, companyId, label = 'resource') {
  if (!row) return false;
  if (!companyId) return false;
  return String(row.company_id) === String(companyId);
}

export function assertRowCompanyScopeOrThrow(row, companyId, label = 'resource') {
  if (!assertRowCompanyScope(row, companyId)) {
    const err = new Error(`${label} not found or access denied`);
    err.status = 404;
    throw err;
  }
}
