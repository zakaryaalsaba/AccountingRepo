import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import {
  createAccountAuto,
  generateChildCode,
  getChildCodeConstraints,
} from '../utils/accountHierarchy.js';
import { writeAuditEvent } from '../utils/auditLog.js';

const router = Router();
router.use(authRequired, companyContext);

const TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);

const ACCOUNT_LIST_SELECT = `SELECT id, company_id, account_code, level, name, type::text, parent_id, is_active, created_at,
       EXISTS (
         SELECT 1 FROM transaction_lines tl
         INNER JOIN transactions t ON t.id = tl.transaction_id
         WHERE tl.account_id = accounts.id AND t.company_id = accounts.company_id
       ) AS has_transactions
       FROM accounts`;

router.get('/', async (req, res) => {
  try {
    const r = await query(`${ACCOUNT_LIST_SELECT} WHERE company_id = $1 ORDER BY account_code`, [req.company.id]);
    return res.json({ accounts: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list accounts' });
  }
});

router.get('/tree', async (req, res) => {
  try {
    const r = await query(`${ACCOUNT_LIST_SELECT} WHERE company_id = $1 ORDER BY account_code`, [req.company.id]);
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

router.get('/add-child-meta', async (req, res) => {
  const parentId = req.query.parent_id;
  if (!parentId) {
    return res.status(400).json({ error: 'parent_id query parameter is required' });
  }
  const client = await pool.connect();
  try {
    const pr = await client.query(
      `SELECT id, name, account_code, level, type::text
       FROM accounts
       WHERE id = $1 AND company_id = $2`,
      [parentId, req.company.id]
    );
    if (!pr.rows.length) {
      return res.status(404).json({ error: 'Parent account not found' });
    }
    const parent = pr.rows[0];
    if (Number(parent.level) >= 5) {
      return res.status(400).json({ error: 'Maximum account depth is 5 levels' });
    }
    const tx = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM transaction_lines tl
         INNER JOIN transactions t ON t.id = tl.transaction_id
         WHERE tl.account_id = $1 AND t.company_id = $2
       ) AS e`,
      [parentId, req.company.id]
    );
    if (tx.rows[0]?.e) {
      return res.status(400).json({
        error: 'Cannot add a child under an account that already has journal activity',
        code: 'PARENT_HAS_ACTIVITY',
      });
    }
    let constraints;
    try {
      constraints = getChildCodeConstraints(parent);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid parent code' });
    }
    const suggested = await generateChildCode(client, req.company.id, parent);
    return res.json({
      parent: {
        id: parent.id,
        name: parent.name,
        account_code: parent.account_code,
        type: parent.type,
        level: parent.level,
      },
      suggested_account_code: suggested.account_code,
      constraints: {
        min_inclusive: constraints.min,
        max_inclusive: constraints.max,
        step: constraints.step,
        next_level: constraints.nextLevel,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load add-child metadata' });
  } finally {
    client.release();
  }
});

router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, type, parent_id, account_code } = req.body || {};
    if (!name || !type) {
      return res.status(400).json({ error: 'name and type are required' });
    }
    const normalizedType = String(type).toUpperCase();
    if (!TYPES.has(normalizedType)) {
      return res.status(400).json({ error: 'Invalid account type' });
    }

    let codeOverride = null;
    if (parent_id) {
      const parentRow = await client.query(
        `SELECT id, level, type::text FROM accounts WHERE id = $1 AND company_id = $2`,
        [parent_id, req.company.id]
      );
      if (!parentRow.rows.length) {
        return res.status(400).json({ error: 'Invalid parent_id' });
      }
      if (parentRow.rows[0].type !== normalizedType) {
        return res.status(400).json({ error: 'Child account type must match parent account type' });
      }
      if (Number(parentRow.rows[0].level) >= 5) {
        return res.status(400).json({ error: 'Maximum account depth is 5 levels' });
      }
      const tx = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM transaction_lines tl
           INNER JOIN transactions t ON t.id = tl.transaction_id
           WHERE tl.account_id = $1 AND t.company_id = $2
         ) AS e`,
        [parent_id, req.company.id]
      );
      if (tx.rows[0]?.e) {
        return res.status(400).json({
          error: 'Cannot add a child under an account that already has journal activity',
        });
      }
      if (account_code !== undefined && account_code !== null && String(account_code).trim() !== '') {
        codeOverride = String(account_code).trim();
      }
    } else if (account_code !== undefined && String(account_code).trim() !== '') {
      return res.status(400).json({ error: 'account_code can only be set when parent_id is provided' });
    }

    const account = await createAccountAuto(client, {
      companyId: req.company.id,
      name,
      type: normalizedType,
      parentId: parent_id || null,
      accountCodeOverride: codeOverride,
    });
    return res.status(201).json({ account });
  } catch (e) {
    if (e.status === 400 || e.status === 409) {
      return res.status(e.status).json({ error: e.message });
    }
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

router.patch('/:id/move', async (req, res) => {
  const client = await pool.connect();
  try {
    const { new_parent_id = null } = req.body || {};
    const cur = await client.query(
      `SELECT id, company_id, account_code, type::text, parent_id, level
       FROM accounts
       WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Account not found' });
    const account = cur.rows[0];
    const targetParentId = new_parent_id || null;
    if (targetParentId === account.id) {
      return res.status(400).json({ error: 'Account cannot be moved under itself' });
    }

    let parent = null;
    if (targetParentId) {
      const p = await client.query(
        `SELECT id, account_code, type::text, level
         FROM accounts
         WHERE id = $1 AND company_id = $2`,
        [targetParentId, req.company.id]
      );
      if (!p.rows.length) return res.status(400).json({ error: 'Invalid target parent account' });
      parent = p.rows[0];
      if (parent.type !== account.type) {
        return res.status(400).json({ error: 'Target parent must have the same account type' });
      }
    }

    // Prevent cycles: new parent cannot be one of this account descendants.
    if (targetParentId) {
      const descendants = await client.query(
        `WITH RECURSIVE tree AS (
           SELECT id FROM accounts WHERE parent_id = $1 AND company_id = $2
           UNION ALL
           SELECT a.id
           FROM accounts a
           JOIN tree t ON a.parent_id = t.id
           WHERE a.company_id = $2
         )
         SELECT id FROM tree`,
        [account.id, req.company.id]
      );
      const blocked = new Set(descendants.rows.map((r) => r.id));
      if (blocked.has(targetParentId)) {
        return res.status(400).json({ error: 'Target parent cannot be a child of this account' });
      }
    }

    const maxChildDepth = await client.query(
      `WITH RECURSIVE tree AS (
         SELECT id, 0::int AS d FROM accounts WHERE id = $1 AND company_id = $2
         UNION ALL
         SELECT a.id, t.d + 1
         FROM accounts a
         JOIN tree t ON a.parent_id = t.id
         WHERE a.company_id = $2
       )
       SELECT COALESCE(MAX(d), 0) AS max_d FROM tree`,
      [account.id, req.company.id]
    );
    const subtreeDepth = Number(maxChildDepth.rows[0]?.max_d || 0);
    const newRootLevel = parent ? Number(parent.level) + 1 : 1;
    if (newRootLevel + subtreeDepth > 5) {
      return res.status(400).json({ error: 'Move would exceed maximum account depth (5 levels)' });
    }

    const levelDelta = newRootLevel - Number(account.level);
    await client.query('BEGIN');
    await client.query(
      `UPDATE accounts SET parent_id = $3, level = $4 WHERE id = $1 AND company_id = $2`,
      [account.id, req.company.id, targetParentId, newRootLevel]
    );
    if (levelDelta !== 0) {
      await client.query(
        `WITH RECURSIVE tree AS (
           SELECT id FROM accounts WHERE parent_id = $1 AND company_id = $2
           UNION ALL
           SELECT a.id
           FROM accounts a
           JOIN tree t ON a.parent_id = t.id
           WHERE a.company_id = $2
         )
         UPDATE accounts a
         SET level = a.level + $3
         FROM tree
         WHERE a.id = tree.id`,
        [account.id, req.company.id, levelDelta]
      );
    }
    await client.query('COMMIT');

    await writeAuditEvent({
      companyId: req.company.id,
      actorUserId: req.user.id,
      eventType: 'account.moved',
      entityType: 'account',
      entityId: account.id,
      details: {
        old_parent_id: account.parent_id,
        new_parent_id: targetParentId,
      },
    });
    return res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    return res.status(500).json({ error: 'Failed to move account' });
  } finally {
    client.release();
  }
});

router.post('/bulk-status', async (req, res) => {
  try {
    const { account_ids, is_active } = req.body || {};
    if (!Array.isArray(account_ids) || !account_ids.length) {
      return res.status(400).json({ error: 'account_ids is required' });
    }
    const ids = account_ids.filter(Boolean);
    const active = Boolean(is_active);
    const up = await query(
      `UPDATE accounts
       SET is_active = $1
       WHERE company_id = $2 AND id = ANY($3::uuid[])
       RETURNING id`,
      [active, req.company.id, ids]
    );
    return res.json({ updated_count: up.rowCount });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update accounts status' });
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
