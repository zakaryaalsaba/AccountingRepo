import { Router } from 'express';
import { query } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { companyContext } from '../middleware/companyContext.js';

const router = Router();
router.use(authRequired, companyContext);

function r2(v) {
  return Math.round(Number(v) * 100) / 100;
}

router.get('/health-check', async (req, res) => {
  try {
    const unbalanced = await query(
      `SELECT t.id AS transaction_id,
              t.entry_date,
              COALESCE(SUM(tl.debit),0)::numeric(18,2) AS debit_total,
              COALESCE(SUM(tl.credit),0)::numeric(18,2) AS credit_total
       FROM transactions t
       JOIN transaction_lines tl ON tl.transaction_id = t.id
       WHERE t.company_id = $1
       GROUP BY t.id, t.entry_date
       HAVING ABS(COALESCE(SUM(tl.debit),0) - COALESCE(SUM(tl.credit),0)) > 0.0001`,
      [req.company.id]
    );
    const badInvoices = await query(
      `SELECT id, invoice_date, total_amount, paid_amount
       FROM invoices
       WHERE company_id = $1
         AND (paid_amount < 0 OR total_amount < 0 OR paid_amount > total_amount)`,
      [req.company.id]
    );
    const badBills = await query(
      `SELECT id, bill_date, total_amount, paid_amount
       FROM bills
       WHERE company_id = $1
         AND (paid_amount < 0 OR total_amount < 0 OR paid_amount > total_amount)`,
      [req.company.id]
    );
    const dupInvoices = await query(
      `SELECT customer_name, invoice_date, total_amount, COUNT(*)::int AS cnt
       FROM invoices
       WHERE company_id = $1
       GROUP BY customer_name, invoice_date, total_amount
       HAVING COUNT(*) > 1
       ORDER BY cnt DESC`,
      [req.company.id]
    );
    const dupBills = await query(
      `SELECT vendor_id, bill_date, total_amount, COUNT(*)::int AS cnt
       FROM bills
       WHERE company_id = $1
       GROUP BY vendor_id, bill_date, total_amount
       HAVING COUNT(*) > 1
       ORDER BY cnt DESC`,
      [req.company.id]
    );
    const totals = {
      unbalanced_transactions: unbalanced.rows.length,
      invoice_balance_issues: badInvoices.rows.length,
      bill_balance_issues: badBills.rows.length,
      duplicate_invoice_groups: dupInvoices.rows.length,
      duplicate_bill_groups: dupBills.rows.length,
    };
    return res.json({
      ok: Object.values(totals).every((x) => x === 0),
      totals,
      findings: {
        unbalanced_transactions: unbalanced.rows.map((x) => ({
          ...x,
          debit_total: r2(x.debit_total),
          credit_total: r2(x.credit_total),
        })),
        invoice_balance_issues: badInvoices.rows,
        bill_balance_issues: badBills.rows,
        duplicate_invoice_groups: dupInvoices.rows,
        duplicate_bill_groups: dupBills.rows,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to run consistency health checks' });
  }
});

export default router;

