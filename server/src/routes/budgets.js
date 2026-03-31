import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { budgetSchemaHint, budgetTablesExist } from '../utils/budgetSchema.js';

const router = Router();
router.use(authRequired, companyContext);

router.use(async (_req, res, next) => {
  if (!(await budgetTablesExist())) {
    return res.status(503).json({ error: 'Budget schema not installed.', hint: budgetSchemaHint() });
  }
  return next();
});

router.get('/', async (req, res) => {
  try {
    const { fiscal_year } = req.query;
    const params = [req.company.id];
    let sql = `SELECT * FROM budgets WHERE company_id = $1`;
    if (fiscal_year) {
      params.push(Number(fiscal_year));
      sql += ` AND fiscal_year = $2`;
    }
    sql += ` ORDER BY fiscal_year DESC, created_at DESC`;
    const r = await query(sql, params);
    return res.json({ budgets: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list budgets' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, fiscal_year, is_active = true } = req.body || {};
    if (!name || !fiscal_year) return res.status(400).json({ error: 'name and fiscal_year are required' });
    const ins = await query(
      `INSERT INTO budgets (company_id, name, fiscal_year, is_active)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [req.company.id, String(name).trim(), Number(fiscal_year), Boolean(is_active)]
    );
    return res.status(201).json({ budget: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create budget' });
  }
});

router.get('/:id/lines', async (req, res) => {
  try {
    const b = await query(`SELECT id FROM budgets WHERE id = $1 AND company_id = $2`, [
      req.params.id,
      req.company.id,
    ]);
    if (!b.rows.length) return res.status(404).json({ error: 'Budget not found' });
    const lines = await query(
      `SELECT bl.*, a.code AS account_code, a.name AS account_name, a.type::text AS account_type
       FROM budget_lines bl
       JOIN accounts a ON a.id = bl.account_id
       WHERE bl.company_id = $1 AND bl.budget_id = $2
       ORDER BY bl.month ASC, a.code ASC`,
      [req.company.id, req.params.id]
    );
    return res.json({ lines: lines.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list budget lines' });
  }
});

router.put('/:id/lines', async (req, res) => {
  try {
    const { lines = [] } = req.body || {};
    if (!Array.isArray(lines)) return res.status(400).json({ error: 'lines must be array' });
    const b = await query(`SELECT id FROM budgets WHERE id = $1 AND company_id = $2`, [
      req.params.id,
      req.company.id,
    ]);
    if (!b.rows.length) return res.status(404).json({ error: 'Budget not found' });

    await query(`DELETE FROM budget_lines WHERE company_id = $1 AND budget_id = $2`, [
      req.company.id,
      req.params.id,
    ]);
    for (const line of lines) {
      if (!line.account_id || !line.month || line.amount === undefined) {
        return res.status(400).json({ error: 'Each line needs account_id, month, amount' });
      }
      await query(
        `INSERT INTO budget_lines (company_id, budget_id, account_id, month, amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.company.id, req.params.id, line.account_id, Number(line.month), Number(line.amount)]
      );
    }
    const out = await query(
      `SELECT * FROM budget_lines WHERE company_id = $1 AND budget_id = $2 ORDER BY month ASC`,
      [req.company.id, req.params.id]
    );
    return res.json({ lines: out.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to save budget lines' });
  }
});

export default router;

