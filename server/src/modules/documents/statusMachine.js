export const DOCUMENT_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SENT: 'SENT',
  SIGNED: 'SIGNED',
});

export const RECIPIENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SIGNED: 'SIGNED',
});

/** Valid document status strings (for query filters, etc.). */
export const DOCUMENT_STATUS_SET = new Set(Object.values(DOCUMENT_STATUS));

const DOCUMENT_TRANSITIONS = {
  [DOCUMENT_STATUS.DRAFT]: [DOCUMENT_STATUS.SENT],
  [DOCUMENT_STATUS.SENT]: [DOCUMENT_STATUS.SIGNED],
  [DOCUMENT_STATUS.SIGNED]: [],
};

/**
 * @param {string} from
 * @param {string} to
 * @returns {{ ok: true } | { ok: false, code: string, from: string, to: string }}
 */
export function assertDocumentStatusTransition(from, to) {
  const allowed = DOCUMENT_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return { ok: false, code: 'invalid_document_transition', from, to };
  }
  return { ok: true };
}

export function assertDocumentEditable(status) {
  return status === DOCUMENT_STATUS.DRAFT;
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {{ ok: true } | { ok: false, code: string, from: string, to: string }}
 */
export function assertRecipientStatusTransition(from, to) {
  if (from === RECIPIENT_STATUS.PENDING && to === RECIPIENT_STATUS.SIGNED) {
    return { ok: true };
  }
  return { ok: false, code: 'invalid_recipient_transition', from, to };
}

export function isDocumentTerminal(status) {
  return status === DOCUMENT_STATUS.SIGNED;
}
