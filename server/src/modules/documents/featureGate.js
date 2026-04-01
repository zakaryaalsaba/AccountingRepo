import { isModuleEnabled } from '../../utils/featureFlags.js';

/**
 * Global kill-switch: DOCUMENTS_MODULE_ENABLED=0 disables all documents/signing behavior.
 */
export async function assertDocumentsModuleEnabledForCompany(companyId) {
  if (process.env.DOCUMENTS_MODULE_ENABLED === '0') return false;
  return isModuleEnabled(companyId, 'documents', true);
}
