import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { apSchemaHint, apTablesExist } from '../utils/apSchema.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { postBillPayment, postBillRecognition } from '../utils/billPosting.js';

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
    const ins = await client.query(
      `INSERT INTO bills (
         company_id, vendor_id, bill_number, description, bill_date, due_date,
         expense_account_id, total_amount, paid_amount, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9::bill_status)
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

export default router;

