import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { invoicesHavePayerColumns } from '../utils/invoiceSchema.js';

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

export default router;
