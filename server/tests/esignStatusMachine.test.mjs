import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDocumentStatusTransition,
  assertDocumentEditable,
  assertRecipientStatusTransition,
  DOCUMENT_STATUS,
  RECIPIENT_STATUS,
} from '../src/modules/documents/statusMachine.js';
import { isValidEsignAuditAction, ESIGN_AUDIT } from '../src/modules/documents/auditActions.js';

test('document transitions', () => {
  assert.equal(assertDocumentStatusTransition(DOCUMENT_STATUS.DRAFT, DOCUMENT_STATUS.SENT).ok, true);
  assert.equal(assertDocumentStatusTransition(DOCUMENT_STATUS.SENT, DOCUMENT_STATUS.SIGNED).ok, true);
  assert.equal(assertDocumentStatusTransition(DOCUMENT_STATUS.DRAFT, DOCUMENT_STATUS.SIGNED).ok, false);
  assert.equal(assertDocumentStatusTransition(DOCUMENT_STATUS.SIGNED, DOCUMENT_STATUS.SENT).ok, false);
});

test('recipient transitions', () => {
  assert.equal(
    assertRecipientStatusTransition(RECIPIENT_STATUS.PENDING, RECIPIENT_STATUS.SIGNED).ok,
    true
  );
  assert.equal(
    assertRecipientStatusTransition(RECIPIENT_STATUS.SIGNED, RECIPIENT_STATUS.PENDING).ok,
    false
  );
});

test('document editable only in DRAFT', () => {
  assert.equal(assertDocumentEditable(DOCUMENT_STATUS.DRAFT), true);
  assert.equal(assertDocumentEditable(DOCUMENT_STATUS.SENT), false);
});

test('ESIGN_AUDIT keys are valid actions', () => {
  for (const v of Object.values(ESIGN_AUDIT)) {
    assert.equal(isValidEsignAuditAction(v), true);
  }
  assert.equal(isValidEsignAuditAction('nope'), false);
});
