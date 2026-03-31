/**
 * Auto GL for invoices (default CoA codes from seed: 1000 Cash, 1100 AR, 4000 Revenue).
 * Sale: Dr AR / Cr Revenue. Payment: Dr Cash / Cr AR.
 */

export const INVOICE_GL_CODES = {
  CASH: '1000',
  AR: '1100',
  INPUT_TAX: '1200',
  OUTPUT_TAX: '2100',
  REVENUE: '4000',
};

async function accountIdByCode(client, companyId, code) {
  const r = await client.query(
    `SELECT id FROM accounts WHERE company_id = $1 AND code = $2 AND is_active = TRUE`,
    [companyId, code]
  );
  return r.rows[0]?.id || null;
}

/** @param {import('pg').PoolClient} client */
async function requireAccountIds(client, companyId, codes) {
  const out = {};
  const missing = [];
  for (const code of codes) {
    const id = await accountIdByCode(client, companyId, code);
    if (id) out[code] = id;
    else missing.push(code);
  }
  if (missing.length) {
    const err = new Error(
      `Missing or inactive accounts for codes: ${missing.join(', ')}. ` +
        `Ensure ${INVOICE_GL_CODES.CASH} (Cash), ${INVOICE_GL_CODES.AR} (A/R), ` +
        `${INVOICE_GL_CODES.REVENUE} (Revenue) exist (default company seed).`
    );
    err.status = 400;
    throw err;
  }
  return out;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Dr Accounts Receivable / Cr Revenue (recognize sale).
 * @param {import('pg').PoolClient} client
 */
export async function postInvoiceSale(client, {
  companyId,
  invoiceId,
  amount,
  entryDate,
  customerName,
  taxAmount = 0,
}) {
  const amt = round2(amount);
  if (amt <= 0) return null;
  const tax = round2(taxAmount);
  const revenueNet = round2(amt - tax);

  const codes = [INVOICE_GL_CODES.AR, INVOICE_GL_CODES.REVENUE];
  if (tax > 0) codes.push(INVOICE_GL_CODES.OUTPUT_TAX);
  const ids = await requireAccountIds(client, companyId, codes);
  const arId = ids[INVOICE_GL_CODES.AR];
  const revId = ids[INVOICE_GL_CODES.REVENUE];
  const taxPayableId = ids[INVOICE_GL_CODES.OUTPUT_TAX];

  const ref = `INV-${String(invoiceId).replace(/-/g, '').slice(0, 10)}`;
  const desc = `Invoice — ${String(customerName).slice(0, 200)}`;

  const txIns = await client.query(
    `INSERT INTO transactions (company_id, entry_date, description, reference)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, entryDate, desc, ref.slice(0, 100)]
  );
  const tid = txIns.rows[0].id;

  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, $3, 0)`,
    [tid, arId, amt]
  );
  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`,
    [tid, revId, revenueNet]
  );
  if (tax > 0) {
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`,
      [tid, taxPayableId, tax]
    );
  }

  await client.query(
    `UPDATE invoices SET sale_transaction_id = $1 WHERE id = $2 AND company_id = $3`,
    [tid, invoiceId, companyId]
  );
  return tid;
}

/**
 * Dr Cash (or bank-style asset) / Cr A/R — one journal per cash receipt.
 * Does not touch invoices; used for payment records and legacy invoice full-pay.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} opts
 * @param {string} [opts.cashAccountCode] — defaults to INVOICE_GL_CODES.CASH (extend for dedicated bank accounts)
 */
export async function postCashReceiptAgainstAr(client, {
  companyId,
  amount,
  entryDate,
  description,
  reference,
  cashAccountCode = INVOICE_GL_CODES.CASH,
}) {
  const amt = round2(amount);
  if (amt <= 0) return null;

  const ids = await requireAccountIds(client, companyId, [cashAccountCode, INVOICE_GL_CODES.AR]);
  const cashId = ids[cashAccountCode];
  const arId = ids[INVOICE_GL_CODES.AR];

  const ref = String(reference || 'PAY').slice(0, 100);
  const desc = String(description || 'Payment').slice(0, 500);

  const txIns = await client.query(
    `INSERT INTO transactions (company_id, entry_date, description, reference)
     VALUES ($1, $2::date, $3, $4) RETURNING id`,
    [companyId, entryDate, desc, ref]
  );
  const tid = txIns.rows[0].id;

  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, $3, 0)`,
    [tid, cashId, amt]
  );
  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`,
    [tid, arId, amt]
  );

  return tid;
}

/**
 * Dr Cash / Cr A/R (legacy single-invoice full payment); links journal on the invoice row.
 * @param {import('pg').PoolClient} client
 */
export async function postInvoicePayment(client, { companyId, invoiceId, amount, entryDate, customerName }) {
  const ref = `INV-PAY-${String(invoiceId).replace(/-/g, '').slice(0, 10)}`;
  const desc = `Invoice payment — ${String(customerName).slice(0, 200)}`;
  const tid = await postCashReceiptAgainstAr(client, {
    companyId,
    amount,
    entryDate,
    description: desc,
    reference: ref,
  });
  if (!tid) return null;
  await client.query(
    `UPDATE invoices SET payment_transaction_id = $1 WHERE id = $2 AND company_id = $3`,
    [tid, invoiceId, companyId]
  );
  return tid;
}

/**
 * Credit note posting: Dr Revenue / Cr A/R
 */
export async function postInvoiceCreditNote(client, {
  companyId,
  invoiceId,
  amount,
  entryDate,
  customerName,
}) {
  const amt = round2(amount);
  if (amt <= 0) return null;
  const ids = await requireAccountIds(client, companyId, [INVOICE_GL_CODES.REVENUE, INVOICE_GL_CODES.AR]);
  const revId = ids[INVOICE_GL_CODES.REVENUE];
  const arId = ids[INVOICE_GL_CODES.AR];

  const ref = `INV-CN-${String(invoiceId).replace(/-/g, '').slice(0, 10)}`;
  const desc = `Invoice credit note — ${String(customerName).slice(0, 200)}`;
  const txIns = await client.query(
    `INSERT INTO transactions (company_id, entry_date, description, reference)
     VALUES ($1, $2::date, $3, $4) RETURNING id`,
    [companyId, entryDate, desc, ref]
  );
  const tid = txIns.rows[0].id;
  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, $3, 0)`,
    [tid, revId, amt]
  );
  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`,
    [tid, arId, amt]
  );
  return tid;
}

/**
 * Customer refund posting: Dr A/R / Cr Cash
 */
export async function postInvoiceRefund(client, {
  companyId,
  invoiceId,
  amount,
  entryDate,
  customerName,
}) {
  const amt = round2(amount);
  if (amt <= 0) return null;
  const ids = await requireAccountIds(client, companyId, [INVOICE_GL_CODES.CASH, INVOICE_GL_CODES.AR]);
  const cashId = ids[INVOICE_GL_CODES.CASH];
  const arId = ids[INVOICE_GL_CODES.AR];

  const ref = `INV-REF-${String(invoiceId).replace(/-/g, '').slice(0, 10)}`;
  const desc = `Invoice refund — ${String(customerName).slice(0, 200)}`;
  const txIns = await client.query(
    `INSERT INTO transactions (company_id, entry_date, description, reference)
     VALUES ($1, $2::date, $3, $4) RETURNING id`,
    [companyId, entryDate, desc, ref]
  );
  const tid = txIns.rows[0].id;
  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, $3, 0)`,
    [tid, arId, amt]
  );
  await client.query(
    `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`,
    [tid, cashId, amt]
  );
  return tid;
}
