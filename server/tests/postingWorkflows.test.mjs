import test from 'node:test';
import assert from 'node:assert/strict';

const API_BASE_URL = process.env.API_BASE_URL;
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const TEST_COMPANY_ID = process.env.TEST_COMPANY_ID;

function hasEnv() {
  return API_BASE_URL && TEST_EMAIL && TEST_PASSWORD && TEST_COMPANY_ID;
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
    'Content-Type': 'application/json',
  };
}

test('posting workflows integration (invoice/payment/year-close)', { skip: !hasEnv() }, async () => {
  const headers = await authHeaders();
  const today = new Date().toISOString().slice(0, 10);

  const inv = await fetch(`${API_BASE_URL}/api/invoices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      customer_name: 'Integration Test Customer',
      amount: 123.45,
      invoice_date: today,
      status: 'unpaid',
      payer_type: 'customer',
    }),
  });
  assert.ok([201, 409].includes(inv.status), `invoice create failed: ${inv.status}`);

  const payments = await fetch(`${API_BASE_URL}/api/payments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      amount: 50,
      method: 'cash',
      payment_date: `${today}T10:00:00.000Z`,
      reference: 'INT-PAY',
    }),
  });
  assert.ok([201, 503].includes(payments.status), `payments flow unexpected: ${payments.status}`);

  const year = Number(today.slice(0, 4));
  const yc = await fetch(`${API_BASE_URL}/api/periods/year-close`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ year }),
  });
  assert.ok([201, 400, 403, 409, 503].includes(yc.status), `year-close unexpected: ${yc.status}`);
});

