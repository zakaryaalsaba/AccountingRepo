import { INVOICE_GL_CODES } from './invoicePosting.js';

const AP_CODE = '2000';

async function accountIdByCode(client, companyId, code) {
  const r = await client.query(
    `SELECT id FROM accounts WHERE company_id = $1 AND code = $2 AND is_active = TRUE`,
    [companyId, code]
  );
  return r.rows[0]?.id || null;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export async function postBillRecognition(client, {
  companyId,
  billId,
  amount,
  entryDate,
  expenseAccountId,
  vendorName,
}) {
  const amt = round2(amount);
  if (amt <= 0) return null;
  const apId = await accountIdByCode(client, companyId, AP_CODE);
  if (!apId) {
    const err = new Error(`Missing or inactive AP account code ${AP_CODE}`);
    err.status = 400;
    throw err;
  }

  const ref = `BILL-${String(billId).replace(/-/g, '').slice(0, 10)}`;
  const desc = `Vendor bill — ${String(vendorName || '').slice(0, 200)}`;
  const txIns = await client.query(
    `INSERT INTO transactions (company_id, entry_date, description, reference)
     VALUES ($1, $2::date, $3, $4) RETURNING id`,
    [companyId, entryDate, desc, ref]
  );
  const tid = txIns.rows[0].id;
  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, $3, 0)`,
    [tid, expenseAccountId, amt]
  );
  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`,
    [tid, apId, amt]
  );
  return tid;
}

export async function postBillPayment(client, {
  companyId,
  billId,
  amount,
  entryDate,
  vendorName,
}) {
  const amt = round2(amount);
  if (amt <= 0) return null;
  const apId = await accountIdByCode(client, companyId, AP_CODE);
  const cashId = await accountIdByCode(client, companyId, INVOICE_GL_CODES.CASH);
  if (!apId || !cashId) {
    const err = new Error(`Missing active account code ${!apId ? AP_CODE : INVOICE_GL_CODES.CASH}`);
    err.status = 400;
    throw err;
  }
  const ref = `BILL-PAY-${String(billId).replace(/-/g, '').slice(0, 10)}`;
  const desc = `Vendor payment — ${String(vendorName || '').slice(0, 200)}`;
  const txIns = await client.query(
    `INSERT INTO transactions (company_id, entry_date, description, reference)
     VALUES ($1, $2::date, $3, $4) RETURNING id`,
    [companyId, entryDate, desc, ref]
  );
  const tid = txIns.rows[0].id;
  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, $3, 0)`,
    [tid, apId, amt]
  );
  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`,
    [tid, cashId, amt]
  );
  return tid;
}

