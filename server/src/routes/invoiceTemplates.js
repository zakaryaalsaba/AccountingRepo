import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';

const router = Router();
router.use(authRequired, companyContext);

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM invoice_templates
       WHERE company_id = $1
       ORDER BY is_default DESC, name ASC`,
      [req.company.id]
    );
    return res.json({ templates: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list templates' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, is_default, layout } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (is_default) {
      await query(`UPDATE invoice_templates SET is_default = FALSE WHERE company_id = $1`, [
        req.company.id,
      ]);
    }
    const ins = await query(
      `INSERT INTO invoice_templates (company_id, name, is_default, layout)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING *`,
      [
        req.company.id,
        String(name).trim(),
        Boolean(is_default),
        JSON.stringify(layout || {}),
      ]
    );
    return res.status(201).json({ template: ins.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Template name already exists' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to create template' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const cur = await query(
      `SELECT * FROM invoice_templates WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.company.id]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    const b = req.body || {};
    if (b.is_default === true) {
      await query(`UPDATE invoice_templates SET is_default = FALSE WHERE company_id = $1`, [
        req.company.id,
      ]);
    }
    const upd = await query(
      `UPDATE invoice_templates
       SET name = $1,
           is_default = $2,
           layout = $3::jsonb
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [
        b.name !== undefined ? String(b.name).trim() : row.name,
        b.is_default !== undefined ? Boolean(b.is_default) : row.is_default,
        b.layout !== undefined ? JSON.stringify(b.layout || {}) : JSON.stringify(row.layout || {}),
        req.params.id,
        req.company.id,
      ]
    );
    return res.json({ template: upd.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Template name already exists' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const used = await query(
      `SELECT 1 FROM invoices
       WHERE company_id = $1 AND invoice_template_id = $2
       LIMIT 1`,
      [req.company.id, req.params.id]
    );
    if (used.rows.length) {
      return res.status(400).json({ error: 'Template is used by invoices' });
    }
    const r = await query(
      `DELETE FROM invoice_templates WHERE id = $1 AND company_id = $2 RETURNING id`,
      [req.params.id, req.company.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to delete template' });
  }
});

export default router;
