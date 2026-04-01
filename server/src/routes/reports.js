import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';
import { invoicesHavePayerColumns } from '../utils/invoiceSchema.js';
import { apTablesExist } from '../utils/apSchema.js';
import { budgetTablesExist } from '../utils/budgetSchema.js';
import { dimensionsTablesExist } from '../utils/dimensionsSchema.js';
import { projectTablesExist } from '../utils/projectSchema.js';
import { serviceInvoiceTablesExist } from '../utils/serviceInvoiceSchema.js';
import { chequeTablesExist } from '../utils/chequeSchema.js';
import { reportLibrarySchemaHint, reportSavedViewsTableExists } from '../utils/reportLibrarySchema.js';
import { toCsv, toExcelXml, toSimplePdf } from '../utils/reportExport.js';
import { writeAuditEvent } from '../utils/auditLog.js';

const router = Router();
router.use(authRequired, companyContext);
router.use((req, res, next) => {
  if (String(req.query?.all_companies || '').toLowerCase() === 'true') {
    return res.status(403).json({ error: 'Cross-company aggregation is not allowed on tenant routes' });
  }
  return next();
});

function rnd(x) {
  return Math.round(Number(x) * 100) / 100;
}

function parsePagination(limitRaw, offsetRaw, max = 1000, fallback = 200) {
  const limit = Math.min(max, Math.max(1, parseInt(limitRaw, 10) || fallback));
  const offset = Math.max(0, parseInt(offsetRaw, 10) || 0);
  return { limit, offset };
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

router.get('/budget-variance', async (req, res) => {
  try {
    if (!(await budgetTablesExist())) {
      return res.status(503).json({
        error: 'Budget schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/016_budgets_variance.sql',
      });
    }
    const { budget_id, from, to, threshold_percent } = req.query;
    if (!budget_id || !from || !to) {
      return res.status(400).json({ error: 'budget_id, from, to are required' });
    }
    const b = await query(
      `SELECT id, fiscal_year FROM budgets WHERE id = $1 AND company_id = $2`,
      [budget_id, req.company.id]
    );
    if (!b.rows.length) return res.status(404).json({ error: 'Budget not found' });

    const r = await query(
      `WITH budget_scope AS (
         SELECT bl.account_id,
                SUM(bl.amount)::numeric(18,2) AS budget_amount
         FROM budget_lines bl
         WHERE bl.company_id = $1
           AND bl.budget_id = $2
           AND make_date($3::int, bl.month::int, 1) >= date_trunc('month', $4::date)
           AND make_date($3::int, bl.month::int, 1) <= date_trunc('month', $5::date)
         GROUP BY bl.account_id
       ),
       actual_scope AS (
         SELECT a.id AS account_id,
                CASE a.type
                  WHEN 'REVENUE' THEN COALESCE(SUM(tl.credit - tl.debit), 0)
                  WHEN 'EXPENSE' THEN COALESCE(SUM(tl.debit - tl.credit), 0)
                  ELSE 0
                END::numeric(18,2) AS actual_amount
         FROM accounts a
         LEFT JOIN transaction_lines tl ON tl.account_id = a.id
         LEFT JOIN transactions t ON t.id = tl.transaction_id
           AND t.company_id = $1
           AND t.entry_date >= $4::date
           AND t.entry_date <= $5::date
         WHERE a.company_id = $1
         GROUP BY a.id, a.type
       )
       SELECT a.id AS account_id,
              a.code,
              a.name,
              a.type::text AS account_type,
              COALESCE(bs.budget_amount, 0)::numeric(18,2) AS budget_amount,
              COALESCE(ac.actual_amount, 0)::numeric(18,2) AS actual_amount
       FROM accounts a
       LEFT JOIN budget_scope bs ON bs.account_id = a.id
       LEFT JOIN actual_scope ac ON ac.account_id = a.id
       WHERE a.company_id = $1
         AND (COALESCE(bs.budget_amount, 0) <> 0 OR COALESCE(ac.actual_amount, 0) <> 0)
       ORDER BY a.type, a.code`,
      [req.company.id, budget_id, Number(b.rows[0].fiscal_year), from, to]
    );

    const threshold = threshold_percent !== undefined ? Number(threshold_percent) : null;
    const lines = r.rows.map((x) => {
      const budget = rnd(x.budget_amount);
      const actual = rnd(x.actual_amount);
      const variance_amount = rnd(actual - budget);
      const variance_percent = budget !== 0 ? rnd((variance_amount / budget) * 100) : null;
      return { ...x, budget_amount: budget, actual_amount: actual, variance_amount, variance_percent };
    });
    const alerts =
      threshold === null
        ? []
        : lines.filter((l) => l.variance_percent !== null && Math.abs(Number(l.variance_percent)) >= threshold);

    return res.json({ budget_id, from, to, lines, alerts });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build budget variance report' });
  }
});

router.get('/dimensions-summary', async (req, res) => {
  try {
    if (!(await dimensionsTablesExist())) {
      return res.status(503).json({
        error: 'Dimensions schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/017_dimensions.sql',
      });
    }
    const { from, to, dimension_id, type } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const params = [req.company.id, from, to];
    let filter = '';
    let i = 4;
    if (dimension_id) {
      filter += ` AND d.id = $${i++}`;
      params.push(String(dimension_id));
    }
    if (type) {
      filter += ` AND d.type = $${i++}::dimension_type`;
      params.push(String(type));
    }
    const r = await query(
      `SELECT d.id AS dimension_id,
              d.type::text AS dimension_type,
              d.code AS dimension_code,
              d.name AS dimension_name,
              a.id AS account_id,
              a.code AS account_code,
              a.name AS account_name,
              a.type::text AS account_type,
              SUM(tl.debit)::numeric(18,2) AS debit_total,
              SUM(tl.credit)::numeric(18,2) AS credit_total
       FROM transaction_line_dimensions tld
       JOIN dimensions d ON d.id = tld.dimension_id AND d.company_id = $1
       JOIN transaction_lines tl ON tl.id = tld.transaction_line_id
       JOIN transactions t ON t.id = tl.transaction_id
       JOIN accounts a ON a.id = tl.account_id AND a.company_id = $1
       WHERE tld.company_id = $1
         AND t.company_id = $1
         AND t.entry_date >= $2::date
         AND t.entry_date <= $3::date
         ${filter}
       GROUP BY d.id, d.type, d.code, d.name, a.id, a.code, a.name, a.type
       ORDER BY d.type, d.code NULLS LAST, d.name, a.code`,
      params
    );
    return res.json({ from, to, lines: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build dimensions summary' });
  }
});

router.get('/branch-trial-balance', async (req, res) => {
  try {
    const { as_of, branch_id } = req.query;
    if (!as_of || !branch_id) return res.status(400).json({ error: 'as_of and branch_id are required' });
    const r = await query(
      `SELECT a.id, a.code, a.name, a.type::text AS account_type,
              COALESCE(SUM(tl.debit), 0)::numeric(18,2) AS debit_total,
              COALESCE(SUM(tl.credit), 0)::numeric(18,2) AS credit_total
       FROM accounts a
       LEFT JOIN transaction_lines tl ON tl.account_id = a.id
       LEFT JOIN transactions t ON t.id = tl.transaction_id
         AND t.company_id = $1
         AND t.branch_id = $2
         AND t.entry_date <= $3::date
       WHERE a.company_id = $1
       GROUP BY a.id, a.code, a.name, a.type
       ORDER BY a.code`,
      [req.company.id, branch_id, as_of]
    );
    return res.json({
      as_of,
      branch_id,
      lines: r.rows.map((x) => ({ ...x, debit_total: rnd(x.debit_total), credit_total: rnd(x.credit_total) })),
    });
  } catch (e) {
    if (String(e.code) === '42703' || String(e.code) === '42P01') {
      return res.status(503).json({
        error: 'Branch reporting schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to build branch trial balance' });
  }
});

router.get('/branch-profit-loss', async (req, res) => {
  try {
    const { from, to, branch_id } = req.query;
    if (!from || !to || !branch_id) return res.status(400).json({ error: 'from, to and branch_id are required' });
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
         AND t.branch_id = $2
         AND t.entry_date >= $3::date
         AND t.entry_date <= $4::date
       WHERE a.company_id = $1
         AND a.type IN ('REVENUE', 'EXPENSE')
       GROUP BY a.id, a.type`,
      [req.company.id, branch_id, from, to]
    );
    let revenue = 0;
    let expense = 0;
    for (const row of r.rows) {
      if (row.account_type === 'REVENUE') revenue += Number(row.net || 0);
      if (row.account_type === 'EXPENSE') expense += Number(row.net || 0);
    }
    return res.json({
      from,
      to,
      branch_id,
      revenue_total: rnd(revenue),
      expense_total: rnd(expense),
      net_income: rnd(revenue - expense),
    });
  } catch (e) {
    if (String(e.code) === '42703' || String(e.code) === '42P01') {
      return res.status(503).json({
        error: 'Branch reporting schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to build branch profit/loss' });
  }
});

router.get('/service-center-profitability', async (req, res) => {
  try {
    const { from, to, service_card_id } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const params = [req.company.id, from, to];
    let filter = '';
    if (service_card_id) {
      filter = 'AND t.service_card_id = $4';
      params.push(service_card_id);
    }
    const r = await query(
      `SELECT t.service_card_id,
              sc.code AS service_card_code,
              sc.name AS service_card_name,
              SUM(CASE WHEN a.type = 'REVENUE' THEN (tl.credit - tl.debit) ELSE 0 END)::numeric(18,2) AS revenue_total,
              SUM(CASE WHEN a.type = 'EXPENSE' THEN (tl.debit - tl.credit) ELSE 0 END)::numeric(18,2) AS cost_total
       FROM transactions t
       JOIN transaction_lines tl ON tl.transaction_id = t.id
       JOIN accounts a ON a.id = tl.account_id AND a.company_id = $1
       LEFT JOIN service_cards sc ON sc.id = t.service_card_id AND sc.company_id = $1
       WHERE t.company_id = $1
         AND t.entry_date >= $2::date
         AND t.entry_date <= $3::date
         ${filter}
       GROUP BY t.service_card_id, sc.code, sc.name
       ORDER BY sc.code NULLS LAST, sc.name`,
      params
    );
    return res.json({
      from,
      to,
      lines: r.rows.map((x) => ({
        ...x,
        revenue_total: rnd(x.revenue_total),
        cost_total: rnd(x.cost_total),
        profit_total: rnd(Number(x.revenue_total || 0) - Number(x.cost_total || 0)),
      })),
    });
  } catch (e) {
    if (String(e.code) === '42703' || String(e.code) === '42P01') {
      return res.status(503).json({
        error: 'Service-center schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to build service-center profitability' });
  }
});

router.get('/projects/profitability', async (req, res) => {
  try {
    if (!(await projectTablesExist())) {
      return res.status(503).json({
        error: 'Project schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/030_project_accounting_profitability.sql',
      });
    }
    const { from, to, project_id } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const params = [req.company.id, from, to];
    let filter = '';
    if (project_id) {
      params.push(String(project_id));
      filter = ` AND p.id = $4`;
    }
    const r = await query(
      `SELECT p.id AS project_id,
              p.code AS project_code,
              p.name AS project_name,
              p.status::text AS project_status,
              p.budget_amount,
              COALESCE(SUM(CASE WHEN a.type = 'REVENUE' THEN (tl.credit - tl.debit) ELSE 0 END), 0)::numeric(18,2) AS revenue_total,
              COALESCE(SUM(CASE WHEN a.type = 'EXPENSE' THEN (tl.debit - tl.credit) ELSE 0 END), 0)::numeric(18,2) AS cost_total
       FROM projects p
       LEFT JOIN transactions t
         ON t.project_id = p.id
        AND t.company_id = p.company_id
        AND t.entry_date >= $2::date
        AND t.entry_date <= $3::date
       LEFT JOIN transaction_lines tl ON tl.transaction_id = t.id
       LEFT JOIN accounts a ON a.id = tl.account_id AND a.company_id = p.company_id
       WHERE p.company_id = $1 ${filter}
       GROUP BY p.id, p.code, p.name, p.status, p.budget_amount
       ORDER BY p.code NULLS LAST, p.name`,
      params
    );
    const lines = r.rows.map((x) => {
      const revenue = rnd(x.revenue_total);
      const cost = rnd(x.cost_total);
      const profit = rnd(revenue - cost);
      const margin = revenue !== 0 ? rnd((profit / revenue) * 100) : null;
      const budget = rnd(x.budget_amount || 0);
      const variance = rnd(profit - budget);
      return {
        ...x,
        budget_amount: budget,
        revenue_total: revenue,
        cost_total: cost,
        profit_total: profit,
        margin_percent: margin,
        variance_vs_budget: variance,
      };
    });
    return res.json({ from, to, lines });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build project profitability report' });
  }
});

router.get('/projects/balance', async (req, res) => {
  try {
    if (!(await projectTablesExist())) {
      return res.status(503).json({
        error: 'Project schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/030_project_accounting_profitability.sql',
      });
    }
    const { as_of, project_id } = req.query;
    if (!as_of) return res.status(400).json({ error: 'as_of is required' });
    const params = [req.company.id, as_of];
    let filter = '';
    if (project_id) {
      params.push(String(project_id));
      filter = ` AND p.id = $3`;
    }
    const r = await query(
      `SELECT p.id AS project_id,
              p.code AS project_code,
              p.name AS project_name,
              COALESCE(SUM(CASE WHEN a.type = 'ASSET' THEN (tl.debit - tl.credit) ELSE 0 END), 0)::numeric(18,2) AS assets_balance,
              COALESCE(SUM(CASE WHEN a.type = 'LIABILITY' THEN (tl.credit - tl.debit) ELSE 0 END), 0)::numeric(18,2) AS liabilities_balance
       FROM projects p
       LEFT JOIN transactions t
         ON t.project_id = p.id
        AND t.company_id = p.company_id
        AND t.entry_date <= $2::date
       LEFT JOIN transaction_lines tl ON tl.transaction_id = t.id
       LEFT JOIN accounts a ON a.id = tl.account_id AND a.company_id = p.company_id
       WHERE p.company_id = $1 ${filter}
       GROUP BY p.id, p.code, p.name
       ORDER BY p.code NULLS LAST, p.name`,
      params
    );
    return res.json({
      as_of,
      lines: r.rows.map((x) => ({
        ...x,
        assets_balance: rnd(x.assets_balance),
        liabilities_balance: rnd(x.liabilities_balance),
        net_balance: rnd(Number(x.assets_balance || 0) - Number(x.liabilities_balance || 0)),
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build project balance report' });
  }
});

router.get('/service-returns-impact', async (req, res) => {
  try {
    if (!(await serviceInvoiceTablesExist())) {
      return res.status(503).json({
        error: 'Service invoice schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/032_service_invoice_returns.sql',
      });
    }
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const r = await query(
      `SELECT si.id AS service_invoice_id,
              si.customer_name,
              si.project_id,
              si.total_amount AS invoice_total,
              COALESCE(SUM(sr.return_total), 0)::numeric(18,2) AS return_total
       FROM service_invoices si
       LEFT JOIN service_invoice_returns sr
         ON sr.service_invoice_id = si.id
        AND sr.company_id = si.company_id
        AND sr.return_date >= $2::date
        AND sr.return_date <= $3::date
       WHERE si.company_id = $1
         AND si.invoice_date <= $3::date
       GROUP BY si.id
       ORDER BY si.invoice_date DESC, si.created_at DESC`,
      [req.company.id, from, to]
    );
    const lines = r.rows.map((x) => {
      const inv = rnd(x.invoice_total);
      const ret = rnd(x.return_total);
      const net = rnd(inv - ret);
      const impactPct = inv !== 0 ? rnd((ret / inv) * 100) : 0;
      return { ...x, invoice_total: inv, return_total: ret, net_revenue_after_returns: net, return_impact_percent: impactPct };
    });
    return res.json({ from, to, lines });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build service return impact report' });
  }
});

router.get('/catalog', async (_req, res) => {
  return res.json({
    groups: {
      treasury: ['treasury-movements'],
      cheques: ['cheque-movement-history'],
      cards: ['account-card'],
      projects: ['projects-profitability', 'projects-balance'],
      services: ['service-returns-impact', 'service-return-invoices'],
      branches: ['branch-trial-balance', 'branch-profit-loss', 'branch-code-summary'],
    },
  });
});

router.get('/account-card', async (req, res) => {
  try {
    const { account_id, from, to, variant = 'detailed', limit = '200', offset = '0' } = req.query;
    if (!account_id || !from || !to) {
      return res.status(400).json({ error: 'account_id, from and to are required' });
    }
    const acc = await query(
      `SELECT id, code, name, type::text AS account_type
       FROM accounts
       WHERE id = $1 AND company_id = $2`,
      [account_id, req.company.id]
    );
    if (!acc.rows.length) return res.status(404).json({ error: 'Account not found' });
    const { limit: lim, offset: off } = parsePagination(limit, offset);
    if (variant === 'summary') {
      const s = await query(
        `SELECT COUNT(*)::int AS entries_count,
                COALESCE(SUM(tl.debit),0)::numeric(18,2) AS debit_total,
                COALESCE(SUM(tl.credit),0)::numeric(18,2) AS credit_total
         FROM transaction_lines tl
         JOIN transactions t ON t.id = tl.transaction_id
         WHERE tl.account_id = $1
           AND t.company_id = $2
           AND t.entry_date >= $3::date
           AND t.entry_date <= $4::date`,
        [account_id, req.company.id, from, to]
      );
      const row = s.rows[0];
      return res.json({
        variant,
        account: acc.rows[0],
        from,
        to,
        totals: {
          entries_count: Number(row.entries_count),
          debit_total: rnd(row.debit_total),
          credit_total: rnd(row.credit_total),
          net: rnd(Number(row.debit_total) - Number(row.credit_total)),
        },
      });
    }
    if (variant === 'grouped') {
      const c = await query(
        `SELECT COUNT(*)::int AS total_count
         FROM (
           SELECT t.entry_date
           FROM transaction_lines tl
           JOIN transactions t ON t.id = tl.transaction_id
           WHERE tl.account_id = $1
             AND t.company_id = $2
             AND t.entry_date >= $3::date
             AND t.entry_date <= $4::date
           GROUP BY t.entry_date
         ) x`,
        [account_id, req.company.id, from, to]
      );
      const r = await query(
        `SELECT t.entry_date,
                COALESCE(SUM(tl.debit),0)::numeric(18,2) AS debit_total,
                COALESCE(SUM(tl.credit),0)::numeric(18,2) AS credit_total
         FROM transaction_lines tl
         JOIN transactions t ON t.id = tl.transaction_id
         WHERE tl.account_id = $1
           AND t.company_id = $2
           AND t.entry_date >= $3::date
           AND t.entry_date <= $4::date
         GROUP BY t.entry_date
         ORDER BY t.entry_date DESC
         LIMIT $5 OFFSET $6`,
        [account_id, req.company.id, from, to, lim, off]
      );
      return res.json({
        variant,
        account: acc.rows[0],
        from,
        to,
        pagination: { limit: lim, offset: off, total_count: Number(c.rows[0].total_count) },
        rows: r.rows.map((x) => ({ ...x, debit_total: rnd(x.debit_total), credit_total: rnd(x.credit_total) })),
      });
    }
    const c = await query(
      `SELECT COUNT(*)::int AS total_count
       FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       WHERE tl.account_id = $1
         AND t.company_id = $2
         AND t.entry_date >= $3::date
         AND t.entry_date <= $4::date`,
      [account_id, req.company.id, from, to]
    );
    const r = await query(
      `SELECT t.id AS transaction_id,
              t.entry_date,
              t.description,
              t.reference,
              tl.debit::numeric(18,2) AS debit,
              tl.credit::numeric(18,2) AS credit
       FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       WHERE tl.account_id = $1
         AND t.company_id = $2
         AND t.entry_date >= $3::date
         AND t.entry_date <= $4::date
       ORDER BY t.entry_date DESC, t.created_at DESC, tl.id DESC
       LIMIT $5 OFFSET $6`,
      [account_id, req.company.id, from, to, lim, off]
    );
    return res.json({
      variant: 'detailed',
      account: acc.rows[0],
      from,
      to,
      pagination: { limit: lim, offset: off, total_count: Number(c.rows[0].total_count) },
      rows: r.rows.map((x) => ({ ...x, debit: rnd(x.debit), credit: rnd(x.credit) })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build account card report' });
  }
});

router.get('/treasury-movements', async (req, res) => {
  try {
    const {
      from,
      to,
      account_id = null,
      branch_id = null,
      user_id = null,
      limit = '200',
      offset = '0',
    } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const { limit: lim, offset: off } = parsePagination(limit, offset);
    const params = [req.company.id, from, to];
    let where = `t.company_id = $1 AND t.entry_date >= $2::date AND t.entry_date <= $3::date`;
    let i = 4;
    if (account_id) {
      where += ` AND tl.account_id = $${i++}`;
      params.push(String(account_id));
    }
    if (branch_id) {
      where += ` AND t.branch_id = $${i++}`;
      params.push(String(branch_id));
    }
    if (user_id) {
      where += ` AND t.posted_by = $${i++}`;
      params.push(String(user_id));
    }
    const c = await query(
      `SELECT COUNT(*)::int AS total_count
       FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       JOIN accounts a ON a.id = tl.account_id AND a.company_id = $1
       WHERE ${where}
         AND a.type = 'ASSET'`,
      params
    );
    params.push(lim, off);
    const r = await query(
      `SELECT t.id AS transaction_id,
              t.entry_date,
              t.reference,
              t.description,
              t.branch_id,
              t.posted_by,
              a.id AS account_id,
              a.code AS account_code,
              a.name AS account_name,
              tl.debit::numeric(18,2) AS debit,
              tl.credit::numeric(18,2) AS credit
       FROM transaction_lines tl
       JOIN transactions t ON t.id = tl.transaction_id
       JOIN accounts a ON a.id = tl.account_id AND a.company_id = $1
       WHERE ${where}
         AND a.type = 'ASSET'
       ORDER BY t.entry_date DESC, t.created_at DESC, tl.id DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params
    );
    const totals = r.rows.reduce(
      (acc, x) => {
        acc.debit += Number(x.debit || 0);
        acc.credit += Number(x.credit || 0);
        return acc;
      },
      { debit: 0, credit: 0 }
    );
    return res.json({
      from,
      to,
      pagination: { limit: lim, offset: off, total_count: Number(c.rows[0].total_count) },
      totals: {
        debit_total: rnd(totals.debit),
        credit_total: rnd(totals.credit),
        net: rnd(totals.debit - totals.credit),
      },
      rows: r.rows.map((x) => ({ ...x, debit: rnd(x.debit), credit: rnd(x.credit) })),
    });
  } catch (e) {
    if (String(e.code) === '42703') {
      return res.status(503).json({
        error: 'Treasury report requires workflow columns (posted_by) and branch columns.',
        hint:
          'Run: psql $DATABASE_URL -f database/migrations/023_fiscal_years_sequences_and_voucher_status.sql and database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to build treasury movement report' });
  }
});

router.get('/cheque-movement-history', async (req, res) => {
  try {
    if (!(await chequeTablesExist())) {
      return res.status(503).json({
        error: 'Cheque schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/027_cheque_lifecycle.sql',
      });
    }
    const { status, from, to, limit = '200', offset = '0' } = req.query;
    const { limit: lim, offset: off } = parsePagination(limit, offset);
    const params = [req.company.id];
    let where = `e.company_id = $1`;
    let i = 2;
    if (status) {
      where += ` AND e.to_status = $${i++}::cheque_status`;
      params.push(String(status));
    }
    if (from) {
      where += ` AND e.event_date >= $${i++}::date`;
      params.push(String(from));
    }
    if (to) {
      where += ` AND e.event_date <= $${i++}::date`;
      params.push(String(to));
    }
    const c = await query(`SELECT COUNT(*)::int AS total_count FROM cheque_status_events e WHERE ${where}`, params);
    params.push(lim, off);
    const r = await query(
      `SELECT e.*, c.cheque_number, c.direction::text AS direction, c.amount
       FROM cheque_status_events e
       JOIN cheques c ON c.id = e.cheque_id AND c.company_id = e.company_id
       WHERE ${where}
       ORDER BY e.event_date DESC, e.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      params
    );
    return res.json({
      pagination: { limit: lim, offset: off, total_count: Number(c.rows[0].total_count) },
      rows: r.rows,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build cheque movement history report' });
  }
});

router.get('/branch-code-summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const r = await query(
      `SELECT b.id AS branch_id,
              b.code AS branch_code,
              b.name AS branch_name,
              COUNT(DISTINCT t.id)::int AS transactions_count,
              COALESCE(SUM(tl.debit),0)::numeric(18,2) AS debit_total,
              COALESCE(SUM(tl.credit),0)::numeric(18,2) AS credit_total
       FROM branches b
       LEFT JOIN transactions t
         ON t.company_id = b.company_id
        AND t.branch_id = b.id
        AND t.entry_date >= $2::date
        AND t.entry_date <= $3::date
       LEFT JOIN transaction_lines tl ON tl.transaction_id = t.id
       WHERE b.company_id = $1
       GROUP BY b.id, b.code, b.name
       ORDER BY b.code NULLS LAST, b.name`,
      [req.company.id, from, to]
    );
    return res.json({
      from,
      to,
      rows: r.rows.map((x) => ({
        ...x,
        debit_total: rnd(x.debit_total),
        credit_total: rnd(x.credit_total),
        net: rnd(Number(x.debit_total || 0) - Number(x.credit_total || 0)),
      })),
    });
  } catch (e) {
    if (String(e.code) === '42P01' || String(e.code) === '42703') {
      return res.status(503).json({
        error: 'Branch schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/029_branch_service_card_structure.sql',
      });
    }
    console.error(e);
    return res.status(500).json({ error: 'Failed to build branch code summary report' });
  }
});

router.get('/service-return-invoices', async (req, res) => {
  try {
    if (!(await serviceInvoiceTablesExist())) {
      return res.status(503).json({
        error: 'Service invoice schema not installed.',
        hint: 'Run: psql $DATABASE_URL -f database/migrations/032_service_invoice_returns.sql',
      });
    }
    const { from, to, limit = '200', offset = '0' } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    const { limit: lim, offset: off } = parsePagination(limit, offset);
    const c = await query(
      `SELECT COUNT(*)::int AS total_count
       FROM service_invoice_returns
       WHERE company_id = $1
         AND return_date >= $2::date
         AND return_date <= $3::date`,
      [req.company.id, from, to]
    );
    const r = await query(
      `SELECT sr.*, si.customer_name, si.invoice_number, si.invoice_date, si.total_amount AS original_total
       FROM service_invoice_returns sr
       JOIN service_invoices si ON si.id = sr.service_invoice_id AND si.company_id = sr.company_id
       WHERE sr.company_id = $1
         AND sr.return_date >= $2::date
         AND sr.return_date <= $3::date
       ORDER BY sr.return_date DESC, sr.created_at DESC
       LIMIT $4 OFFSET $5`,
      [req.company.id, from, to, lim, off]
    );
    const totals = r.rows.reduce(
      (acc, x) => {
        acc.return_total += Number(x.return_total || 0);
        return acc;
      },
      { return_total: 0 }
    );
    return res.json({
      from,
      to,
      pagination: { limit: lim, offset: off, total_count: Number(c.rows[0].total_count) },
      totals: { return_total: rnd(totals.return_total) },
      rows: r.rows.map((x) => ({ ...x, return_total: rnd(x.return_total), original_total: rnd(x.original_total) })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build service return invoice report' });
  }
});

router.get('/saved-views', async (req, res) => {
  try {
    if (!(await reportSavedViewsTableExists())) {
      return res.status(503).json({ error: 'Report library schema not installed.', hint: reportLibrarySchemaHint() });
    }
    const { report_key } = req.query;
    if (!report_key) return res.status(400).json({ error: 'report_key is required' });
    const r = await query(
      `SELECT *
       FROM report_saved_views
       WHERE company_id = $1
         AND report_key = $2
       ORDER BY is_default DESC, created_at DESC`,
      [req.company.id, String(report_key)]
    );
    return res.json({ views: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to list saved report views' });
  }
});

router.post('/saved-views', async (req, res) => {
  try {
    if (!(await reportSavedViewsTableExists())) {
      return res.status(503).json({ error: 'Report library schema not installed.', hint: reportLibrarySchemaHint() });
    }
    const { report_key, name, selected_columns = [], filters_json = {}, is_default = false } = req.body || {};
    if (!report_key || !name) return res.status(400).json({ error: 'report_key and name are required' });
    if (is_default) {
      await query(
        `UPDATE report_saved_views
         SET is_default = FALSE, updated_at = NOW()
         WHERE company_id = $1 AND report_key = $2`,
        [req.company.id, String(report_key)]
      );
    }
    const ins = await query(
      `INSERT INTO report_saved_views (
         company_id, report_key, name, selected_columns, filters_json, is_default, created_by
       )
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
       RETURNING *`,
      [
        req.company.id,
        String(report_key),
        String(name),
        JSON.stringify(selected_columns || []),
        JSON.stringify(filters_json || {}),
        Boolean(is_default),
        req.user.id,
      ]
    );
    return res.status(201).json({ view: ins.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to create saved report view' });
  }
});

router.post('/export', async (req, res) => {
  try {
    const {
      format = 'csv',
      filename = 'report',
      title = 'Report',
      columns = [],
      rows = [],
      logo_text = '',
      signature_line = '',
      stamp_text = '',
      footer_metadata = '',
      prepared_by = '',
      approved_by = '',
    } = req.body || {};
    if (!Array.isArray(columns) || !columns.length) {
      return res.status(400).json({ error: 'columns[] is required and must not be empty' });
    }
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'rows[] must be an array' });
    }
    const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (String(format).toLowerCase() === 'csv') {
      const csv = toCsv(columns, rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'report.exported',
        entityType: 'report',
        entityId: null,
        details: { format: 'csv', filename: safeName, title },
      });
      return res.status(200).send(csv);
    }
    if (String(format).toLowerCase() === 'pdf') {
      const pdf = toSimplePdf(title, columns, rows, {
        logoText: logo_text,
        signatureLine: signature_line,
        stampText: stamp_text,
        footerMetadata: footer_metadata,
        preparedBy: prepared_by,
        approvedBy: approved_by,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'report.exported',
        entityType: 'report',
        entityId: null,
        details: { format: 'pdf', filename: safeName, title },
      });
      return res.status(200).send(pdf);
    }
    if (String(format).toLowerCase() === 'excel' || String(format).toLowerCase() === 'xlsx') {
      const xlsx = toExcelXml(columns, rows, title);
      res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xls"`);
      await writeAuditEvent({
        companyId: req.company.id,
        actorUserId: req.user.id,
        eventType: 'report.exported',
        entityType: 'report',
        entityId: null,
        details: { format: 'excel', filename: safeName, title },
      });
      return res.status(200).send(xlsx);
    }
    return res.status(400).json({ error: 'format must be csv, pdf, or excel' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to export report' });
  }
});

router.post('/print-preview', async (req, res) => {
  try {
    const { title = 'Report', columns = [], rows = [], lang = 'ar', watermark = null } = req.body || {};
    if (!Array.isArray(columns) || !columns.length) {
      return res.status(400).json({ error: 'columns[] is required and must not be empty' });
    }
    if (!Array.isArray(rows)) {
      return res.status(400).json({ error: 'rows[] must be an array' });
    }
    const isAr = String(lang).toLowerCase() === 'ar';
    const tableRows = rows
      .map(
        (r, idx) =>
          `<tr class="${idx % 28 === 0 && idx !== 0 ? 'page-break-before' : ''}">${columns
            .map((c) => `<td>${String(r[c.key] ?? '')}</td>`)
            .join('')}</tr>`
      )
      .join('');
    const wm = watermark ? `<div class="watermark">${String(watermark)}</div>` : '';
    const html = `<!doctype html>
<html lang="${isAr ? 'ar' : 'en'}" dir="${isAr ? 'rtl' : 'ltr'}">
<head>
  <meta charset="utf-8" />
  <title>${String(title)}</title>
  <style>
    body{font-family:Arial,sans-serif;padding:20px;position:relative}
    table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #ddd;padding:8px;font-size:12px}
    thead{display:table-header-group}
    .page-break-before{page-break-before:always}
    .watermark{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:80px;color:rgba(120,120,120,0.16);transform:rotate(-22deg);pointer-events:none;z-index:1}
  </style>
</head>
<body>
  ${wm}
  <h2>${String(title)}</h2>
  <table>
    <thead><tr>${columns.map((c) => `<th>${String(c.label || c.key)}</th>`).join('')}</tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;
    return res.json({ html });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to build print preview' });
  }
});

export default router;
