import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { createAccountAuto } from '../utils/accountHierarchy.js';

const router = Router();
router.use(authRequired, companyContext);

const TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, company_id, account_code, level, name, type::text, parent_id, is_active, created_at
       FROM accounts
       WHERE company_id = $1
       ORDER BY account_code`,
      [req.company.id]
    );
    return res.json({ accounts: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list accounts' });
  }
});

router.get('/tree', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, company_id, account_code, level, name, type::text, parent_id, is_active, created_at
       FROM accounts
       WHERE company_id = $1
       ORDER BY account_code`,
      [req.company.id]
    );
    const rows = r.rows;
    const byId = new Map(rows.map((a) => [a.id, { ...a, children: [] }]));
    const roots = [];
    for (const row of byId.values()) {
      if (row.parent_id && byId.has(row.parent_id)) byId.get(row.parent_id).children.push(row);
      else roots.push(row);
    }
    return res.json({ accounts: rows, tree: roots });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load accounts tree' });
  }
});

router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, type, parent_id } = req.body || {};
    if (!name || !type) {
      return res.status(400).json({ error: 'name and type are required' });
    }
    const normalizedType = String(type).toUpperCase();
    if (!TYPES.has(normalizedType)) {
      return res.status(400).json({ error: 'Invalid account type' });
    }

    const account = await createAccountAuto(client, {
      companyId: req.company.id,
      name,
      type: normalizedType,
      parentId: parent_id || null,
    });
    return res.status(201).json({ account });
  } catch (e) {
    if (e.message === 'Invalid parent_id' || e.message === 'Maximum account depth is 5 levels') {
      return res.status(400).json({ error: e.message });
    }
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Account code already exists for this company' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to create account' });
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { name, is_active, parent_id, code, account_code } = req.body || {};
    if (code !== undefined || account_code !== undefined) {
      return res.status(400).json({ error: 'account_code is generated automatically and cannot be edited' });
    }

    const cur = await query(
      'SELECT id, parent_id, name, is_active FROM accounts WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Account not found' });
    const row = cur.rows[0];

    if (parent_id !== undefined && parent_id !== row.parent_id) {
      return res.status(400).json({ error: 'Changing parent_id is not allowed for existing accounts' });
    }

    const nextName = name !== undefined ? String(name).trim() : row.name;
    const nextActive = is_active !== undefined ? Boolean(is_active) : row.is_active;
    const upd = await query(
      `UPDATE accounts SET name = $1, is_active = $2
       WHERE id = $3 AND company_id = $4
       RETURNING id, company_id, account_code, level, name, type::text, parent_id, is_active, created_at`,
      [nextName, nextActive, req.params.id, req.company.id]
    );
    return res.json({ account: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update account' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const children = await query(
      `SELECT 1 FROM accounts WHERE company_id = $1 AND parent_id = $2 LIMIT 1`,
      [req.company.id, req.params.id]
    );
    if (children.rows.length) {
      return res.status(400).json({ error: 'Cannot delete account that has child accounts' });
    }
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
