import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { assertDateOpen } from '../utils/periodLocks.js';

const router = Router();
router.use(authRequired, companyContext);

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

router.post('/transfer', async (req, res) => {
  const { entry_date, from_account_id, to_account_id, amount, reference, description } = req.body || {};
  const amt = round2(amount);
  if (!entry_date || !from_account_id || !to_account_id || !amt || amt <= 0) {
    return res.status(400).json({
      error: 'entry_date, from_account_id, to_account_id, and positive amount are required',
    });
  }
  if (from_account_id === to_account_id) {
    return res.status(400).json({ error: 'from_account_id and to_account_id must be different' });
  }

  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, entry_date, client);
    await client.query('BEGIN');

    const fromAcc = await client.query(
      `SELECT id, type::text
       FROM accounts
       WHERE id = $1 AND company_id = $2 AND is_active = TRUE AND level = 5`,
      [from_account_id, req.company.id]
    );
    const toAcc = await client.query(
      `SELECT id, type::text
       FROM accounts
       WHERE id = $1 AND company_id = $2 AND is_active = TRUE AND level = 5`,
      [to_account_id, req.company.id]
    );
    if (!fromAcc.rows.length || !toAcc.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Invalid account(s) for transfer (must be active posting accounts, level 5)',
      });
    }
    if (fromAcc.rows[0].type !== 'ASSET' || toAcc.rows[0].type !== 'ASSET') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Transfer requires ASSET accounts (typically cash/bank accounts)',
      });
    }

    const desc =
      description || `Transfer ${from_account_id.slice(0, 6)} -> ${to_account_id.slice(0, 6)}`;
    const tx = await client.query(
      `INSERT INTO transactions (company_id, entry_date, description, reference)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.company.id, entry_date, desc, reference || null]
    );
    const txId = tx.rows[0].id;

    // Credit source account, debit destination account.
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
       VALUES ($1, $2, 0, $3)`,
      [txId, from_account_id, amt]
    );
    await client.query(
      `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
       VALUES ($1, $2, $3, 0)`,
      [txId, to_account_id, amt]
    );

    const linesOut = await client.query(
      `SELECT tl.*, a.code AS account_code, a.name AS account_name
       FROM transaction_lines tl
       JOIN accounts a ON a.id = tl.account_id
       WHERE tl.transaction_id = $1
       ORDER BY tl.id`,
      [txId]
    );
    await client.query('COMMIT');
    return res.status(201).json({ transaction: { ...tx.rows[0], lines: linesOut.rows } });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create transfer' });
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { from, to, limit = '50', offset = '0' } = req.query;
    let sql = `
      SELECT t.id, t.company_id, t.entry_date, t.description, t.reference, t.created_at
      FROM transactions t
      WHERE t.company_id = $1`;
    const params = [req.company.id];
    let i = 2;
    if (from) {
      sql += ` AND t.entry_date >= $${i++}`;
      params.push(from);
    }
    if (to) {
      sql += ` AND t.entry_date <= $${i++}`;
      params.push(to);
    }
    const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    sql += ` ORDER BY t.entry_date DESC, t.created_at DESC LIMIT $${i} OFFSET $${i + 1}`;
    params.push(lim, off);
    const list = await client.query(sql, params);
    const ids = list.rows.map((r) => r.id);
    if (!ids.length) {
      return res.json({ transactions: [] });
    }
    const lines = await client.query(
      `SELECT tl.*, a.code AS account_code, a.name AS account_name
       FROM transaction_lines tl
       JOIN accounts a ON a.id = tl.account_id AND a.company_id = $2
       WHERE tl.transaction_id = ANY($1::uuid[])
       ORDER BY tl.id`,
      [ids, req.company.id]
    );
    const byTx = {};
    for (const l of lines.rows) {
      if (!byTx[l.transaction_id]) byTx[l.transaction_id] = [];
      byTx[l.transaction_id].push(l);
    }
    const transactions = list.rows.map((t) => ({
      ...t,
      lines: byTx[t.id] || [],
    }));
    return res.json({ transactions });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list transactions' });
  } finally {
    client.release();
  }
});

router.get('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const t = await client.query(
      `SELECT * FROM transactions WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!t.rows.length) return res.status(404).json({ error: 'Not found' });
    const lines = await client.query(
      `SELECT tl.*, a.code AS account_code, a.name AS account_name
       FROM transaction_lines tl
       JOIN accounts a ON a.id = tl.account_id
       WHERE tl.transaction_id = $1 AND a.company_id = $2
       ORDER BY tl.id`,
      [req.params.id, req.company.id]
    );
    return res.json({ transaction: { ...t.rows[0], lines: lines.rows } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load transaction' });
  } finally {
    client.release();
  }
});

router.post('/', async (req, res) => {
  const { entry_date, description, reference, lines } = req.body || {};
  if (!entry_date || !Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({
      error: 'entry_date and at least two lines (debit/credit) are required',
    });
  }
  let debitSum = 0;
  let creditSum = 0;
  for (const ln of lines) {
    const d = round2(ln.debit || 0);
    const c = round2(ln.credit || 0);
    if ((d > 0 && c > 0) || (d === 0 && c === 0)) {
      return res.status(400).json({ error: 'Each line must have either debit or credit' });
    }
    debitSum += d;
    creditSum += c;
  }
  if (round2(debitSum) !== round2(creditSum)) {
    return res.status(400).json({ error: 'Total debits must equal total credits' });
  }

  const client = await pool.connect();
  try {
    await assertDateOpen(req.company.id, entry_date, client);
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO transactions (company_id, entry_date, description, reference)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.company.id, entry_date, description || null, reference || null]
    );
    const tx = ins.rows[0];
    for (const ln of lines) {
      const d = round2(ln.debit || 0);
      const c = round2(ln.credit || 0);
      const acc = await client.query(
        'SELECT id FROM accounts WHERE id = $1 AND company_id = $2 AND is_active = TRUE AND level = 5',
        [ln.account_id, req.company.id]
      );
      if (!acc.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Invalid account for posting (must be active level 5): ${ln.account_id}` });
      }
      await client.query(
        `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
         VALUES ($1, $2, $3, $4)`,
        [tx.id, ln.account_id, d, c]
      );
    }
    await client.query('COMMIT');
    const linesOut = await client.query(
      `SELECT tl.*, a.code AS account_code, a.name AS account_name
       FROM transaction_lines tl
       JOIN accounts a ON a.id = tl.account_id
       WHERE tl.transaction_id = $1`,
      [tx.id]
    );
    return res.status(201).json({ transaction: { ...tx, lines: linesOut.rows } });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create transaction' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const cur = await pool.query(
      'SELECT entry_date FROM transactions WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    await assertDateOpen(req.company.id, cur.rows[0].entry_date);

    const r = await pool.query(
      'DELETE FROM transactions WHERE id = $1 AND company_id = $2 RETURNING id',
      [req.params.id, req.company.id]
    );
    return res.json({ ok: true });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

export default router;
