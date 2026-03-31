import { Router } from 'express';
import { query, pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { periodLocksTableExists } from '../utils/periodLocks.js';
import { attachAuthorization, requirePermission, requireRole } from '../middleware/authorization.js';

const router = Router();
router.use(authRequired, companyContext);
router.use(attachAuthorization);

function migrationHint() {
  return 'Run: psql $DATABASE_URL -f database/migrations/003_period_locks.sql';
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

router.get('/', async (req, res) => {
  try {
    if (!(await periodLocksTableExists())) {
      return res.status(503).json({
        error: 'Period locks schema not installed.',
        hint: migrationHint(),
      });
    }
    const r = await query(
      `SELECT id, company_id, period_start, period_end, is_closed, note,
              closed_by, closed_at, reopened_by, reopened_at, created_at, updated_at
       FROM accounting_period_locks
       WHERE company_id = $1
       ORDER BY period_start DESC, created_at DESC`,
      [req.company.id]
    );
    return res.json({ periods: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list periods' });
  }
});

router.post('/close', async (req, res) => {
  return requirePermission('periods.close')(req, res, async () => {
  try {
    if (!(await periodLocksTableExists())) {
      return res.status(503).json({
        error: 'Period locks schema not installed.',
        hint: migrationHint(),
      });
    }
    const { period_start, period_end, note } = req.body || {};
    if (!period_start || !period_end) {
      return res.status(400).json({ error: 'period_start and period_end are required' });
    }
    if (String(period_start) > String(period_end)) {
      return res.status(400).json({ error: 'period_start must be before or equal to period_end' });
    }

    const up = await query(
      `INSERT INTO accounting_period_locks (
         company_id, period_start, period_end, is_closed, note, closed_by, closed_at, reopened_by, reopened_at, updated_at
       )
       VALUES ($1, $2, $3, TRUE, $4, $5, NOW(), NULL, NULL, NOW())
       ON CONFLICT (company_id, period_start, period_end)
       DO UPDATE SET
         is_closed = TRUE,
         note = EXCLUDED.note,
         closed_by = EXCLUDED.closed_by,
         closed_at = NOW(),
         reopened_by = NULL,
         reopened_at = NULL,
         updated_at = NOW()
       RETURNING *`,
      [req.company.id, period_start, period_end, note || null, req.user.id]
    );
    return res.status(201).json({ period: up.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to close period' });
  }
  });
});

router.post('/reopen', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
  try {
    if (!(await periodLocksTableExists())) {
      return res.status(503).json({
        error: 'Period locks schema not installed.',
        hint: migrationHint(),
      });
    }
    const { period_start, period_end, note } = req.body || {};
    if (!period_start || !period_end) {
      return res.status(400).json({ error: 'period_start and period_end are required' });
    }
    const up = await query(
      `UPDATE accounting_period_locks
       SET is_closed = FALSE,
           note = COALESCE($4, note),
           reopened_by = $5,
           reopened_at = NOW(),
           updated_at = NOW()
       WHERE company_id = $1 AND period_start = $2 AND period_end = $3
       RETURNING *`,
      [req.company.id, period_start, period_end, note || null, req.user.id]
    );
    if (!up.rows.length) {
      return res.status(404).json({ error: 'Period lock not found' });
    }
    return res.json({ period: up.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to reopen period' });
  }
  });
});

/**
 * Year-end close:
 * - Debit each REVENUE account balance for the year
 * - Credit each EXPENSE account balance for the year
 * - Offset net to retained earnings equity account
 * - Close the full year period range
 */
router.post('/year-close', async (req, res) => {
  return requireRole(['owner', 'admin'])(req, res, async () => {
  try {
    if (!(await periodLocksTableExists())) {
      return res.status(503).json({
        error: 'Period locks schema not installed.',
        hint: migrationHint(),
      });
    }
    const { year, retained_earnings_account_id, note } = req.body || {};
    const y = Number(year);
    if (!Number.isInteger(y) || y < 2000 || y > 3000) {
      return res.status(400).json({ error: 'year must be a valid integer (e.g. 2026)' });
    }
    const from = `${y}-01-01`;
    const to = `${y}-12-31`;
    const ref = `YEC-${y}`;

    const existingClosed = await query(
      `SELECT id
       FROM accounting_period_locks
       WHERE company_id = $1
         AND is_closed = TRUE
         AND period_start = $2::date
         AND period_end = $3::date
       LIMIT 1`,
      [req.company.id, from, to]
    );
    if (existingClosed.rows.length) {
      return res.status(409).json({ error: `Year ${y} is already closed` });
    }

    const alreadyPosted = await query(
      `SELECT id FROM transactions WHERE company_id = $1 AND reference = $2 LIMIT 1`,
      [req.company.id, ref]
    );
    if (alreadyPosted.rows.length) {
      return res.status(409).json({
        error: `Year-end closing entry already exists for ${y} (${ref})`,
      });
    }

    const bal = await query(
      `SELECT a.id, a.type::text AS account_type,
              COALESCE(
                SUM(
                  CASE
                    WHEN a.type = 'REVENUE' THEN tl.credit - tl.debit
                    WHEN a.type = 'EXPENSE' THEN tl.debit - tl.credit
                    ELSE 0
                  END
                ),
                0
              )::numeric(18,2) AS balance
       FROM accounts a
       LEFT JOIN transaction_lines tl ON tl.account_id = a.id
       LEFT JOIN transactions t ON t.id = tl.transaction_id
         AND t.company_id = $1
         AND t.entry_date >= $2::date
         AND t.entry_date <= $3::date
       WHERE a.company_id = $1
         AND a.type IN ('REVENUE', 'EXPENSE')
         AND a.is_active = TRUE
         AND a.level = 5
       GROUP BY a.id, a.type`,
      [req.company.id, from, to]
    );

    const lines = [];
    let revenueTotal = 0;
    let expenseTotal = 0;
    for (const r of bal.rows) {
      const v = round2(r.balance);
      if (v <= 0) continue;
      if (r.account_type === 'REVENUE') {
        revenueTotal = round2(revenueTotal + v);
        lines.push({ account_id: r.id, debit: v, credit: 0 });
      } else if (r.account_type === 'EXPENSE') {
        expenseTotal = round2(expenseTotal + v);
        lines.push({ account_id: r.id, debit: 0, credit: v });
      }
    }
    const netIncome = round2(revenueTotal - expenseTotal);

    let retainedId = retained_earnings_account_id || null;
    if (netIncome !== 0) {
      if (!retainedId) {
        const eq = await query(
          `SELECT id
           FROM accounts
           WHERE company_id = $1 AND type = 'EQUITY' AND is_active = TRUE AND level = 5
           ORDER BY account_code ASC, code ASC
           LIMIT 1`,
          [req.company.id]
        );
        retainedId = eq.rows[0]?.id || null;
      }
      if (!retainedId) {
        return res.status(400).json({
          error: 'No retained earnings equity account found (active level 5)',
        });
      }
      if (netIncome > 0) lines.push({ account_id: retainedId, debit: 0, credit: netIncome });
      else lines.push({ account_id: retainedId, debit: Math.abs(netIncome), credit: 0 });
    }

    if (!lines.length) {
      const lockOnly = await query(
        `INSERT INTO accounting_period_locks (
           company_id, period_start, period_end, is_closed, note, closed_by, closed_at, updated_at
         )
         VALUES ($1, $2, $3, TRUE, $4, $5, NOW(), NOW())
         RETURNING *`,
        [req.company.id, from, to, note || `Year close ${y} (no P&L balances)`, req.user.id]
      );
      return res.status(201).json({
        period: lockOnly.rows[0],
        closing_entry: null,
        summary: { year: y, revenue_total: 0, expense_total: 0, net_income: 0 },
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = await client.query(
        `INSERT INTO transactions (company_id, entry_date, description, reference)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.company.id, to, `Year-end close ${y}`, ref]
      );
      const txId = tx.rows[0].id;
      for (const l of lines) {
        await client.query(
          `INSERT INTO transaction_lines (transaction_id, account_id, debit, credit)
           VALUES ($1, $2, $3, $4)`,
          [txId, l.account_id, l.debit, l.credit]
        );
      }
      const lock = await client.query(
        `INSERT INTO accounting_period_locks (
           company_id, period_start, period_end, is_closed, note, closed_by, closed_at, updated_at
         )
         VALUES ($1, $2, $3, TRUE, $4, $5, NOW(), NOW())
         RETURNING *`,
        [req.company.id, from, to, note || `Year close ${y}`, req.user.id]
      );
      await client.query('COMMIT');
      return res.status(201).json({
        period: lock.rows[0],
        closing_entry: tx.rows[0],
        summary: {
          year: y,
          revenue_total: revenueTotal,
          expense_total: expenseTotal,
          net_income: netIncome,
        },
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to run year-end close' });
  }
  });
});

export default router;
