import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { apSchemaHint, apTablesExist } from '../utils/apSchema.js';

const router = Router();
router.use(authRequired, companyContext);

router.use(async (_req, res, next) => {
  if (!(await apTablesExist())) {
    return res.status(503).json({ error: 'AP schema not installed.', hint: apSchemaHint() });
  }
  return next();
});

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT *
       FROM vendors
       WHERE company_id = $1
       ORDER BY name ASC`,
      [req.company.id]
    );
    return res.json({ vendors: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list vendors' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, phone, tax_id, payment_terms_days, notes } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const ins = await query(
      `INSERT INTO vendors (company_id, name, email, phone, tax_id, payment_terms_days, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.company.id,
        String(name).trim(),
        email ? String(email).trim() : null,
        phone ? String(phone).trim() : null,
        tax_id ? String(tax_id).trim() : null,
        Number(payment_terms_days || 0),
        notes ? String(notes) : null,
      ]
    );
    return res.status(201).json({ vendor: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create vendor' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const cur = await query(`SELECT * FROM vendors WHERE id = $1 AND company_id = $2`, [
      req.params.id,
      req.company.id,
    ]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    const b = req.body || {};
    const upd = await query(
      `UPDATE vendors
       SET name = $1,
           email = $2,
           phone = $3,
           tax_id = $4,
           payment_terms_days = $5,
           notes = $6,
           is_active = $7,
           updated_at = NOW()
       WHERE id = $8 AND company_id = $9
       RETURNING *`,
      [
        b.name !== undefined ? String(b.name).trim() : row.name,
        b.email !== undefined ? (b.email ? String(b.email).trim() : null) : row.email,
        b.phone !== undefined ? (b.phone ? String(b.phone).trim() : null) : row.phone,
        b.tax_id !== undefined ? (b.tax_id ? String(b.tax_id).trim() : null) : row.tax_id,
        b.payment_terms_days !== undefined ? Number(b.payment_terms_days) : row.payment_terms_days,
        b.notes !== undefined ? (b.notes ? String(b.notes) : null) : row.notes,
        b.is_active !== undefined ? Boolean(b.is_active) : row.is_active,
        req.params.id,
        req.company.id,
      ]
    );
    return res.json({ vendor: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update vendor' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const used = await query(
      `SELECT 1 FROM bills WHERE company_id = $1 AND vendor_id = $2 LIMIT 1`,
      [req.company.id, req.params.id]
    );
    if (used.rows.length) {
      return res.status(400).json({ error: 'Vendor is linked to bills; deactivate instead' });
    }
    const r = await query(`DELETE FROM vendors WHERE id = $1 AND company_id = $2 RETURNING id`, [
      req.params.id,
      req.company.id,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete vendor' });
  }
});

export default router;

