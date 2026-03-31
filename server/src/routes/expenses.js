import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { postExpenseEntry } from '../utils/expensePosting.js';
import { expenseSchemaHint, expensesHaveAdvancedColumns } from '../utils/expenseSchema.js';

const router = Router();
router.use(authRequired, companyContext);
const PAYMENT_METHODS = new Set(['cash', 'card', 'bank_transfer', 'payable']);

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT e.*, a.code AS account_code, a.name AS account_name
       FROM expenses e
       JOIN accounts a ON a.id = e.account_id AND a.company_id = e.company_id
       WHERE e.company_id = $1
       ORDER BY e.expense_date DESC, e.created_at DESC`,
      [req.company.id]
    );
    return res.json({ expenses: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list expenses' });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      account_id,
      amount,
      description,
      expense_date,
      vendor_name,
      payment_method = 'cash',
      receipt_reference,
      receipt_attachment_url,
      ocr_raw_text,
    } = req.body || {};
    if (!account_id || !amount || !expense_date) {
      return res.status(400).json({
        error: 'account_id, amount, and expense_date are required',
      });
    }
    if (!PAYMENT_METHODS.has(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment_method' });
    }
    const acc = await query(
      `SELECT id, type::text FROM accounts
       WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
      [account_id, req.company.id]
    );
    if (!acc.rows.length) {
      return res.status(400).json({ error: 'Invalid account' });
    }
    if (acc.rows[0].type !== 'EXPENSE') {
      return res.status(400).json({ error: 'Account must be of type EXPENSE' });
    }
    const dup = await query(
      `SELECT id
       FROM expenses
       WHERE company_id = $1
         AND account_id = $2
         AND amount = $3
         AND expense_date = $4
         AND COALESCE(description, '') = COALESCE($5, '')
       LIMIT 1`,
      [req.company.id, account_id, Number(amount), expense_date, description ? String(description) : null]
    );
    if (dup.rows.length) {
      return res.status(409).json({ error: 'Possible duplicate expense detected' });
    }
    const advanced = await expensesHaveAdvancedColumns();
    const client = await pool.connect();
    try {
      await assertDateOpen(req.company.id, expense_date, client);
      await client.query('BEGIN');
      let ins;
      if (advanced) {
        ins = await client.query(
          `INSERT INTO expenses (
             company_id, account_id, amount, vendor_name, payment_method, receipt_reference,
             receipt_attachment_url, ocr_raw_text, description, expense_date
           )
           VALUES ($1,$2,$3,$4,$5::expense_payment_method,$6,$7,$8,$9,$10)
           RETURNING *`,
          [
            req.company.id,
            account_id,
            Number(amount),
            vendor_name ? String(vendor_name).trim() : null,
            payment_method,
            receipt_reference ? String(receipt_reference).trim() : null,
            receipt_attachment_url ? String(receipt_attachment_url).trim() : null,
            ocr_raw_text ? String(ocr_raw_text) : null,
            description ? String(description) : null,
            expense_date,
          ]
        );
        const ex = ins.rows[0];
        const txId = await postExpenseEntry(client, {
          companyId: req.company.id,
          expenseId: ex.id,
          amount: ex.amount,
          entryDate: ex.expense_date,
          expenseAccountId: ex.account_id,
          paymentMethod: ex.payment_method,
          description: ex.description || ex.vendor_name || 'Expense',
        });
        await client.query(
          `UPDATE expenses SET posting_transaction_id = $1, updated_at = NOW()
           WHERE id = $2 AND company_id = $3`,
          [txId, ex.id, req.company.id]
        );
        ins = await client.query(`SELECT * FROM expenses WHERE id = $1 AND company_id = $2`, [
          ex.id,
          req.company.id,
        ]);
      } else {
        ins = await client.query(
          `INSERT INTO expenses (company_id, account_id, amount, description, expense_date)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            req.company.id,
            account_id,
            Number(amount),
            description ? String(description) : null,
            expense_date,
          ]
        );
      }
      await client.query('COMMIT');
      const payload = advanced
        ? ins.rows[0]
        : { ...ins.rows[0], posting_transaction_id: null, payment_method: null };
      return res.status(201).json({
        expense: payload,
        warning: advanced ? null : `Expense GL automation unavailable. ${expenseSchemaHint()}`,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create expense' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { account_id, amount, description, expense_date, vendor_name, payment_method } = req.body || {};
    const cur = await query(
      'SELECT * FROM expenses WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    let nextAccount = account_id !== undefined ? account_id : row.account_id;
    if (account_id !== undefined) {
      const acc = await query(
        `SELECT type::text FROM accounts
         WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
        [nextAccount, req.company.id]
      );
      if (!acc.rows.length) return res.status(400).json({ error: 'Invalid account' });
      if (acc.rows[0].type !== 'EXPENSE') {
        return res.status(400).json({ error: 'Account must be of type EXPENSE' });
      }
    }
    const nextAmount = amount !== undefined ? Number(amount) : row.amount;
    const nextDesc = description !== undefined ? description : row.description;
    const nextDate = expense_date !== undefined ? expense_date : row.expense_date;
    const advanced = await expensesHaveAdvancedColumns();
    if (advanced && row.posting_transaction_id) {
      const immutable =
        account_id !== undefined ||
        amount !== undefined ||
        expense_date !== undefined ||
        payment_method !== undefined;
      if (immutable) {
        return res.status(400).json({
          error: 'Posted expense cannot change account/amount/date/payment_method; delete and recreate',
        });
      }
    }
    await assertDateOpen(req.company.id, row.expense_date);
    await assertDateOpen(req.company.id, nextDate);
    const upd = advanced
      ? await query(
          `UPDATE expenses
           SET account_id = $1, amount = $2, description = $3, expense_date = $4,
               vendor_name = $5,
               payment_method = $6::expense_payment_method,
               updated_at = NOW()
           WHERE id = $7 AND company_id = $8
           RETURNING *`,
          [
            nextAccount,
            nextAmount,
            nextDesc,
            nextDate,
            vendor_name !== undefined ? (vendor_name ? String(vendor_name).trim() : null) : row.vendor_name,
            payment_method !== undefined ? payment_method : row.payment_method,
            req.params.id,
            req.company.id,
          ]
        )
      : await query(
          `UPDATE expenses
           SET account_id = $1, amount = $2, description = $3, expense_date = $4
           WHERE id = $5 AND company_id = $6
           RETURNING *`,
          [nextAccount, nextAmount, nextDesc, nextDate, req.params.id, req.company.id]
        );
    return res.json({ expense: upd.rows[0] });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to update expense' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'reason is required for delete' });
    }
    const cur = await query(
      'SELECT expense_date, posting_transaction_id FROM expenses WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    await assertDateOpen(req.company.id, cur.rows[0].expense_date);
    if (cur.rows[0].posting_transaction_id) {
      return res.status(400).json({
        error: 'Posted expense cannot be deleted; create reversing entry instead',
      });
    }
    const r = await query(
      'DELETE FROM expenses WHERE id = $1 AND company_id = $2 RETURNING id',
      [req.params.id, req.company.id]
    );
    return res.json({ ok: true });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete expense' });
  }
});

export default router;
