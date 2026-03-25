import { Router } from 'express';
import { pool, query } from '../../../db.js';
import { authRequired } from '../../../middleware/auth.js';
import { companyContext } from '../../../middleware/companyContext.js';
import { requireManageRoles } from '../middleware/staffGuards.js';

const router = Router();
router.use(authRequired, companyContext, requireManageRoles);

/** Normalize permissions payload: must be a plain object (JSON). */
function parsePermissions(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return raw;
}

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, company_id, role_name, permissions, created_at
       FROM staff_roles
       WHERE company_id = $1
       ORDER BY role_name ASC`,
      [req.company.id]
    );
    return res.json({ roles: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list roles' });
  }
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  const { role_name, permissions } = body;
  if (!role_name || !String(role_name).trim()) {
    return res.status(400).json({ error: 'role_name is required' });
  }
  const perms = parsePermissions(permissions);
  if (perms === null) return res.status(400).json({ error: 'permissions must be a JSON object' });
  try {
    const r = await query(
      `INSERT INTO staff_roles (company_id, role_name, permissions)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, company_id, role_name, permissions, created_at`,
      [req.company.id, String(role_name).trim().slice(0, 100), JSON.stringify(perms)]
    );
    return res.status(201).json({ role: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A role with this name already exists' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to create role' });
  }
});

router.put('/:id', async (req, res) => {
  const body = req.body || {};
  const { role_name, permissions } = body;
  try {
    const cur = await query(
      `SELECT id FROM staff_roles WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });

    let nextName;
    if (role_name !== undefined) {
      if (!String(role_name).trim()) return res.status(400).json({ error: 'role_name cannot be empty' });
      nextName = String(role_name).trim().slice(0, 100);
    }

    let nextPerms;
    if (permissions !== undefined) {
      const p = parsePermissions(permissions);
      if (p === null) return res.status(400).json({ error: 'permissions must be a JSON object' });
      nextPerms = p;
    }

    const r = await query(
      `UPDATE staff_roles
       SET role_name = COALESCE($1, role_name),
           permissions = COALESCE($2::jsonb, permissions)
       WHERE id = $3 AND company_id = $4
       RETURNING id, company_id, role_name, permissions, created_at`,
      [
        nextName ?? null,
        nextPerms !== undefined ? JSON.stringify(nextPerms) : null,
        req.params.id,
        req.company.id,
      ]
    );
    return res.json({ role: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A role with this name already exists' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to update role' });
  }
});

router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const cur = await client.query(
      `SELECT id FROM staff_roles WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });

    const use = await client.query(
      `SELECT COUNT(*)::int AS n FROM company_member_staff_roles WHERE staff_role_id = $1`,
      [req.params.id]
    );
    if (use.rows[0].n > 0) {
      return res.status(400).json({ error: 'Role is assigned to staff; remove assignments first' });
    }

    await client.query(`DELETE FROM staff_roles WHERE id = $1 AND company_id = $2`, [
      req.params.id,
      req.company.id,
    ]);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete role' });
  } finally {
    client.release();
  }
});

export default router;
