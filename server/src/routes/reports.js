import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { invoicesHavePayerColumns } from '../utils/invoiceSchema.js';
import { apTablesExist } from '../utils/apSchema.js';

const router = Router();
router.use(authRequired, companyContext);

function rnd(x) {
  return Math.round(Number(x) * 100) / 100;
}

/**
 * Owner-focused KPIs: month-to-date from posted journals + unpaid invoices.
 * Month boundaries use the database session timezone (typically UTC on servers; adjust TZ if needed).
 */
router.get('/dashboard', async (req, res) => {
  try {
    const bounds = await query(
      `SELECT (date_trunc('month', CURRENT_DATE))::date AS month_start,
              CURRENT_DATE AS month_end`
    );
    const { month_start, month_end } = bounds.rows[0];
    const from = String(month_start).split('T')[0];
    const to = String(month_end).split('T')[0];

    const rev = await query(
      `SELECT COALESCE(SUM(tl.credit - tl.debit), 0)::numeric(18,2) AS v
       FROM transaction_lines tl
       INNER JOIN transactions t ON t.id = tl.transaction_id AND t.company_id = $1
       INNER JOIN accounts a ON a.id = tl.account_id AND a.company_id = $1
       WHERE a.type = 'REVENUE'
         AND t.entry_date >= $2::date AND t.entry_date <= $3::date`,
      [req.company.id, from, to]
    );
    const exp = await query(
      `SELECT COALESCE(SUM(tl.debit - tl.credit), 0)::numeric(18,2) AS v
       FROM transaction_lines tl
       INNER JOIN transactions t ON t.id = tl.transaction_id AND t.company_id = $1
       INNER JOIN accounts a ON a.id = tl.account_id AND a.company_id = $1
       WHERE a.type = 'EXPENSE'
         AND t.entry_date >= $2::date AND t.entry_date <= $3::date`,
      [req.company.id, from, to]
    );

    const revenue_month = rnd(rev.rows[0].v);
    const expenses_month = rnd(exp.rows[0].v);
    const net_profit_month = rnd(revenue_month - expenses_month);

    const payer = await invoicesHavePayerColumns();
    const inv = payer
      ? await query(
          `SELECT COUNT(*)::int AS cnt,
                  COALESCE(SUM(GREATEST(total_amount - paid_amount, 0)), 0)::numeric(18,2) AS total
           FROM invoices
           WHERE company_id = $1
             AND status <> 'draft'::invoice_status
             AND (total_amount - paid_amount) > 0`,
          [req.company.id]
        )
      : await query(
          `SELECT COUNT(*)::int AS cnt,
                  COALESCE(SUM(amount), 0)::numeric(18,2) AS total
           FROM invoices
           WHERE company_id = $1 AND status = 'unpaid'`,
          [req.company.id]
        );

    return res.json({
      period: { from, to },
      revenue_month,
      expenses_month,
      net_profit_month,
      unpaid_invoices_count: inv.rows[0].cnt,
      unpaid_invoices_total: rnd(inv.rows[0].total),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load dashboard metrics' });
  }
});

/**
 * Profit & Loss: revenue (credit - debit) minus expenses (debit - credit) for date range.
 * Uses journal lines only (posted entries).
 */
router.get('/profit-loss', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'Query params from and to (YYYY-MM-DD) required' });
    }
    const r = await query(
      `SELECT a.type::text AS account_type,
              a.code,
              a.name,
              CASE a.type
                WHEN 'REVENUE' THEN COALESCE(SUM(tl.credit - tl.debit), 0)
                WHEN 'EXPENSE' THEN COALESCE(SUM(tl.debit - tl.credit), 0)
              END::numeric(18,2) AS net
       FROM accounts a
       LEFT JOIN transaction_lines tl ON tl.account_id = a.id
       LEFT JOIN transactions t ON t.id = tl.transaction_id
         AND t.company_id = $1
         AND t.entry_date >= $2::date AND t.entry_date <= $3::date
       WHERE a.company_id = $1 AND a.type IN ('REVENUE', 'EXPENSE')
       GROUP BY a.id, a.type, a.code, a.name
       ORDER BY a.type, a.code`,
      [req.company.id, from, to]
    );
    let revenue = 0;
    let expense = 0;
    for (const row of r.rows) {
      const v = Number(row.net);
      if (row.account_type === 'REVENUE') revenue += v;
      else if (row.account_type === 'EXPENSE') expense += v;
    }
    const net_income = revenue - expense;
    return res.json({
      from,
      to,
      revenue_total: rnd(revenue),
      expense_total: rnd(expense),
      net_income: rnd(net_income),
      lines: r.rows,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build P&L' });
  }
});

