import { Router } from 'express';
import { query, pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { DEFAULT_ACCOUNTS } from '../utils/defaultAccounts.js';
import { createAccountAuto } from '../utils/accountHierarchy.js';

const router = Router();

router.use(authRequired);

/** List companies the user owns or is a member of */
router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT c.*,
              (c.owner_id = $1) AS is_owner,
              CASE
                WHEN c.owner_id = $1 THEN 'owner'
                ELSE m.role
              END AS user_role
       FROM companies c
       LEFT JOIN company_members m
         ON m.company_id = c.id AND m.user_id = $1 AND m.is_active = TRUE
       WHERE c.owner_id = $1 OR m.user_id IS NOT NULL
       ORDER BY c.name`,
      [req.user.id]
    );
    return res.json({ companies: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list companies' });
  }
});

/** Create company + default chart of accounts */
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, industry } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Company name required' });
    }
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO companies (name, owner_id, industry)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [String(name).trim(), req.user.id, industry || null]
    );
    const company = ins.rows[0];
    for (const a of DEFAULT_ACCOUNTS) {
      await createAccountAuto(client, {
        companyId: company.id,
        name: a.name,
        type: a.type,
        parentId: null,
      });
    }
    await client.query('COMMIT');
    // Match GET / shape so the client store has is_owner + user_role for nav/RBAC.
    const row = {
      ...company,
      is_owner: true,
      user_role: 'owner',
    };
    return res.status(201).json({ company: row });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    return res.status(500).json({ error: 'Failed to create company' });
  } finally {
    client.release();
  }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await query(
      `SELECT c.*,
              (c.owner_id = $2) AS is_owner,
              CASE
                WHEN c.owner_id = $2 THEN 'owner'
                ELSE m.role
              END AS user_role
       FROM companies c
       LEFT JOIN company_members m
         ON m.company_id = c.id AND m.user_id = $2 AND m.is_active = TRUE
       WHERE c.id = $1 AND (
         c.owner_id = $2 OR m.user_id IS NOT NULL
       )`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ company: r.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load company' });
  }
});

export default router;
