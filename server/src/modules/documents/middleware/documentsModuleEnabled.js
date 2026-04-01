import { assertDocumentsModuleEnabledForCompany } from '../featureGate.js';

export { assertDocumentsModuleEnabledForCompany };

/**
 * After authRequired + companyContext. Blocks API when module is off globally or for company.
 */
export async function documentsModuleEnabled(req, res, next) {
  if (process.env.DOCUMENTS_MODULE_ENABLED === '0') {
    return res.status(403).json({ error: 'Documents module disabled' });
  }
  const ok = await assertDocumentsModuleEnabledForCompany(req.company.id);
  if (!ok) {
    return res.status(403).json({ error: 'Documents module not enabled for this company' });
  }
  next();
}
