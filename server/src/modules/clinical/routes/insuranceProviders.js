import { Router } from 'express';
import { pool } from '../../../db.js';
import { authRequired } from '../../../middleware/auth.js';
import { companyContext } from '../../../middleware/companyContext.js';

const router = Router();
router.use(authRequired, companyContext);

router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, company_id, name, contact_info, created_at
       FROM insurance_providers
       WHERE company_id = $1
       ORDER BY name ASC`,
      [req.company.id]
    );
    return res.json({ insurance_providers: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list insurance providers' });
  }
});

router.post('/', async (req, res) => {
  const { name, contact_info } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO insurance_providers (company_id, name, contact_info)
       VALUES ($1, $2, $3)
       RETURNING id, company_id, name, contact_info, created_at`,
      [req.company.id, String(name).trim(), contact_info != null ? String(contact_info) : null]
    );
    return res.status(201).json({ insurance_provider: r.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create insurance provider' });
  }
});

router.put('/:id', async (req, res) => {
  const { name, contact_info } = req.body || {};
  try {
    const cur = await pool.query(
      `SELECT * FROM insurance_providers WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    const nextName = name !== undefined ? String(name).trim() : row.name;
    if (!nextName) return res.status(400).json({ error: 'name is required' });
    const nextContact =
      contact_info !== undefined ? (contact_info != null ? String(contact_info) : null) : row.contact_info;

    const r = await pool.query(
      `UPDATE insurance_providers SET name = $1, contact_info = $2
       WHERE id = $3 AND company_id = $4
       RETURNING id, company_id, name, contact_info, created_at`,
      [nextName, nextContact, req.params.id, req.company.id]
    );
    return res.json({ insurance_provider: r.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update insurance provider' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM insurance_providers WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (e) {
    if (e.code === '23503') {
      return res.status(400).json({ error: 'Cannot delete provider while patient policies reference it' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete insurance provider' });
  }
});

export default router;
