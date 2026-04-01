/**
 * Live HTTP flow: upload (multipart) → PATCH recipients/placements → send → public GET/POST sign.
 * Email is not sent in MVP; links are logged server-side — this test only follows the returned URLs.
 *
 * Requires: API_BASE_URL, TEST_EMAIL, TEST_PASSWORD, TEST_COMPANY_ID
 * Optional: DOCUMENTS_MODULE_ENABLED must not be "0"; company documents feature enabled (default).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const API_BASE_URL = process.env.API_BASE_URL;
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const TEST_COMPANY_ID = process.env.TEST_COMPANY_ID;

function hasEnv() {
  return Boolean(API_BASE_URL && TEST_EMAIL && TEST_PASSWORD && TEST_COMPANY_ID);
}

/** Tiny valid PDF (single empty page). */
function minimalPdfBytes() {
  const s = `%PDF-1.1
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 3 3] >>
endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
trailer
<< /Size 4 /Root 1 0 R >>
startxref
178
%%EOF
`;
  return new TextEncoder().encode(s);
}

function tokenFromSigningLink(link) {
  const u = new URL(link);
  const parts = u.pathname.split('/').filter(Boolean);
  const signIdx = parts.indexOf('sign');
  if (signIdx === -1 || !parts[signIdx + 1]) {
    throw new Error(`Could not parse token from link: ${link}`);
  }
  return decodeURIComponent(parts[signIdx + 1]);
}

async function authHeaders() {
  const r = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  assert.equal(r.status, 200, 'login must succeed');
  const data = await r.json();
  return {
    Authorization: `Bearer ${data.token}`,
    'X-Company-Id': TEST_COMPANY_ID,
  };
}

test(
  'e-sign integration: upload → send → sign (no email)',
  { skip: !hasEnv() },
  async () => {
    const baseHeaders = await authHeaders();

    const form = new FormData();
    form.append('file', new Blob([minimalPdfBytes()], { type: 'application/pdf' }), 'esign-int.pdf');
    form.append('title', 'Integration test document');

    const upload = await fetch(`${API_BASE_URL}/api/documents/upload`, {
      method: 'POST',
      headers: baseHeaders,
      body: form,
    });
    if (upload.status === 403 || upload.status === 503) {
      assert.fail(
        `documents upload blocked (${upload.status}); enable documents module / feature flag for test company`
      );
    }
    assert.equal(upload.status, 201, `upload failed: ${upload.status} ${await upload.text()}`);
    const uploaded = await upload.json();
    const docId = uploaded.document?.id;
    assert.ok(docId, 'document id returned');

    const patch = await fetch(`${API_BASE_URL}/api/documents/${docId}`, {
      method: 'PATCH',
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients: [
          { name: 'Signer One', email: 'signer1-esign-int@example.com', signing_order: 1 },
        ],
        placements_json: [{ page: 1, x: 10, y: 20 }],
      }),
    });
    assert.equal(patch.status, 200, `patch failed: ${patch.status} ${await patch.text()}`);

    const send = await fetch(`${API_BASE_URL}/api/documents/${docId}/send`, {
      method: 'POST',
      headers: { ...baseHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(send.status, 200, `send failed: ${send.status} ${await send.text()}`);
    const sent = await send.json();
    const link = sent.signing_links?.[0]?.link;
    assert.ok(link, 'signing link returned');
    const token = tokenFromSigningLink(link);

    const getSign = await fetch(`${API_BASE_URL}/api/sign/${encodeURIComponent(token)}`);
    assert.equal(getSign.status, 200, `GET sign failed: ${getSign.status} ${await getSign.text()}`);
    const session = await getSign.json();
    assert.ok(session.document?.file_url);
    const fields = session.fields?.length ? session.fields : [{ page: 1, x: 10, y: 20 }];

    const postSign = await fetch(`${API_BASE_URL}/api/sign/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signatures: fields.map((f) => ({
          page: f.page,
          x: f.x,
          y: f.y,
          signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        })),
      }),
    });
    assert.equal(postSign.status, 200, `POST sign failed: ${postSign.status} ${await postSign.text()}`);
    const signed = await postSign.json();
    assert.equal(signed.ok, true);
    assert.equal(signed.document_status, 'SIGNED');
  }
);
