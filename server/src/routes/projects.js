import { Router } from 'express';
import { pool, query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { attachAuthorization, requirePermission } from '../middleware/authorization.js';
import { assertDateOpen } from '../utils/periodLocks.js';
import { projectSchemaHint, projectTablesExist } from '../utils/projectSchema.js';
import { isModuleEnabled } from '../utils/featureFlags.js';

const router = Router();
router.use(authRequired, companyContext, attachAuthorization);

router.use(async (_req, res, next) => {
  if (await projectTablesExist()) return next();
  return res.status(503).json({ error: 'Project schema not installed.', hint: projectSchemaHint() });
});

router.use(async (req, res, next) => {
  if (await isModuleEnabled(req.company.id, 'projects', true)) return next();
  return res.status(403).json({ error: 'Projects module is disabled for this company' });
});

router.get('/', async (req, res) => {
  try {
    const { status, include_inactive } = req.query;
    const params = [req.company.id, include_inactive === 'true'];
    let sql = `SELECT *
               FROM projects
               WHERE company_id = $1
                 AND ($2::boolean = TRUE OR is_active = TRUE)`;
    if (status) {
      params.push(String(status));
      sql += ` AND status = $3::project_status`;
    }
    sql += ` ORDER BY start_date DESC NULLS LAST, created_at DESC`;
    const r = await query(sql, params);
    return res.json({ projects: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list projects' });
  }
});

router.post('/', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    try {
      const {
        code,
        name,
        status = 'draft',
        customer_id = null,
        manager_name = null,
        start_date = null,
        end_date = null,
        budget_amount = 0,
        retention_percent = 0,
        wip_mode = 'none',
        is_active = true,
        notes = null,
      } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
      const ins = await query(
        `INSERT INTO projects (
           company_id, code, name, status, customer_id, manager_name, start_date, end_date,
           budget_amount, retention_percent, wip_mode, is_active, notes, created_by
         )
         VALUES ($1,$2,$3,$4::project_status,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          req.company.id,
          code ? String(code).trim() : null,
          String(name).trim(),
          String(status),
          customer_id || null,
          manager_name ? String(manager_name).trim() : null,
          start_date || null,
          end_date || null,
          Number(budget_amount || 0),
          Number(retention_percent || 0),
          String(wip_mode || 'none'),
          Boolean(is_active),
          notes ? String(notes) : null,
          req.user.id,
        ]
      );
      return res.status(201).json({ project: ins.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to create project' });
    }
  });
});

router.patch('/:id', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    try {
      const cur = await query(`SELECT * FROM projects WHERE id = $1 AND company_id = $2`, [req.params.id, req.company.id]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
      const row = cur.rows[0];
      const b = req.body || {};
      const up = await query(
        `UPDATE projects
         SET code = $1, name = $2, status = $3::project_status, customer_id = $4, manager_name = $5,
             start_date = $6, end_date = $7, budget_amount = $8, retention_percent = $9,
             wip_mode = $10, is_active = $11, notes = $12, updated_at = NOW()
         WHERE id = $13 AND company_id = $14
         RETURNING *`,
        [
          b.code !== undefined ? (b.code ? String(b.code).trim() : null) : row.code,
          b.name !== undefined ? String(b.name).trim() : row.name,
          b.status !== undefined ? String(b.status) : row.status,
          b.customer_id !== undefined ? b.customer_id || null : row.customer_id,
          b.manager_name !== undefined ? (b.manager_name ? String(b.manager_name).trim() : null) : row.manager_name,
          b.start_date !== undefined ? b.start_date || null : row.start_date,
          b.end_date !== undefined ? b.end_date || null : row.end_date,
          b.budget_amount !== undefined ? Number(b.budget_amount) : row.budget_amount,
          b.retention_percent !== undefined ? Number(b.retention_percent) : row.retention_percent,
          b.wip_mode !== undefined ? String(b.wip_mode) : row.wip_mode,
          b.is_active !== undefined ? Boolean(b.is_active) : row.is_active,
          b.notes !== undefined ? (b.notes ? String(b.notes) : null) : row.notes,
          req.params.id,
          req.company.id,
        ]
      );
      return res.json({ project: up.rows[0] });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to update project' });
    }
  });
});

router.post('/:id/wip', async (req, res) => {
  return requirePermission('transactions.create')(req, res, async () => {
    const { entry_date, amount, wip_type, wip_account_id, cost_account_id, reference, notes } = req.body || {};
    if (!entry_date || !amount || !wip_type || !wip_account_id || !cost_account_id) {
      return res.status(400).json({
        error: 'entry_date, amount, wip_type, wip_account_id, cost_account_id are required',
      });
    }
    const amt = Math.round(Number(amount) * 100) / 100;
    if (amt <= 0) return res.status(400).json({ error: 'amount must be positive' });
    const client = await pool.connect();
    try {
      await assertDateOpen(req.company.id, entry_date, client);
      await client.query('BEGIN');
      const p = await client.query(
        `SELECT id FROM projects WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
        [req.params.id, req.company.id]
      );
      if (!p.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Project not found' });
      }
      const tx = await client.query(
        `INSERT INTO transactions (company_id, entry_date, description, reference, status, posted_by, posted_at, project_id)
         VALUES ($1,$2,$3,$4,'posted',$5,NOW(),$6)
         RETURNING *`,
        [
          req.company.id,
          entry_date,
          `Project WIP ${wip_type}`,
          reference || null,
          req.user.id,
          req.params.id,
        ]
      );
      if (wip_type === 'capitalize') {
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
           VALUES ($1,$2,$3,0),($1,$4,0,$3)`,
          [tx.rows[0].id, wip_account_id, amt, cost_account_id]
        );
      } else if (wip_type === 'release') {
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
           VALUES ($1,$2,0,$3),($1,$4,$3,0)`,
          [tx.rows[0].id, wip_account_id, amt, cost_account_id]
        );
      } else {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'wip_type must be capitalize or release' });
      }
      const w = await client.query(
        `INSERT INTO project_wip_entries (
           company_id, project_id, entry_date, amount, wip_type, reference, notes, transaction_id, created_by
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [req.company.id, req.params.id, entry_date, amt, wip_type, reference || null, notes || null, tx.rows[0].id, req.user.id]
      );
      await client.query('COMMIT');
      return res.status(201).json({ wip_entry: w.rows[0], transaction: tx.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
      return res.status(500).json({ error: 'Failed to post project WIP entry' });
    } finally {
      client.release();
    }
  });
});

export default router;
