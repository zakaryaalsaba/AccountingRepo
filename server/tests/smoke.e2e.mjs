import assert from 'node:assert/strict';

const API_BASE_URL = process.env.API_BASE_URL;
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const TEST_COMPANY_ID = process.env.TEST_COMPANY_ID;

if (!API_BASE_URL || !TEST_EMAIL || !TEST_PASSWORD || !TEST_COMPANY_ID) {
  console.log('Skipping smoke test: set API_BASE_URL, TEST_EMAIL, TEST_PASSWORD, TEST_COMPANY_ID');
  process.exit(0);
}

async function main() {
  const health = await fetch(`${API_BASE_URL}/health`);
  assert.equal(health.status, 200, 'health endpoint must be available');

  const login = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  assert.equal(login.status, 200, 'login should succeed');
  const auth = await login.json();
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    'X-Company-Id': TEST_COMPANY_ID,
    'Content-Type': 'application/json',
  };

  const checks = [
    '/api/accounts',
    '/api/transactions',
    '/api/invoices',
    '/api/expenses',
    '/api/reports/dashboard',
    '/api/reports/profit-loss?from=2026-01-01&to=2026-12-31',
    '/api/reports/balance-sheet?as_of=2026-12-31',
  ];
  for (const path of checks) {
    const r = await fetch(`${API_BASE_URL}${path}`, { headers });
    assert.ok(r.status < 500, `Smoke check failed for ${path}: ${r.status}`);
  }
  console.log('Smoke test passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

