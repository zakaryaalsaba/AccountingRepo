import test from 'node:test';
import assert from 'node:assert/strict';

const API_BASE_URL = process.env.API_BASE_URL;
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const TEST_COMPANY_ID = process.env.TEST_COMPANY_ID;
const TEST_COMPANY_ID_2 = process.env.TEST_COMPANY_ID_2;

function hasEnv() {
  return API_BASE_URL && TEST_EMAIL && TEST_PASSWORD && TEST_COMPANY_ID && TEST_COMPANY_ID_2;
}

async function authToken() {
  const r = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  assert.equal(r.status, 200, 'login must succeed');
  const data = await r.json();
  return data.token;
}

test('cross-company read/mutate isolation', { skip: !hasEnv() }, async () => {
  const token = await authToken();
  const h1 = {
    Authorization: `Bearer ${token}`,
    'X-Company-Id': TEST_COMPANY_ID,
    'Content-Type': 'application/json',
  };
  const h2 = {
    Authorization: `Bearer ${token}`,
    'X-Company-Id': TEST_COMPANY_ID_2,
    'Content-Type': 'application/json',
  };

  const create = await fetch(`${API_BASE_URL}/api/service-invoices`, {
    method: 'POST',
    headers: h1,
    body: JSON.stringify({
      customer_name: 'Isolation Test Customer',
      invoice_date: new Date().toISOString().slice(0, 10),
      quantity: 1,
      unit_price: 10,
    }),
  });
  assert.ok([201, 503].includes(create.status), `unexpected create status ${create.status}`);
  if (create.status !== 201) return;
  const created = await create.json();
  const id = created.service_invoice.id;

  const listOther = await fetch(`${API_BASE_URL}/api/service-invoices`, { headers: h2 });
  assert.equal(listOther.status, 200);
  const listData = await listOther.json();
  assert.equal(listData.service_invoices.some((x) => x.id === id), false, 'other company must not see invoice');

  const mutateOther = await fetch(`${API_BASE_URL}/api/service-invoices/${id}/returns`, {
    method: 'POST',
    headers: h2,
    body: JSON.stringify({
      return_date: new Date().toISOString().slice(0, 10),
      return_quantity: 1,
      reason: 'cross-company attempt',
    }),
  });
  assert.ok([404, 400].includes(mutateOther.status), `unexpected mutate status ${mutateOther.status}`);
});
