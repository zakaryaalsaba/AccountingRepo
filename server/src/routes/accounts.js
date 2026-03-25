import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';

const router = Router();
router.use(authRequired, companyContext);

const TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, company_id, code, name, type::text, parent_id, is_active, created_at
       FROM accounts
       WHERE company_id = $1
       ORDER BY code`,
      [req.company.id]
    );
    return res.json({ accounts: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list accounts' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { code, name, type, parent_id } = req.body || {};
    if (!code || !name || !type) {
      return res.status(400).json({ error: 'code, name, and type are required' });
    }
    if (!TYPES.has(String(type).toUpperCase())) {
      return res.status(400).json({ error: 'Invalid account type' });
    }
    if (parent_id) {
      const p = await query(
        'SELECT id FROM accounts WHERE id = $1 AND company_id = $2',
        [parent_id, req.company.id]
      );
      if (!p.rows.length) return res.status(400).json({ error: 'Invalid parent_id' });
    }
    const ins = await query(
      `INSERT INTO accounts (company_id, code, name, type, parent_id)
       VALUES ($1, $2, $3, $4::account_type, $5)
       RETURNING id, company_id, code, name, type::text, parent_id, is_active, created_at`,
      [
        req.company.id,
        String(code).trim(),
        String(name).trim(),
        String(type).toUpperCase(),
        parent_id || null,
      ]
    );
    return res.status(201).json({ account: ins.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Account code already exists for this company' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to create account' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { name, code, is_active, parent_id } = req.body || {};
    const cur = await query(
      'SELECT * FROM accounts WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Account not found' });
    const row = cur.rows[0];
    const nextName = name !== undefined ? String(name).trim() : row.name;
    const nextCode = code !== undefined ? String(code).trim() : row.code;
    const nextActive = is_active !== undefined ? Boolean(is_active) : row.is_active;
    let nextParent = parent_id !== undefined ? parent_id : row.parent_id;
    if (nextParent) {
      const p = await query(
        'SELECT id FROM accounts WHERE id = $1 AND company_id = $2',
        [nextParent, req.company.id]
      );
      if (!p.rows.length) return res.status(400).json({ error: 'Invalid parent_id' });
    }
    const upd = await query(
      `UPDATE accounts SET name = $1, code = $2, is_active = $3, parent_id = $4
       WHERE id = $5 AND company_id = $6
       RETURNING id, company_id, code, name, type::text, parent_id, is_active, created_at`,
      [nextName, nextCode, nextActive, nextParent, req.params.id, req.company.id]
    );
    return res.json({ account: upd.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Account code already exists for this company' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to update account' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const lines = await query(
      `SELECT 1 FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       WHERE tl.account_id = $1 AND t.company_id = $2 LIMIT 1`,
      [req.params.id, req.company.id]
    );
    if (lines.rows.length) {
      return res.status(400).json({
        error: 'Cannot delete account referenced by journal lines',
      });
    }
    const exp = await query(
      'SELECT 1 FROM expenses WHERE account_id = $1 AND company_id = $2 LIMIT 1',
      [req.params.id, req.company.id]
    );
    if (exp.rows.length) {
      return res.status(400).json({ error: 'Cannot delete account linked to expenses' });
    }
    const r = await query(
      'DELETE FROM accounts WHERE id = $1 AND company_id = $2 RETURNING id',
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Account not found' });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
});

export default router;
