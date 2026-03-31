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

export async function postExpenseEntry(client, {
  companyId,
  expenseId,
  amount,
  entryDate,
  expenseAccountId,
  paymentMethod,
  description,
}) {
  const amt = round2(amount);
  if (amt <= 0) return null;
  const cashId = await accountIdByCode(client, companyId, INVOICE_GL_CODES.CASH);
  const apId = await accountIdByCode(client, companyId, AP_CODE);
  const offsetId = paymentMethod === 'payable' ? apId : cashId;
  if (!offsetId) {
    const needed = paymentMethod === 'payable' ? AP_CODE : INVOICE_GL_CODES.CASH;
    const err = new Error(`Missing or inactive account code ${needed}`);
    err.status = 400;
    throw err;
  }

  const ref = `EXP-${String(expenseId).replace(/-/g, '').slice(0, 10)}`;
  const desc = `Expense — ${String(description || '').slice(0, 200)}`;
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
    [tid, offsetId, amt]
  );
  return tid;
}

