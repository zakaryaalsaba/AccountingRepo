import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { assertDateOpen } from '../utils/periodLocks.js';

const router = Router();
router.use(authRequired, companyContext);

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
    const { account_id, amount, description, expense_date } = req.body || {};
    if (!account_id || !amount || !expense_date) {
      return res.status(400).json({
        error: 'account_id, amount, and expense_date are required',
      });
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
    await assertDateOpen(req.company.id, expense_date);
    const ins = await query(
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
    return res.status(201).json({ expense: ins.rows[0] });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create expense' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { account_id, amount, description, expense_date } = req.body || {};
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
    await assertDateOpen(req.company.id, row.expense_date);
    await assertDateOpen(req.company.id, nextDate);
    const upd = await query(
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
    const cur = await query(
      'SELECT expense_date FROM expenses WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    await assertDateOpen(req.company.id, cur.rows[0].expense_date);
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
