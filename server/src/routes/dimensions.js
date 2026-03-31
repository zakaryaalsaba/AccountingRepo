import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { dimensionsSchemaHint, dimensionsTablesExist } from '../utils/dimensionsSchema.js';

const router = Router();
router.use(authRequired, companyContext);

router.use(async (_req, res, next) => {
  if (!(await dimensionsTablesExist())) {
    return res.status(503).json({ error: 'Dimensions schema not installed.', hint: dimensionsSchemaHint() });
  }
  return next();
});

router.get('/', async (req, res) => {
  try {
    const { type, include_inactive } = req.query;
    const params = [req.company.id, include_inactive === 'true'];
    let sql = `SELECT *
               FROM dimensions
               WHERE company_id = $1
                 AND ($2::boolean = TRUE OR is_active = TRUE)`;
    if (type) {
      params.push(String(type));
      sql += ` AND type = $3::dimension_type`;
    }
    sql += ` ORDER BY type, code NULLS LAST, name`;
    const r = await query(sql, params);
    return res.json({ dimensions: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list dimensions' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { type, code, name, is_active = true } = req.body || {};
    if (!type || !name) return res.status(400).json({ error: 'type and name are required' });
    const ins = await query(
      `INSERT INTO dimensions (company_id, type, code, name, is_active)
       VALUES ($1,$2::dimension_type,$3,$4,$5)
       RETURNING *`,
      [req.company.id, String(type), code ? String(code).trim() : null, String(name).trim(), Boolean(is_active)]
    );
    return res.status(201).json({ dimension: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create dimension' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const cur = await query(`SELECT * FROM dimensions WHERE id = $1 AND company_id = $2`, [
      req.params.id,
      req.company.id,
    ]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = cur.rows[0];
    const b = req.body || {};
    const upd = await query(
      `UPDATE dimensions
       SET code = $1,
           name = $2,
           is_active = $3,
           updated_at = NOW()
       WHERE id = $4 AND company_id = $5
       RETURNING *`,
      [
        b.code !== undefined ? (b.code ? String(b.code).trim() : null) : row.code,
        b.name !== undefined ? String(b.name).trim() : row.name,
        b.is_active !== undefined ? Boolean(b.is_active) : row.is_active,
        req.params.id,
        req.company.id,
      ]
    );
    return res.json({ dimension: upd.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update dimension' });
  }
});

export default router;

