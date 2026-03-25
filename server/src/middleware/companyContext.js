import { getAccessibleCompany } from '../utils/companyAccess.js';

const HEADER = 'x-company-id';

/**
 * Requires authRequired first. Validates X-Company-Id and attaches req.company.
 */
export async function companyContext(req, res, next) {
  const raw = req.headers[HEADER];
  const companyId = Array.isArray(raw) ? raw[0] : raw;
  if (!companyId) {
    return res.status(400).json({ error: 'Missing X-Company-Id header' });
  }
  const company = await getAccessibleCompany(companyId, req.user.id);
  if (!company) {
    return res.status(403).json({ error: 'Company not found or access denied' });
  }
  req.company = company;
  next();
}
