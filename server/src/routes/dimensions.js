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

router.get('/branches/list', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, code, name, is_active, created_at, updated_at
       FROM branches
       WHERE company_id = $1
       ORDER BY code NULLS LAST, name`,
      [req.company.id]
    );
    return res.json({ branches: r.rows });
  } catch (e) {
    if (String(e.code) === '42P01') {
      return res.status(503).json({
        error: 'Branch schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to list branches' });
  }
});

router.post('/branches', async (req, res) => {
  try {
    const { code, name, is_active = true } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const ins = await query(
      `INSERT INTO branches (company_id, code, name, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [req.company.id, code ? String(code).trim() : null, String(name).trim(), Boolean(is_active), req.user.id]
    );
    return res.status(201).json({ branch: ins.rows[0] });
  } catch (e) {
    if (String(e.code) === '42P01') {
      return res.status(503).json({
        error: 'Branch schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to create branch' });
  }
});

router.patch('/branches/:id', async (req, res) => {
  try {
    const cur = await query(`SELECT * FROM branches WHERE id = $1 AND company_id = $2`, [req.params.id, req.company.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const row = cur.rows[0];
    const up = await query(
      `UPDATE branches
       SET code = $1, name = $2, is_active = $3, updated_at = NOW()
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
    return res.json({ branch: up.rows[0] });
  } catch (e) {
    if (String(e.code) === '42P01') {
      return res.status(503).json({
        error: 'Branch schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to update branch' });
  }
});

router.get('/service-cards/list', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, code, name, is_active, created_at, updated_at
       FROM service_cards
       WHERE company_id = $1
       ORDER BY code NULLS LAST, name`,
      [req.company.id]
    );
    return res.json({ service_cards: r.rows });
  } catch (e) {
    if (String(e.code) === '42P01') {
      return res.status(503).json({
        error: 'Service card schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to list service cards' });
  }
});

router.post('/service-cards', async (req, res) => {
  try {
    const { code, name, is_active = true } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const ins = await query(
      `INSERT INTO service_cards (company_id, code, name, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [req.company.id, code ? String(code).trim() : null, String(name).trim(), Boolean(is_active), req.user.id]
    );
    return res.status(201).json({ service_card: ins.rows[0] });
  } catch (e) {
    if (String(e.code) === '42P01') {
      return res.status(503).json({
        error: 'Service card schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to create service card' });
  }
});

router.patch('/service-cards/:id', async (req, res) => {
  try {
    const cur = await query(`SELECT * FROM service_cards WHERE id = $1 AND company_id = $2`, [req.params.id, req.company.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const row = cur.rows[0];
    const up = await query(
      `UPDATE service_cards
       SET code = $1, name = $2, is_active = $3, updated_at = NOW()
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
    return res.json({ service_card: up.rows[0] });
  } catch (e) {
    if (String(e.code) === '42P01') {
      return res.status(503).json({
        error: 'Service card schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to update service card' });
  }
});

router.get('/account-class-policies', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, account_type::text AS account_type, mode, required_types, updated_at
       FROM account_class_dimension_policies
       WHERE company_id = $1
       ORDER BY account_type`,
      [req.company.id]
    );
    return res.json({ policies: r.rows });
  } catch (e) {
    if (String(e.code) === '42P01') {
      return res.status(503).json({
        error: 'Account class policy schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to list account class policies' });
  }
});

router.post('/account-class-policies/upsert', async (req, res) => {
  try {
    const { account_type, mode = 'optional', required_types = [] } = req.body || {};
    if (!account_type) return res.status(400).json({ error: 'account_type is required' });
    const normalizedMode = String(mode);
    if (!['optional', 'required_any', 'required_types'].includes(normalizedMode)) {
      return res.status(400).json({ error: 'mode must be optional|required_any|required_types' });
    }
    const up = await query(
      `INSERT INTO account_class_dimension_policies (company_id, account_type, mode, required_types, created_by)
       VALUES ($1,$2::account_type,$3,$4::jsonb,$5)
       ON CONFLICT (company_id, account_type)
       DO UPDATE SET mode = EXCLUDED.mode, required_types = EXCLUDED.required_types, updated_at = NOW()
       RETURNING id, account_type::text AS account_type, mode, required_types, updated_at`,
      [req.company.id, String(account_type).toUpperCase(), normalizedMode, JSON.stringify(required_types || []), req.user.id]
    );
    return res.status(201).json({ policy: up.rows[0] });
  } catch (e) {
    if (String(e.code) === '42P01') {
      return res.status(503).json({
        error: 'Account class policy schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to upsert account class policy' });
  }
});

export default router;

