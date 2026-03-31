import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import {
  apSchemaHint,
  apTablesExist,
  billCreditsSchemaHint,
  billCreditsTableExists,
} from '../utils/apSchema.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import {
  postBillCredit,
  postBillPayment,
  postBillRecognition,
  postVendorRefundReceipt,
} from '../utils/billPosting.js';
import { billsHaveTaxColumns, calcTax } from '../utils/taxSchema.js';

const router = Router();
router.use(authRequired, companyContext);

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
function statusFromPaidTotal(total, paid) {
  if (total <= 0) return 'paid';
  if (paid <= 0) return 'unpaid';
  if (paid >= total) return 'paid';
  return 'partially_paid';
}

router.use(async (_req, res, next) => {
  if (!(await apTablesExist())) {
    return res.status(503).json({ error: 'AP schema not installed.', hint: apSchemaHint() });
  }
  return next();
});

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT b.*, v.name AS vendor_name
       FROM bills b
       JOIN vendors v ON v.id = b.vendor_id
       WHERE b.company_id = $1
       ORDER BY b.bill_date DESC, b.created_at DESC`,
      [req.company.id]
    );
    return res.json({ bills: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list bills' });
  }
});

router.post('/', async (req, res) => {
  const {
    vendor_id,
    bill_number,
    description,
    bill_date,
    due_date,
    expense_account_id,
    total_amount,
    tax_rate_id,
    tax_inclusive = false,
    status = 'unpaid',
  } = req.body || {};
  if (!vendor_id || !bill_date || !due_date || !expense_account_id || total_amount === undefined) {
    return res.status(400).json({ error: 'vendor_id, bill_date, due_date, expense_account_id, total_amount required' });
  }
  const total = round2(total_amount);
  if (total < 0) return res.status(400).json({ error: 'total_amount must be >= 0' });

  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, bill_date, client);
    await client.query('BEGIN');
    const dup = await client.query(
      `SELECT id
       FROM bills
       WHERE company_id = $1
         AND vendor_id = $2
         AND bill_date = $3
         AND total_amount = $4
       LIMIT 1`,
      [req.company.id, vendor_id, bill_date, total]
    );
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Possible duplicate bill detected' });
    }
    const vendor = await client.query(
      `SELECT id, name FROM vendors WHERE id = $1 AND company_id = $2`,
      [vendor_id, req.company.id]
    );
    if (!vendor.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vendor not found' });
    }
    const acc = await client.query(
      `SELECT id, type FROM accounts WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
      [expense_account_id, req.company.id]
    );
    if (!acc.rows.length || acc.rows[0].type !== 'EXPENSE') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'expense_account_id must be an active EXPENSE account' });
    }
    const nextStatus = status === 'draft' ? 'draft' : 'unpaid';
    const taxCols = await billsHaveTaxColumns();
    let subtotalAmount = total;
    let taxAmount = 0;
    if (taxCols && tax_rate_id) {
      const tr = await client.query(
        `SELECT rate_percent FROM tax_rates WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
        [tax_rate_id, req.company.id]
      );
      if (!tr.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid tax_rate_id' });
      }
      const c = calcTax({
        amountInput: total,
        ratePercent: tr.rows[0].rate_percent,
        taxInclusive: Boolean(tax_inclusive),
      });
      subtotalAmount = c.subtotal;
      taxAmount = c.tax;
    }
    const ins = await client.query(
      `INSERT INTO bills (
         company_id, vendor_id, bill_number, description, bill_date, due_date,
         expense_account_id, total_amount, paid_amount, status${
           taxCols ? ', subtotal_amount, tax_amount, tax_inclusive, tax_rate_id' : ''
         }
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9::bill_status${
         taxCols ? ',$10,$11,$12,$13' : ''
       })
       RETURNING *`,
      [
        req.company.id,
        vendor_id,
        bill_number ? String(bill_number).trim() : null,
        description ? String(description) : null,
        bill_date,
        due_date,
        expense_account_id,
        total,
        nextStatus,
        ...(taxCols ? [subtotalAmount, taxAmount, Boolean(tax_inclusive), tax_rate_id || null] : []),
      ]
    );
    const bill = ins.rows[0];
    if (bill.status !== 'draft' && total > 0) {
      const txId = await postBillRecognition(client, {
        companyId: req.company.id,
        billId: bill.id,
        amount: total,
        entryDate: bill_date,
        expenseAccountId: expense_account_id,
        vendorName: vendor.rows[0].name,
        taxAmount: taxCols ? taxAmount : 0,
      });
      await client.query(
        `UPDATE bills SET posting_transaction_id = $1 WHERE id = $2 AND company_id = $3`,
        [txId, bill.id, req.company.id]
      );
    }
    const out = await client.query(`SELECT * FROM bills WHERE id = $1 AND company_id = $2`, [
      bill.id,
      req.company.id,
    ]);
    await client.query('COMMIT');
    return res.status(201).json({ bill: out.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create bill' });
  } finally {
    client.release();
  }
});

router.post('/:id/payments', async (req, res) => {
  const { amount, payment_date, method = 'cash', reference } = req.body || {};
  const payAmount = round2(amount);
  if (!payment_date || !payAmount || payAmount <= 0) {
    return res.status(400).json({ error: 'payment_date and positive amount are required' });
  }
  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, payment_date, client);
    await client.query('BEGIN');
    const bRes = await client.query(
      `SELECT b.*, v.name AS vendor_name
       FROM bills b
       JOIN vendors v ON v.id = b.vendor_id
       WHERE b.id = $1 AND b.company_id = $2
       FOR UPDATE`,
      [req.params.id, req.company.id]
    );
    if (!bRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bill not found' });
    }
    const bill = bRes.rows[0];
    if (bill.status === 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot pay a draft bill' });
    }
    const open = round2(Number(bill.total_amount) - Number(bill.paid_amount));
    if (payAmount > open + 0.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Payment exceeds outstanding bill balance' });
    }
    const txId = await postBillPayment(client, {
      companyId: req.company.id,
      billId: bill.id,
      amount: payAmount,
      entryDate: payment_date,
      vendorName: bill.vendor_name,
    });
    const p = await client.query(
      `INSERT INTO bill_payments (company_id, bill_id, payment_date, amount, method, reference, payment_transaction_id)
       VALUES ($1,$2,$3,$4,$5::payment_method,$6,$7)
       RETURNING *`,
      [req.company.id, bill.id, payment_date, payAmount, method, reference || null, txId]
    );
    const newPaid = round2(Number(bill.paid_amount) + payAmount);
    const newStatus = statusFromPaidTotal(Number(bill.total_amount), newPaid);
    await client.query(
      `UPDATE bills
       SET paid_amount = $1, status = $2::bill_status, updated_at = NOW()
       WHERE id = $3 AND company_id = $4`,
      [newPaid, newStatus, bill.id, req.company.id]
    );
    const out = await client.query(`SELECT * FROM bills WHERE id = $1 AND company_id = $2`, [
      bill.id,
      req.company.id,
    ]);
    await client.query('COMMIT');
    return res.status(201).json({ payment: p.rows[0], bill: out.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create bill payment' });
  } finally {
    client.release();
  }
});

router.get('/:id/credits', async (req, res) => {
  try {
    if (!(await billCreditsTableExists())) {
      return res.status(503).json({ error: 'Vendor credits schema not installed.', hint: billCreditsSchemaHint() });
    }
    const bill = await query(`SELECT id FROM bills WHERE id = $1 AND company_id = $2`, [
      req.params.id,
      req.company.id,
    ]);
    if (!bill.rows.length) return res.status(404).json({ error: 'Bill not found' });
    const r = await query(
      `SELECT *
       FROM bill_credits
       WHERE company_id = $1 AND bill_id = $2
       ORDER BY credit_date DESC, created_at DESC`,
      [req.company.id, req.params.id]
    );
    return res.json({ credits: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list vendor credits' });
  }
});

router.post('/:id/credits', async (req, res) => {
  if (!(await billCreditsTableExists())) {
    return res.status(503).json({ error: 'Vendor credits schema not installed.', hint: billCreditsSchemaHint() });
  }
  const { amount, credit_date, reason, is_refund = false } = req.body || {};
  const creditAmount = round2(amount);
  if (!credit_date || !creditAmount || creditAmount <= 0) {
    return res.status(400).json({ error: 'credit_date and positive amount are required' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'reason is required for credit/refund' });
  }
  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, credit_date, client);
    await client.query('BEGIN');
    const bRes = await client.query(
      `SELECT b.*, v.name AS vendor_name
       FROM bills b
       JOIN vendors v ON v.id = b.vendor_id
       WHERE b.id = $1 AND b.company_id = $2
       FOR UPDATE`,
      [req.params.id, req.company.id]
    );
    if (!bRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Bill not found' });
    }
    const bill = bRes.rows[0];
    if (bill.status === 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot credit a draft bill' });
    }
    const total = round2(bill.total_amount);
    const paid = round2(bill.paid_amount);
    const open = round2(total - paid);
    if (!is_refund && creditAmount > open + 0.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Credit amount exceeds outstanding bill balance' });
    }
    if (is_refund && creditAmount > paid + 0.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Refund credit amount exceeds paid amount' });
    }

    const newTotal = round2(total - creditAmount);
    const newPaid = is_refund ? round2(paid - creditAmount) : paid;
    if (newTotal < 0 || newPaid < 0 || newPaid > newTotal + 0.0001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Credit would result in invalid bill balances' });
    }
    let creditTxId = null;
    let refundTxId = null;
    creditTxId = await postBillCredit(client, {
      companyId: req.company.id,
      billId: bill.id,
      amount: creditAmount,
      entryDate: credit_date,
      expenseAccountId: bill.expense_account_id,
      vendorName: bill.vendor_name,
    });
    if (is_refund) {
      refundTxId = await postVendorRefundReceipt(client, {
        companyId: req.company.id,
        billId: bill.id,
        amount: creditAmount,
        entryDate: credit_date,
        vendorName: bill.vendor_name,
      });
    }
    const newStatus = statusFromPaidTotal(newTotal, newPaid);
    await client.query(
      `UPDATE bills
       SET total_amount = $1,
           paid_amount = $2,
           status = $3::bill_status,
           updated_at = NOW()
       WHERE id = $4 AND company_id = $5`,
      [newTotal, newPaid, newStatus, bill.id, req.company.id]
    );
    const c = await client.query(
      `INSERT INTO bill_credits (
         company_id, bill_id, credit_date, amount, reason, is_refund,
         credit_transaction_id, refund_transaction_id, created_by
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        req.company.id,
        bill.id,
        credit_date,
        creditAmount,
        reason ? String(reason) : null,
        Boolean(is_refund),
        creditTxId,
        refundTxId,
        req.user.id,
      ]
    );
    const out = await client.query(`SELECT * FROM bills WHERE id = $1 AND company_id = $2`, [
      bill.id,
      req.company.id,
    ]);
    await client.query('COMMIT');
    return res.status(201).json({ credit: c.rows[0], bill: out.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create vendor credit' });
  } finally {
    client.release();
  }
});

export default router;

