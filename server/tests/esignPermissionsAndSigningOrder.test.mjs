import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canReadDocument,
  canManageDocument,
  companyIdFromRequest,
} from '../src/modules/documents/permissions.js';
import {
  assertRowCompanyScope,
  assertRowCompanyScopeOrThrow,
} from '../src/modules/documents/companyScope.js';
import { assertRecipientSigningTurn } from '../src/modules/documents/signingOrder.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('canReadDocument: owner, permissions, deny', () => {
  const doc = { owner_id: OWNER };
  assert.equal(
    canReadDocument({ user: { id: OWNER }, authorization: { permissions: {} } }, doc),
    true
  );
  assert.equal(
    canReadDocument({ user: { id: OTHER }, authorization: { permissions: {} } }, doc),
    false
  );
  assert.equal(
    canReadDocument(
      { user: { id: OTHER }, authorization: { permissions: { 'documents.read': true } } },
      doc
    ),
    true
  );
  assert.equal(
    canReadDocument(
      { user: { id: OTHER }, authorization: { permissions: { 'documents.manage': true } } },
      doc
    ),
    true
  );
  assert.equal(
    canReadDocument(
      { user: { id: OTHER }, authorization: { permissions: { '*': true } } },
      doc
    ),
    true
  );
});

test('canManageDocument: manage role or owner only', () => {
  const doc = { owner_id: OWNER };
  assert.equal(
    canManageDocument({ user: { id: OWNER }, authorization: { permissions: {} } }, doc),
    true
  );
  assert.equal(
    canManageDocument(
      { user: { id: OTHER }, authorization: { permissions: { 'documents.read': true } } },
      doc
    ),
    false
  );
  assert.equal(
    canManageDocument(
      { user: { id: OTHER }, authorization: { permissions: { 'documents.manage': true } } },
      doc
    ),
    true
  );
});

test('companyIdFromRequest', () => {
  assert.equal(companyIdFromRequest({ company: { id: CO_A } }), CO_A);
  assert.equal(companyIdFromRequest({ company: {} }), undefined);
});

test('assertRowCompanyScope', () => {
  assert.equal(assertRowCompanyScope({ company_id: CO_A }, CO_A), true);
  assert.equal(assertRowCompanyScope({ company_id: CO_A }, CO_B), false);
  assert.equal(assertRowCompanyScope(null, CO_A), false);
});

test('assertRowCompanyScopeOrThrow', () => {
  assertRowCompanyScopeOrThrow({ company_id: CO_A }, CO_A);
  assert.throws(
    () => assertRowCompanyScopeOrThrow({ company_id: CO_A }, CO_B),
    (e) => e.status === 404
  );
});

test('assertRecipientSigningTurn: first pending wins', async () => {
  const rows = [
    { id: 'r1', status: 'PENDING', signing_order: 1 },
    { id: 'r2', status: 'PENDING', signing_order: 2 },
  ];
  const ok = await assertRecipientSigningTurn(
    async () => ({ rows }),
    { documentId: 'd1', companyId: CO_A, recipientId: 'r1' }
  );
  assert.equal(ok.ok, true);

  const wrong = await assertRecipientSigningTurn(
    async () => ({ rows }),
    { documentId: 'd1', companyId: CO_A, recipientId: 'r2' }
  );
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'wrong_order');
  assert.equal(wrong.current_signing_order, 1);
});

test('assertRecipientSigningTurn: no pending', async () => {
  const r = await assertRecipientSigningTurn(
    async () => ({
      rows: [
        { id: 'r1', status: 'SIGNED', signing_order: 1 },
        { id: 'r2', status: 'SIGNED', signing_order: 2 },
      ],
    }),
    { documentId: 'd1', companyId: CO_A, recipientId: 'r1' }
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_pending');
});
