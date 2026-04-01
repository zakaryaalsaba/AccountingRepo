import { query } from '../../../db.js';
import { hashSignToken } from './signToken.js';
import { assertDocumentsModuleEnabledForCompany } from '../featureGate.js';

const MIN_TOKEN_LEN = 20;

/**
 * Public signing: resolve recipient + document from raw token in URL (no JWT).
 * Enforces hash lookup, TTL, PENDING recipient, SENT document, and documents feature flag.
 */
export async function resolveSigningContext(plainToken) {
  if (!plainToken || typeof plainToken !== 'string' || plainToken.length < MIN_TOKEN_LEN) {
    return { ok: false, code: 'invalid_token', status: 400 };
  }

  const tokenHash = hashSignToken(plainToken);

  const r = await query(
    `SELECT
       r.id AS recipient_id,
       r.company_id,
       r.document_id,
       r.name AS recipient_name,
       r.email AS recipient_email,
       r.signing_order,
       r.status AS recipient_status,
       r.sign_token_expires_at,
       d.title AS document_title,
       d.status AS document_status,
       d.file_url,
       d.placements_json
     FROM esign_recipients r
     INNER JOIN esign_documents d
       ON d.id = r.document_id AND d.company_id = r.company_id
     WHERE r.sign_token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );

  if (!r.rows.length) {
    return { ok: false, code: 'not_found', status: 404 };
  }

  const row = r.rows[0];

  const moduleOk = await assertDocumentsModuleEnabledForCompany(row.company_id);
  if (!moduleOk) {
    return { ok: false, code: 'module_disabled', status: 403 };
  }

  if (!row.sign_token_expires_at) {
    return { ok: false, code: 'not_issued', status: 400 };
  }

  if (new Date(row.sign_token_expires_at) < new Date()) {
    return { ok: false, code: 'expired', status: 410 };
  }

  if (row.recipient_status !== 'PENDING') {
    return { ok: false, code: 'already_signed', status: 409 };
  }

  if (row.document_status !== 'SENT') {
    return { ok: false, code: 'document_not_sent', status: 409 };
  }

  const recipient = {
    id: row.recipient_id,
    company_id: row.company_id,
    document_id: row.document_id,
    name: row.recipient_name,
    email: row.recipient_email,
    signing_order: row.signing_order,
    status: row.recipient_status,
    sign_token_expires_at: row.sign_token_expires_at,
  };

  const document = {
    id: row.document_id,
    company_id: row.company_id,
    title: row.document_title,
    status: row.document_status,
    file_url: row.file_url,
    placements_json: row.placements_json,
  };

  return { ok: true, recipient, document };
}
