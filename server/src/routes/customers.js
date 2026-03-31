import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';

const router = Router();
router.use(authRequired, companyContext);

router.get('/', async (req, res) => {
  try {
    const { include_inactive } = req.query;
    const includeInactive = include_inactive === 'true';
    const r = await query(
      `SELECT *
       FROM customers
       WHERE company_id = $1
         AND ($2::boolean = TRUE OR is_active = TRUE)
       ORDER BY name ASC`,
      [req.company.id, includeInactive]
    );
    return res.json({ customers: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list customers' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, phone, tax_id, payment_terms_days, credit_limit, notes } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const ins = await query(
      `INSERT INTO customers (
         company_id, name, email, phone, tax_id, payment_terms_days, credit_limit, notes
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.company.id,
        String(name).trim(),
        email ? String(email).trim() : null,
        phone ? String(phone).trim() : null,
        tax_id ? String(tax_id).trim() : null,
        Number(payment_terms_days || 0),
        Number(credit_limit || 0),
        notes ? String(notes) : null,
      ]
    );
    return res.status(201).json({ customer: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create customer' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const cur = await query(
      `SELECT * FROM customers WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    const b = req.body || {};
    const upd = await query(
      `UPDATE customers
       SET name = $1,
           email = $2,
           phone = $3,
           tax_id = $4,
           payment_terms_days = $5,
           credit_limit = $6,
           notes = $7,
           is_active = $8,
           updated_at = NOW()
       WHERE id = $9 AND company_id = $10
       RETURNING *`,
      [
        b.name !== undefined ? String(b.name).trim() : row.name,
        b.email !== undefined ? (b.email ? String(b.email).trim() : null) : row.email,
        b.phone !== undefined ? (b.phone ? String(b.phone).trim() : null) : row.phone,
        b.tax_id !== undefined ? (b.tax_id ? String(b.tax_id).trim() : null) : row.tax_id,
        b.payment_terms_days !== undefined ? Number(b.payment_terms_days) : row.payment_terms_days,
        b.credit_limit !== undefined ? Number(b.credit_limit) : row.credit_limit,
        b.notes !== undefined ? (b.notes ? String(b.notes) : null) : row.notes,
        b.is_active !== undefined ? Boolean(b.is_active) : row.is_active,
        req.params.id,
        req.company.id,
      ]
    );
    return res.json({ customer: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update customer' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const used = await query(
      `SELECT 1
       FROM invoices
       WHERE company_id = $1
         AND payer_type::text = 'customer'
         AND payer_id = $2
       LIMIT 1`,
      [req.company.id, Number(req.params.id)]
    );
    if (used.rows.length) {
      return res.status(400).json({
        error: 'Customer is linked to invoices; deactivate instead of deleting',
      });
    }
    const r = await query(
      `DELETE FROM customers WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete customer' });
  }
});

export default router;
