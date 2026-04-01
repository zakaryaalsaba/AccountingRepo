/**
 * Map documents API errors to vue-i18n keys or return raw server message.
 * @param {unknown} err - axios error
 * @param {(key: string) => string} t - useI18n().t
 */
export function documentsApiErrorMessage(err, t) {
  if (!err?.response) {
    return t('documents.errorNetwork');
  }
  const status = err.response.status;
  const msg = String(err.response.data?.error || '').trim();

  if (status === 401) return t('documents.errorUnauthorized');
  if (status === 404) return t('documents.errorNotFound');
  if (status === 403) {
    if (/documents module/i.test(msg)) return t('documents.errorModuleDisabled');
    if (/forbidden|access denied|permission/i.test(msg)) return t('documents.errorForbidden');
    return msg || t('documents.errorForbidden');
  }
  if (status === 400 && /company|X-Company-Id/i.test(msg)) return t('documents.errorCompanyMismatch');
  if (status === 409) return msg || t('documents.errorConflict');
  if (status === 410) return msg || t('documents.publicError.expired');

  if (msg) return msg;
  return t('documents.errorGeneric');
}

/** fetch-based public signing errors (custom Error with .status, .code). */
export function publicSignErrorMessage(err, t) {
  const code = err?.code;
  if (code) {
    const k = `documents.publicError.${code}`;
    const translated = t(k);
    if (translated !== k) return translated;
  }
  const status = err?.status;
  if (status === 410) return t('documents.publicError.expired');
  if (status === 409) return t('documents.publicError.conflict');
  if (status === 403) return t('documents.publicError.module_disabled');
  if (status === 404) return t('documents.publicError.not_found');
  if (status === 400) return t('documents.publicError.invalid_token');
  return t('documents.publicError.generic');
}