/**
 * Simple balance sheet: balances by account type as of `as_of` date (inclusive).
 */
router.get('/balance-sheet', async (req, res) => {
  try {
    const { as_of } = req.query;
    if (!as_of) {
      return res.status(400).json({ error: 'Query param as_of (YYYY-MM-DD) required' });
    }
    const r = await query(
      `SELECT a.type::text AS account_type,
              a.code,
              a.name,
              CASE a.type
                WHEN 'ASSET' THEN COALESCE(SUM(tl.debit - tl.credit), 0)
                WHEN 'LIABILITY' THEN COALESCE(SUM(tl.credit - tl.debit), 0)
                WHEN 'EQUITY' THEN COALESCE(SUM(tl.credit - tl.debit), 0)
                ELSE 0
              END::numeric(18,2) AS balance
       FROM accounts a
       LEFT JOIN transaction_lines tl ON tl.account_id = a.id
       LEFT JOIN transactions t ON t.id = tl.transaction_id
         AND t.company_id = $1
         AND t.entry_date <= $2::date
       WHERE a.company_id = $1 AND a.type IN ('ASSET', 'LIABILITY', 'EQUITY')
       GROUP BY a.id, a.type, a.code, a.name
       ORDER BY a.type, a.code`,
      [req.company.id, as_of]
    );
    let assets = 0;
    let liabilities = 0;
    let equity = 0;
    for (const row of r.rows) {
      const b = Number(row.balance);
      if (row.account_type === 'ASSET') assets += b;
      if (row.account_type === 'LIABILITY') liabilities += b;
      if (row.account_type === 'EQUITY') equity += b;
    }
    const rounded = (x) => Math.round(x * 100) / 100;
    return res.json({
      as_of,
      assets: rounded(assets),
      liabilities: rounded(liabilities),
      equity: rounded(equity),
      assets_liabilities_plus_equity_check: rounded(assets - (liabilities + equity)),
      lines: r.rows,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build balance sheet' });
  }
});

/**
 * AR aging by invoice date buckets as of a date.
 * Buckets: current (0-30), 31-60, 61-90, 90+ days.
 */
router.get('/ar-aging', async (req, res) => {
  try {
    const { as_of } = req.query;
    if (!as_of) {
      return res.status(400).json({ error: 'Query param as_of (YYYY-MM-DD) required' });
    }

    const payer = await invoicesHavePayerColumns();
    const remainingExpr = payer
      ? 'GREATEST(COALESCE(i.total_amount, i.amount) - COALESCE(i.paid_amount, 0), 0)'
      : "CASE WHEN i.status = 'paid'::invoice_status THEN 0 ELSE COALESCE(i.amount, 0) END";

    const sql = `
      SELECT i.id,
             i.customer_name,
             i.invoice_date,
             ${remainingExpr}::numeric(18,2) AS remaining,
             GREATEST(($2::date - i.invoice_date), 0)::int AS age_days
      FROM invoices i
      WHERE i.company_id = $1
        AND i.invoice_date <= $2::date
        AND ${remainingExpr} > 0
      ORDER BY i.invoice_date ASC`;
    const r = await query(sql, [req.company.id, as_of]);

    let current = 0;
    let b31_60 = 0;
    let b61_90 = 0;
    let b90p = 0;
    for (const row of r.rows) {
      const v = Number(row.remaining);
      const d = Number(row.age_days);
      if (d <= 30) current += v;
      else if (d <= 60) b31_60 += v;
      else if (d <= 90) b61_90 += v;
      else b90p += v;
    }
    const round = (x) => Math.round(x * 100) / 100;
    return res.json({
      as_of,
      totals: {
        current_0_30: round(current),
        days_31_60: round(b31_60),
        days_61_90: round(b61_90),
        days_90_plus: round(b90p),
        total_outstanding: round(current + b31_60 + b61_90 + b90p),
      },
      invoices: r.rows.map((x) => ({
        ...x,
        remaining: round(Number(x.remaining)),
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build AR aging' });
  }
});

/**
 * Trial balance as of date.
 * Returns debit/credit columns and a balance check.
 */
router.get('/trial-balance', async (req, res) => {
  try {
    const { as_of } = req.query;
    if (!as_of) {
      return res.status(400).json({ error: 'Query param as_of (YYYY-MM-DD) required' });
    }
    const r = await query(
      `SELECT a.id, a.code, a.name, a.type::text AS account_type,
              COALESCE(SUM(tl.debit), 0)::numeric(18,2) AS debit_total,
              COALESCE(SUM(tl.credit), 0)::numeric(18,2) AS credit_total,
              CASE
                WHEN a.type IN ('ASSET', 'EXPENSE')
                  THEN COALESCE(SUM(tl.debit - tl.credit), 0)
                ELSE COALESCE(SUM(tl.credit - tl.debit), 0)
              END::numeric(18,2) AS normal_balance
       FROM accounts a
       LEFT JOIN transaction_lines tl ON tl.account_id = a.id
       LEFT JOIN transactions t ON t.id = tl.transaction_id
         AND t.company_id = $1
         AND t.entry_date <= $2::date
       WHERE a.company_id = $1
       GROUP BY a.id, a.code, a.name, a.type
       ORDER BY a.code`,
      [req.company.id, as_of]
    );

    let debit = 0;
    let credit = 0;
    for (const row of r.rows) {
      debit += Number(row.debit_total);
      credit += Number(row.credit_total);
    }
    return res.json({
      as_of,
      totals: {
        debit_total: rnd(debit),
        credit_total: rnd(credit),
        difference: rnd(debit - credit),
      },
      lines: r.rows.map((row) => ({
        ...row,
        debit_total: rnd(row.debit_total),
        credit_total: rnd(row.credit_total),
        normal_balance: rnd(row.normal_balance),
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build trial balance' });
  }
});

/**
 * Account ledger with running balance for one account and date range.
 * Optional query: from, to (YYYY-MM-DD)
 */
router.get('/account-ledger/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { from, to } = req.query;
    const acc = await query(
      `SELECT id, code, name, type::text AS account_type
       FROM accounts
       WHERE id = $1 AND company_id = $2`,
      [accountId, req.company.id]
    );
    if (!acc.rows.length) return res.status(404).json({ error: 'Account not found' });
    const account = acc.rows[0];

    const opening = await query(
      `SELECT COALESCE(SUM(tl.debit), 0)::numeric(18,2) AS debit_sum,
              COALESCE(SUM(tl.credit), 0)::numeric(18,2) AS credit_sum
       FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       WHERE tl.account_id = $1
         AND t.company_id = $2
         AND ($3::date IS NULL OR t.entry_date < $3::date)`,
      [accountId, req.company.id, from || null]
    );
    let running =
      account.account_type === 'ASSET' || account.account_type === 'EXPENSE'
        ? Number(opening.rows[0].debit_sum) - Number(opening.rows[0].credit_sum)
        : Number(opening.rows[0].credit_sum) - Number(opening.rows[0].debit_sum);

    let sql = `SELECT t.id AS transaction_id,
                      t.entry_date,
                      t.description,
                      t.reference,
                      tl.debit::numeric(18,2) AS debit,
                      tl.credit::numeric(18,2) AS credit
               FROM transaction_lines tl
               JOIN transactions t ON t.id = tl.transaction_id
               WHERE tl.account_id = $1 AND t.company_id = $2`;
    const params = [accountId, req.company.id];
    let i = 3;
    if (from) {
      sql += ` AND t.entry_date >= $${i++}`;
      params.push(from);
    }
    if (to) {
      sql += ` AND t.entry_date <= $${i++}`;
      params.push(to);
    }
    sql += ` ORDER BY t.entry_date ASC, t.created_at ASC, tl.id ASC`;

    const rows = await query(sql, params);
    const entries = rows.rows.map((r) => {
      const d = Number(r.debit);
      const c = Number(r.credit);
      if (account.account_type === 'ASSET' || account.account_type === 'EXPENSE') {
        running = running + d - c;
      } else {
        running = running + c - d;
      }
      return {
        ...r,
        debit: rnd(d),
        credit: rnd(c),
        running_balance: rnd(running),
      };
    });

    return res.json({
      account,
      range: { from: from || null, to: to || null },
      opening_balance: rnd(
        account.account_type === 'ASSET' || account.account_type === 'EXPENSE'
          ? Number(opening.rows[0].debit_sum) - Number(opening.rows[0].credit_sum)
          : Number(opening.rows[0].credit_sum) - Number(opening.rows[0].debit_sum)
      ),
      closing_balance: rnd(running),
      entries,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build account ledger' });
  }
});

/**
 * Comparative P&L between two date ranges.
 */
router.get('/profit-loss-compare', async (req, res) => {
  try {
    const { from_a, to_a, from_b, to_b } = req.query;
    if (!from_a || !to_a || !from_b || !to_b) {
      return res.status(400).json({
        error: 'Query params from_a, to_a, from_b, to_b are required',
      });
    }
    const calc = async (from, to) => {
      const r = await query(
        `SELECT a.type::text AS account_type,
                CASE a.type
                  WHEN 'REVENUE' THEN COALESCE(SUM(tl.credit - tl.debit), 0)
                  WHEN 'EXPENSE' THEN COALESCE(SUM(tl.debit - tl.credit), 0)
                END::numeric(18,2) AS net
         FROM accounts a
         LEFT JOIN transaction_lines tl ON tl.account_id = a.id
         LEFT JOIN transactions t ON t.id = tl.transaction_id
           AND t.company_id = $1
           AND t.entry_date >= $2::date AND t.entry_date <= $3::date
         WHERE a.company_id = $1 AND a.type IN ('REVENUE', 'EXPENSE')
         GROUP BY a.id, a.type`,
        [req.company.id, from, to]
      );
      let revenue = 0;
      let expense = 0;
      for (const row of r.rows) {
        const v = Number(row.net);
        if (row.account_type === 'REVENUE') revenue += v;
        if (row.account_type === 'EXPENSE') expense += v;
      }
      return {
        from,
        to,
        revenue_total: rnd(revenue),
        expense_total: rnd(expense),
        net_income: rnd(revenue - expense),
      };
    };

    const a = await calc(from_a, to_a);
    const b = await calc(from_b, to_b);
    return res.json({
      period_a: a,
      period_b: b,
      delta: {
        revenue_total: rnd(a.revenue_total - b.revenue_total),
        expense_total: rnd(a.expense_total - b.expense_total),
        net_income: rnd(a.net_income - b.net_income),
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build comparative P&L' });
  }
});

/**
 * Comparative balance sheet totals as of two dates.
 */
router.get('/balance-sheet-compare', async (req, res) => {
  try {
    const { as_of_a, as_of_b } = req.query;
    if (!as_of_a || !as_of_b) {
      return res.status(400).json({ error: 'Query params as_of_a and as_of_b are required' });
    }

    const calc = async (asOf) => {
      const r = await query(
        `SELECT a.type::text AS account_type,
                CASE a.type
                  WHEN 'ASSET' THEN COALESCE(SUM(tl.debit - tl.credit), 0)
                  WHEN 'LIABILITY' THEN COALESCE(SUM(tl.credit - tl.debit), 0)
                  WHEN 'EQUITY' THEN COALESCE(SUM(tl.credit - tl.debit), 0)
                  ELSE 0
                END::numeric(18,2) AS balance
         FROM accounts a
         LEFT JOIN transaction_lines tl ON tl.account_id = a.id
         LEFT JOIN transactions t ON t.id = tl.transaction_id
           AND t.company_id = $1
           AND t.entry_date <= $2::date
         WHERE a.company_id = $1 AND a.type IN ('ASSET', 'LIABILITY', 'EQUITY')
         GROUP BY a.id, a.type`,
        [req.company.id, asOf]
      );
      let assets = 0;
      let liabilities = 0;
      let equity = 0;
      for (const row of r.rows) {
        const v = Number(row.balance);
        if (row.account_type === 'ASSET') assets += v;
        if (row.account_type === 'LIABILITY') liabilities += v;
        if (row.account_type === 'EQUITY') equity += v;
      }
      return {
        as_of: asOf,
        assets: rnd(assets),
        liabilities: rnd(liabilities),
        equity: rnd(equity),
      };
    };

    const a = await calc(as_of_a);
    const b = await calc(as_of_b);
    return res.json({
      period_a: a,
      period_b: b,
      delta: {
        assets: rnd(a.assets - b.assets),
        liabilities: rnd(a.liabilities - b.liabilities),
        equity: rnd(a.equity - b.equity),
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build comparative balance sheet' });
  }
});

/**
 * Simple direct cash flow statement.
 * Classifies each cash movement by counterparty account type:
 * - Operating: REVENUE/EXPENSE
 * - Investing: ASSET (non-cash)
 * - Financing: LIABILITY/EQUITY
 *
 * Cash accounts default to code/account_code '1000' (cash/bank seed).
 */
router.get('/cash-flow', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'Query params from and to (YYYY-MM-DD) required' });
    }

    const q = await query(
      `WITH cash_accounts AS (
         SELECT id
         FROM accounts
         WHERE company_id = $1
           AND (code = '1000' OR account_code = '1000')
           AND is_active = TRUE
       ),
       tx_cash AS (
         SELECT tl.transaction_id,
                SUM(tl.debit - tl.credit)::numeric(18,2) AS cash_change
         FROM transaction_lines tl
         JOIN cash_accounts ca ON ca.id = tl.account_id
         GROUP BY tl.transaction_id
       ),
       tx_class AS (
         SELECT t.id AS transaction_id,
                t.entry_date,
                t.description,
                tx.cash_change,
                COALESCE(SUM(CASE WHEN a.type = 'REVENUE' THEN ABS(tl.debit) + ABS(tl.credit) ELSE 0 END), 0) AS revenue_score,
                COALESCE(SUM(CASE WHEN a.type = 'EXPENSE' THEN ABS(tl.debit) + ABS(tl.credit) ELSE 0 END), 0) AS expense_score,
                COALESCE(SUM(CASE WHEN a.type = 'ASSET' THEN ABS(tl.debit) + ABS(tl.credit) ELSE 0 END), 0) AS asset_score,
                COALESCE(SUM(CASE WHEN a.type = 'LIABILITY' THEN ABS(tl.debit) + ABS(tl.credit) ELSE 0 END), 0) AS liability_score,
                COALESCE(SUM(CASE WHEN a.type = 'EQUITY' THEN ABS(tl.debit) + ABS(tl.credit) ELSE 0 END), 0) AS equity_score
         FROM transactions t
         JOIN tx_cash tx ON tx.transaction_id = t.id
         JOIN transaction_lines tl ON tl.transaction_id = t.id
         JOIN accounts a ON a.id = tl.account_id AND a.company_id = $1
         WHERE t.company_id = $1
           AND t.entry_date >= $2::date
           AND t.entry_date <= $3::date
         GROUP BY t.id, t.entry_date, t.description, tx.cash_change
       )
       SELECT *,
              CASE
                WHEN (revenue_score + expense_score) >= GREATEST(asset_score, liability_score + equity_score) THEN 'operating'
                WHEN asset_score >= (liability_score + equity_score) THEN 'investing'
                ELSE 'financing'
              END AS flow_section
       FROM tx_class
       WHERE cash_change <> 0
       ORDER BY entry_date ASC, transaction_id ASC`,
      [req.company.id, from, to]
    );

    let operating = 0;
    let investing = 0;
    let financing = 0;
    const lines = q.rows.map((r) => {
      const change = rnd(r.cash_change);
      if (r.flow_section === 'operating') operating += change;
      else if (r.flow_section === 'investing') investing += change;
      else financing += change;
      return {
        transaction_id: r.transaction_id,
        entry_date: r.entry_date,
        description: r.description,
        section: r.flow_section,
        cash_change: change,
      };
    });

    return res.json({
      from,
      to,
      operating_cash_flow: rnd(operating),
      investing_cash_flow: rnd(investing),
      financing_cash_flow: rnd(financing),
      net_cash_flow: rnd(operating + investing + financing),
      lines,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build cash flow statement' });
  }
});

router.get('/ap-aging', async (req, res) => {
  try {
    if (!(await apTablesExist())) {
      return res.status(503).json({
        error: 'AP schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/009_ap_vendors_bills.sql',
      });
    }
    const { as_of } = req.query;
    if (!as_of) return res.status(400).json({ error: 'Query param as_of (YYYY-MM-DD) required' });
    const r = await query(
      `SELECT b.id AS bill_id,
              b.bill_number,
              b.bill_date,
              b.due_date,
              v.name AS vendor_name,
              GREATEST(b.total_amount - b.paid_amount, 0)::numeric(18,2) AS outstanding,
              GREATEST(($2::date - b.due_date), 0) AS days_past_due
       FROM bills b
       JOIN vendors v ON v.id = b.vendor_id
       WHERE b.company_id = $1
         AND b.status <> 'draft'::bill_status
         AND (b.total_amount - b.paid_amount) > 0
         AND b.bill_date <= $2::date
       ORDER BY b.due_date ASC, b.bill_date ASC`,
      [req.company.id, as_of]
    );
    const buckets = { current: 0, '31_60': 0, '61_90': 0, '90_plus': 0, total: 0 };
    const lines = r.rows.map((row) => {
      const outstanding = rnd(row.outstanding);
      const d = Number(row.days_past_due || 0);
      let bucket = 'current';
      if (d > 90) bucket = '90_plus';
      else if (d > 60) bucket = '61_90';
      else if (d > 30) bucket = '31_60';
      buckets[bucket] += outstanding;
      buckets.total += outstanding;
      return { ...row, outstanding, days_past_due: d, bucket };
    });
    return res.json({
      as_of,
      buckets: {
        current: rnd(buckets.current),
        '31_60': rnd(buckets['31_60']),
        '61_90': rnd(buckets['61_90']),
        '90_plus': rnd(buckets['90_plus']),
        total: rnd(buckets.total),
      },
      lines,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build AP aging report' });
  }
});

export default router;
